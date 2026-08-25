begin;

alter table public.contact_center_feedback
  add column if not exists event_source text,
  add column if not exists tenant_id text,
  add column if not exists event_subject text,
  add column if not exists entity_version bigint,
  add column if not exists correlation_id text,
  add column if not exists causation_id text,
  add column if not exists data_schema text;

alter table public.contact_center_feedback
  add constraint contact_center_feedback_entity_version_positive
  check (entity_version is null or entity_version >= 1) not valid;

alter table public.contact_center_feedback
  validate constraint contact_center_feedback_entity_version_positive;

create index if not exists contact_center_feedback_entity_order_idx
  on public.contact_center_feedback (tenant_id, event_subject, entity_version desc)
  where entity_version is not null;

create table public.integration_entity_versions (
  tenant_id text not null,
  event_subject text not null,
  event_source text not null,
  event_type text not null,
  entity_version bigint not null check (entity_version >= 1),
  event_id text not null,
  correlation_id text not null,
  causation_id text,
  data_schema text not null,
  occurred_at timestamptz not null,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, event_subject),
  unique (event_source, event_id)
);

create table public.integration_health_snapshots (
  id uuid primary key default gen_random_uuid(),
  captured_at timestamptz not null default now(),
  status text not null check (status in ('healthy', 'degraded', 'critical')),
  metrics jsonb not null,
  created_at timestamptz not null default now()
);

create index integration_health_snapshots_captured_idx
  on public.integration_health_snapshots (captured_at desc);

create table public.integration_canary_runs (
  id uuid primary key default gen_random_uuid(),
  canary_key text not null unique,
  status text not null check (status in ('running', 'passed', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  latency_ms integer,
  detail jsonb not null default '{}'::jsonb
);

alter table public.integration_entity_versions enable row level security;
alter table public.integration_health_snapshots enable row level security;
alter table public.integration_canary_runs enable row level security;

revoke all on table public.integration_entity_versions from public, anon, authenticated;
revoke all on table public.integration_health_snapshots from public, anon, authenticated;
revoke all on table public.integration_canary_runs from public, anon, authenticated;
grant select, insert, update, delete on table public.integration_entity_versions to service_role;
grant select, insert, update, delete on table public.integration_health_snapshots to service_role;
grant select, insert, update, delete on table public.integration_canary_runs to service_role;

create or replace function public.ingest_integration_feedback_v2(p_events jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event jsonb;
  v_record public.contact_center_feedback%rowtype;
  v_event_id text;
  v_event_source text;
  v_event_type text;
  v_tenant_id text;
  v_subject text;
  v_data_schema text;
  v_correlation_id text;
  v_causation_id text;
  v_occurred_at timestamptz;
  v_entity_version bigint;
  v_advanced boolean;
  v_current_version bigint;
  v_accepted text[] := '{}';
  v_ignored jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_events) <> 'array' then
    raise exception 'p_events debe ser un arreglo JSON';
  end if;
  if jsonb_array_length(p_events) < 1 or jsonb_array_length(p_events) > 250 then
    raise exception 'p_events debe contener entre 1 y 250 eventos';
  end if;

  for v_event in
    select value
    from jsonb_array_elements(p_events)
    order by (value->>'entity_version')::bigint desc, value->>'event_id'
  loop
    v_event_id := nullif(btrim(v_event->>'event_id'), '');
    v_event_source := nullif(btrim(v_event->>'event_source'), '');
    v_event_type := nullif(btrim(v_event->>'event_type'), '');
    v_tenant_id := coalesce(nullif(btrim(v_event->>'tenant_id'), ''), 'geimser');
    v_subject := nullif(btrim(v_event->>'subject'), '');
    v_data_schema := nullif(btrim(v_event->>'data_schema'), '');
    v_correlation_id := nullif(btrim(v_event->>'correlation_id'), '');
    v_causation_id := nullif(btrim(v_event->>'causation_id'), '');
    v_entity_version := (v_event->>'entity_version')::bigint;
    v_occurred_at := (v_event->>'occurred_at')::timestamptz;

    if v_event_id is null or v_event_source is null or v_event_type is null
      or v_subject is null or v_data_schema is null or v_correlation_id is null
      or v_entity_version < 1 or v_occurred_at is null then
      raise exception 'evento canonico v2 incompleto';
    end if;

    select entity_version into v_current_version
    from public.integration_entity_versions
    where event_source = v_event_source and event_id = v_event_id;
    if found then
      v_ignored := v_ignored || jsonb_build_array(jsonb_build_object(
        'event_id', v_event_id,
        'reason', 'duplicate',
        'entity_version', v_entity_version,
        'current_entity_version', v_current_version
      ));
      continue;
    end if;

    v_advanced := false;
    insert into public.integration_entity_versions as current (
      tenant_id, event_subject, event_source, event_type, entity_version,
      event_id, correlation_id, causation_id, data_schema, occurred_at
    ) values (
      v_tenant_id, v_subject, v_event_source, v_event_type, v_entity_version,
      v_event_id, v_correlation_id, v_causation_id, v_data_schema, v_occurred_at
    )
    on conflict (tenant_id, event_subject) do update set
      event_source = excluded.event_source,
      event_type = excluded.event_type,
      entity_version = excluded.entity_version,
      event_id = excluded.event_id,
      correlation_id = excluded.correlation_id,
      causation_id = excluded.causation_id,
      data_schema = excluded.data_schema,
      occurred_at = excluded.occurred_at,
      updated_at = now()
    where excluded.entity_version > current.entity_version
    returning true into v_advanced;

    if coalesce(v_advanced, false) then
      if v_event_type = 'integration.canary.v1' then
        insert into public.integration_canary_runs (
          canary_key, status, started_at, completed_at, latency_ms, detail
        ) values (
          v_event_source || ':' || v_event_id,
          'passed',
          v_occurred_at,
          now(),
          greatest(0, floor(extract(epoch from (clock_timestamp() - v_occurred_at)) * 1000)::integer),
          jsonb_build_object('direction', 'inbound', 'subject', v_subject)
        )
        on conflict (canary_key) do nothing;
        v_accepted := array_append(v_accepted, v_event_id);
        continue;
      end if;

      select * into v_record
      from jsonb_populate_record(null::public.contact_center_feedback, v_event->'record');

      insert into public.contact_center_feedback as feedback (
        external_source, external_event_id, external_record_type, rutid, matched_rutid,
        match_method, contact_phone, contact_email, channel, managed_at, outcome,
        outcome_subtype, outcome_reason, direction, duration_seconds, talk_seconds,
        wait_seconds, agent_id, agent_name, campaign_id, campaign_name, opened_at,
        clicked_at, callback_at, responded_at, sold_at, value_amount, mail_opened,
        clicked, callback_requested, interested, contacted, effective_contact, sale,
        is_best_management, raw_payload, metadata, event_source, tenant_id,
        event_subject, entity_version, correlation_id, causation_id, data_schema,
        updated_at
      ) values (
        v_event_source, v_event_id, v_event_type, v_record.rutid, v_record.matched_rutid,
        v_record.match_method, v_record.contact_phone, v_record.contact_email,
        v_record.channel, v_record.managed_at, v_record.outcome,
        v_record.outcome_subtype, v_record.outcome_reason, v_record.direction,
        v_record.duration_seconds, v_record.talk_seconds, v_record.wait_seconds,
        v_record.agent_id, v_record.agent_name, v_record.campaign_id,
        v_record.campaign_name, v_record.opened_at, v_record.clicked_at,
        v_record.callback_at, v_record.responded_at, v_record.sold_at,
        v_record.value_amount, coalesce(v_record.mail_opened, false),
        coalesce(v_record.clicked, false), coalesce(v_record.callback_requested, false),
        coalesce(v_record.interested, false), coalesce(v_record.contacted, false),
        coalesce(v_record.effective_contact, false), coalesce(v_record.sale, false),
        coalesce(v_record.is_best_management, false), coalesce(v_record.raw_payload, '{}'::jsonb),
        coalesce(v_record.metadata, '{}'::jsonb), v_event_source, v_tenant_id,
        v_subject, v_entity_version, v_correlation_id, v_causation_id,
        v_data_schema, now()
      )
      on conflict (external_source, external_event_id) do update set
        external_record_type = excluded.external_record_type,
        rutid = excluded.rutid,
        matched_rutid = excluded.matched_rutid,
        match_method = excluded.match_method,
        managed_at = excluded.managed_at,
        outcome = excluded.outcome,
        outcome_subtype = excluded.outcome_subtype,
        outcome_reason = excluded.outcome_reason,
        duration_seconds = excluded.duration_seconds,
        campaign_name = excluded.campaign_name,
        callback_at = excluded.callback_at,
        callback_requested = excluded.callback_requested,
        interested = excluded.interested,
        contacted = excluded.contacted,
        effective_contact = excluded.effective_contact,
        sale = excluded.sale,
        raw_payload = excluded.raw_payload,
        metadata = excluded.metadata,
        event_subject = excluded.event_subject,
        entity_version = excluded.entity_version,
        correlation_id = excluded.correlation_id,
        causation_id = excluded.causation_id,
        data_schema = excluded.data_schema,
        updated_at = now()
      where excluded.entity_version >= coalesce(feedback.entity_version, 0);

      v_accepted := array_append(v_accepted, v_event_id);
    else
      select entity_version into v_current_version
      from public.integration_entity_versions
      where tenant_id = v_tenant_id and event_subject = v_subject;
      v_ignored := v_ignored || jsonb_build_array(jsonb_build_object(
        'event_id', v_event_id,
        'reason', 'stale_or_duplicate',
        'entity_version', v_entity_version,
        'current_entity_version', v_current_version
      ));
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'accepted_event_ids', to_jsonb(v_accepted),
    'ignored', v_ignored
  );
end;
$$;

create or replace function public.replay_commercial_dead_letter(p_outbox_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replayed boolean := false;
begin
  update public.commercial_outbox
  set status = 'queued', attempts = 0, available_at = now(), locked_at = null,
      locked_until = null, locked_by = null, last_error = null,
      last_http_status = null, updated_at = now()
  where id = p_outbox_id and status = 'dead';
  v_replayed := found;
  if v_replayed then
    delete from public.commercial_dead_letters where outbox_id = p_outbox_id;
  end if;
  return v_replayed;
end;
$$;

create or replace function public.capture_integration_health_snapshot()
returns public.integration_health_snapshots
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.integration_health_snapshots%rowtype;
  v_metrics jsonb;
  v_status text;
  v_outbox_backlog bigint;
  v_outbox_oldest numeric;
  v_customer_backlog bigint;
  v_customer_oldest numeric;
  v_dead bigint;
  v_connections integer;
  v_max_connections integer;
begin
  delete from public.integration_health_snapshots
  where captured_at < now() - interval '30 days';
  delete from public.integration_canary_runs
  where started_at < now() - interval '90 days';
  delete from public.commercial_outbox
  where destination = 'synthetic_canary'
    and status = 'delivered'
    and delivered_at < now() - interval '90 days';

  select count(*), extract(epoch from now() - min(created_at))
  into v_outbox_backlog, v_outbox_oldest
  from public.commercial_outbox
  where status in ('queued', 'retry', 'processing');

  select count(*), extract(epoch from now() - min(first_seen_at))
  into v_customer_backlog, v_customer_oldest
  from public.customer_360_pending;

  select count(*) into v_dead from public.commercial_dead_letters;
  select count(*)::integer into v_connections
  from pg_catalog.pg_stat_activity where datname = current_database();
  v_max_connections := current_setting('max_connections')::integer;

  v_metrics := jsonb_build_object(
    'outbox_backlog', v_outbox_backlog,
    'outbox_oldest_seconds', v_outbox_oldest,
    'customer360_backlog', v_customer_backlog,
    'customer360_oldest_seconds', v_customer_oldest,
    'dead_letters', v_dead,
    'connections', v_connections,
    'max_connections', v_max_connections,
    'connection_utilization', round(v_connections::numeric / greatest(v_max_connections, 1), 4),
    'slo', jsonb_build_object(
      'outbox_max_age_seconds', 600,
      'customer360_max_age_seconds', 1200,
      'connection_utilization_max', 0.8
    )
  );

  v_status := case
    when coalesce(v_outbox_oldest, 0) > 1800
      or coalesce(v_customer_oldest, 0) > 3600
      or v_connections::numeric / greatest(v_max_connections, 1) > 0.9 then 'critical'
    when coalesce(v_outbox_oldest, 0) > 600
      or coalesce(v_customer_oldest, 0) > 1200
      or v_connections::numeric / greatest(v_max_connections, 1) > 0.8 then 'degraded'
    else 'healthy'
  end;

  insert into public.integration_health_snapshots (status, metrics)
  values (v_status, v_metrics)
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.run_integration_synthetic_canary(p_canary_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id uuid;
  v_outbox_id uuid;
  v_claimed_id uuid;
  v_started timestamptz := clock_timestamp();
  v_worker text := 'synthetic-canary:' || left(coalesce(p_canary_key, ''), 100);
begin
  if nullif(btrim(coalesce(p_canary_key, '')), '') is null then
    raise exception 'canary_key es obligatorio';
  end if;

  insert into public.integration_canary_runs (canary_key, status)
  values (p_canary_key, 'running')
  on conflict (canary_key) do update set canary_key = excluded.canary_key
  returning id into v_run_id;

  v_outbox_id := public.enqueue_intelligence_decision(
    'canary', p_canary_key, 'canary:' || p_canary_key,
    jsonb_build_object('canary', true, 'key', p_canary_key), 'synthetic_canary'
  );

  select id into v_claimed_id
  from public.claim_commercial_outbox('synthetic_canary', v_worker, 1, 60)
  where id = v_outbox_id;

  if v_claimed_id is null then
    update public.integration_canary_runs
    set status = 'failed', completed_at = now(), detail = '{"reason":"claim_failed"}'::jsonb
    where id = v_run_id;
    return jsonb_build_object('ok', false, 'reason', 'claim_failed');
  end if;

  perform public.ack_commercial_outbox(array[v_claimed_id], v_worker, '{"synthetic":true}'::jsonb);
  update public.integration_canary_runs
  set status = 'passed', completed_at = now(),
      latency_ms = greatest(0, floor(extract(epoch from (clock_timestamp() - v_started)) * 1000)::integer),
      detail = jsonb_build_object('outbox_id', v_outbox_id)
  where id = v_run_id;

  return jsonb_build_object('ok', true, 'outbox_id', v_outbox_id);
exception when others then
  if v_run_id is not null then
    update public.integration_canary_runs
    set status = 'failed', completed_at = now(), detail = jsonb_build_object('error', left(sqlerrm, 1000))
    where id = v_run_id;
  end if;
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;

revoke all on function public.ingest_integration_feedback_v2(jsonb) from public, anon, authenticated;
revoke all on function public.replay_commercial_dead_letter(uuid) from public, anon, authenticated;
revoke all on function public.capture_integration_health_snapshot() from public, anon, authenticated;
revoke all on function public.run_integration_synthetic_canary(text) from public, anon, authenticated;
grant execute on function public.ingest_integration_feedback_v2(jsonb) to service_role;
grant execute on function public.replay_commercial_dead_letter(uuid) to service_role;
grant execute on function public.capture_integration_health_snapshot() to service_role;
grant execute on function public.run_integration_synthetic_canary(text) to service_role;

commit;
