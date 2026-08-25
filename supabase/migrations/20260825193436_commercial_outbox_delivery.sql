begin;

create table public.commercial_delivery_circuits (
  destination text primary key,
  state text not null default 'closed'
    check (state in ('closed', 'open', 'half_open')),
  failure_count integer not null default 0 check (failure_count >= 0),
  failure_threshold integer not null default 5 check (failure_threshold between 1 and 100),
  cooldown_seconds integer not null default 300 check (cooldown_seconds between 10 and 86400),
  opened_until timestamptz,
  last_failure_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create table public.commercial_outbox (
  id uuid primary key default gen_random_uuid(),
  destination text not null default 'atlas2',
  event_name text not null default 'intelligence.decision.v1'
    check (event_name = 'intelligence.decision.v1'),
  aggregate_type text not null,
  aggregate_id text not null,
  idempotency_key text not null,
  payload jsonb not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'retry', 'delivered', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 8 check (max_attempts between 1 and 50),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_until timestamptz,
  locked_by text,
  last_error text,
  last_http_status integer,
  delivered_at timestamptz,
  ack_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commercial_outbox_idempotency_unique unique (destination, idempotency_key),
  constraint commercial_outbox_payload_max_1mib
    check (octet_length(payload::text) <= 1048576)
);

create index commercial_outbox_claim_idx
  on public.commercial_outbox (destination, status, available_at, created_at, id)
  where status in ('queued', 'retry', 'processing');

create index commercial_outbox_stale_lock_idx
  on public.commercial_outbox (locked_until)
  where status = 'processing';

create table public.commercial_dead_letters (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null unique references public.commercial_outbox(id) on delete restrict,
  destination text not null,
  event_name text not null,
  idempotency_key text not null,
  payload jsonb not null,
  attempts integer not null,
  error_message text not null,
  http_status integer,
  failed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

alter table public.commercial_delivery_circuits enable row level security;
alter table public.commercial_outbox enable row level security;
alter table public.commercial_dead_letters enable row level security;

revoke all on public.commercial_delivery_circuits from public, anon, authenticated;
revoke all on public.commercial_outbox from public, anon, authenticated;
revoke all on public.commercial_dead_letters from public, anon, authenticated;

grant select, insert, update, delete on public.commercial_delivery_circuits to service_role;
grant select, insert, update, delete on public.commercial_outbox to service_role;
grant select, insert, update, delete on public.commercial_dead_letters to service_role;

create or replace function public.enqueue_intelligence_decision(
  p_aggregate_type text,
  p_aggregate_id text,
  p_idempotency_key text,
  p_payload jsonb,
  p_destination text default 'atlas2'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if coalesce(nullif(btrim(p_aggregate_type), ''), null) is null
    or coalesce(nullif(btrim(p_aggregate_id), ''), null) is null
    or coalesce(nullif(btrim(p_idempotency_key), ''), null) is null then
    raise exception 'aggregate_type, aggregate_id e idempotency_key son obligatorios';
  end if;

  if p_payload is null or octet_length(p_payload::text) > 1048576 then
    raise exception 'payload intelligence.decision.v1 invalido o mayor a 1 MiB';
  end if;

  insert into public.commercial_outbox (
    destination,
    event_name,
    aggregate_type,
    aggregate_id,
    idempotency_key,
    payload
  )
  values (
    lower(btrim(coalesce(p_destination, 'atlas2'))),
    'intelligence.decision.v1',
    btrim(p_aggregate_type),
    btrim(p_aggregate_id),
    btrim(p_idempotency_key),
    p_payload
  )
  on conflict (destination, idempotency_key) do update
  set idempotency_key = excluded.idempotency_key
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.claim_commercial_outbox(
  p_destination text,
  p_worker text,
  p_limit integer default 250,
  p_lease_seconds integer default 120
)
returns setof public.commercial_outbox
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_destination text := lower(btrim(coalesce(p_destination, 'atlas2')));
  v_state text;
  v_limit integer := least(greatest(coalesce(p_limit, 250), 1), 250);
  v_recovered integer := 0;
begin
  if nullif(btrim(coalesce(p_worker, '')), '') is null then
    raise exception 'worker es obligatorio';
  end if;

  insert into public.commercial_delivery_circuits (destination)
  values (v_destination)
  on conflict (destination) do nothing;

  with exhausted as (
    update public.commercial_outbox o
    set status = 'dead',
        locked_at = null,
        locked_until = null,
        locked_by = null,
        last_error = coalesce(o.last_error, 'lease_expired_after_max_attempts'),
        updated_at = now()
    where o.destination = v_destination
      and o.status = 'processing'
      and o.locked_until <= now()
      and o.attempts >= o.max_attempts
    returning o.*
  ), dead_insert as (
    insert into public.commercial_dead_letters (
      outbox_id, destination, event_name, idempotency_key, payload,
      attempts, error_message, http_status
    )
    select
      e.id, e.destination, e.event_name, e.idempotency_key, e.payload,
      e.attempts, coalesce(e.last_error, 'lease_expired_after_max_attempts'), e.last_http_status
    from exhausted e
    on conflict (outbox_id) do nothing
    returning 1
  )
  select count(*)::integer into v_recovered from dead_insert;

  select state into v_state
  from public.commercial_delivery_circuits
  where destination = v_destination
  for update;

  if v_state = 'open' then
    update public.commercial_delivery_circuits
    set state = case when opened_until <= now() then 'half_open' else state end,
        updated_at = now()
    where destination = v_destination
    returning state into v_state;
  end if;

  if v_state = 'open' then
    return;
  end if;

  if v_state = 'half_open' then
    v_limit := 1;
  end if;

  return query
  with picked as (
    select o.id
    from public.commercial_outbox o
    where o.destination = v_destination
      and o.attempts < o.max_attempts
      and (
        (o.status in ('queued', 'retry') and o.available_at <= now())
        or (o.status = 'processing' and o.locked_until <= now())
      )
    order by o.available_at, o.created_at, o.id
    limit v_limit
    for update skip locked
  )
  update public.commercial_outbox o
  set status = 'processing',
      attempts = o.attempts + 1,
      locked_at = now(),
      locked_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 15), 900)),
      locked_by = p_worker,
      last_error = null,
      updated_at = now()
  from picked
  where o.id = picked.id
  returning o.*;
end;
$$;

create or replace function public.ack_commercial_outbox(
  p_ids uuid[],
  p_worker text,
  p_ack_payload jsonb default '{}'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_destination text;
begin
  select max(o.destination)
  into v_destination
  from public.commercial_outbox o
  where o.id = any(coalesce(p_ids, '{}'::uuid[]))
    and o.status = 'processing'
    and o.locked_by = p_worker;

  update public.commercial_outbox o
  set status = 'delivered',
      delivered_at = now(),
      ack_payload = coalesce(p_ack_payload, '{}'::jsonb),
      locked_at = null,
      locked_until = null,
      locked_by = null,
      last_error = null,
      updated_at = now()
  where o.id = any(coalesce(p_ids, '{}'::uuid[]))
    and o.status = 'processing'
    and o.locked_by = p_worker;

  get diagnostics v_count = row_count;

  if v_count > 0 and v_destination is not null then
    update public.commercial_delivery_circuits
    set state = 'closed',
        failure_count = 0,
        opened_until = null,
        last_success_at = now(),
        last_error = null,
        updated_at = now()
    where destination = v_destination;
  end if;

  return v_count;
end;
$$;

create or replace function public.record_unmapped_intelligence_decision(
  p_aggregate_id text,
  p_idempotency_key text,
  p_payload jsonb,
  p_error text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.commercial_outbox (
    destination, event_name, aggregate_type, aggregate_id, idempotency_key,
    payload, status, attempts, last_error, updated_at
  )
  values (
    'atlas2', 'intelligence.decision.v1', 'lead_unmapped',
    btrim(p_aggregate_id), btrim(p_idempotency_key), p_payload,
    'dead', 0, left(coalesce(p_error, 'unmapped'), 2000), now()
  )
  on conflict (destination, idempotency_key) do update
  set idempotency_key = excluded.idempotency_key
  returning id into v_id;

  insert into public.commercial_dead_letters (
    outbox_id, destination, event_name, idempotency_key, payload,
    attempts, error_message, metadata
  )
  values (
    v_id, 'atlas2', 'intelligence.decision.v1', btrim(p_idempotency_key),
    p_payload, 0, left(coalesce(p_error, 'unmapped'), 2000),
    jsonb_build_object('classification', 'unmapped')
  )
  on conflict (outbox_id) do nothing;

  return v_id;
end;
$$;

create or replace function public.nack_commercial_outbox(
  p_ids uuid[],
  p_worker text,
  p_error text,
  p_http_status integer default null,
  p_retry_after_seconds integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_retry integer := 0;
  v_dead integer := 0;
  v_destination text;
begin
  with updated as (
    update public.commercial_outbox o
    set status = case when o.attempts >= o.max_attempts then 'dead' else 'retry' end,
        available_at = case
          when o.attempts >= o.max_attempts then o.available_at
          else now() + make_interval(secs => greatest(
            coalesce(p_retry_after_seconds, 0),
            least(3600, (power(2, least(o.attempts, 10)) * 5)::integer + floor(random() * 5)::integer)
          ))
        end,
        locked_at = null,
        locked_until = null,
        locked_by = null,
        last_error = left(coalesce(p_error, 'delivery_failed'), 2000),
        last_http_status = p_http_status,
        updated_at = now()
    where o.id = any(coalesce(p_ids, '{}'::uuid[]))
      and o.status = 'processing'
      and o.locked_by = p_worker
    returning o.*
  ), dead_insert as (
    insert into public.commercial_dead_letters (
      outbox_id, destination, event_name, idempotency_key, payload,
      attempts, error_message, http_status
    )
    select
      u.id, u.destination, u.event_name, u.idempotency_key, u.payload,
      u.attempts, coalesce(u.last_error, 'delivery_failed'), u.last_http_status
    from updated u
    where u.status = 'dead'
    on conflict (outbox_id) do nothing
    returning 1
  )
  select
    count(*) filter (where u.status = 'retry')::integer,
    count(*) filter (where u.status = 'dead')::integer,
    max(u.destination)
  into v_retry, v_dead, v_destination
  from updated u;

  if v_destination is not null then
    update public.commercial_delivery_circuits c
    set failure_count = c.failure_count + 1,
        state = case when c.failure_count + 1 >= c.failure_threshold then 'open' else c.state end,
        opened_until = case
          when c.failure_count + 1 >= c.failure_threshold
          then now() + make_interval(secs => c.cooldown_seconds)
          else c.opened_until
        end,
        last_failure_at = now(),
        last_error = left(coalesce(p_error, 'delivery_failed'), 2000),
        updated_at = now()
    where c.destination = v_destination;
  end if;

  return jsonb_build_object('retry', coalesce(v_retry, 0), 'dead', coalesce(v_dead, 0));
end;
$$;

create or replace function public.dead_letter_commercial_outbox(
  p_ids uuid[],
  p_worker text,
  p_error text,
  p_http_status integer default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  with updated as (
    update public.commercial_outbox o
    set status = 'dead',
        locked_at = null,
        locked_until = null,
        locked_by = null,
        last_error = left(coalesce(p_error, 'permanent_delivery_failure'), 2000),
        last_http_status = p_http_status,
        updated_at = now()
    where o.id = any(coalesce(p_ids, '{}'::uuid[]))
      and o.status = 'processing'
      and o.locked_by = p_worker
    returning o.*
  )
  insert into public.commercial_dead_letters (
    outbox_id, destination, event_name, idempotency_key, payload,
    attempts, error_message, http_status
  )
  select
    u.id, u.destination, u.event_name, u.idempotency_key, u.payload,
    u.attempts, coalesce(u.last_error, 'permanent_delivery_failure'), u.last_http_status
  from updated u
  on conflict (outbox_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.enqueue_intelligence_decision(text, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.record_unmapped_intelligence_decision(text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.claim_commercial_outbox(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.ack_commercial_outbox(uuid[], text, jsonb) from public, anon, authenticated;
revoke all on function public.nack_commercial_outbox(uuid[], text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.dead_letter_commercial_outbox(uuid[], text, text, integer) from public, anon, authenticated;

grant execute on function public.enqueue_intelligence_decision(text, text, text, jsonb, text) to service_role;
grant execute on function public.record_unmapped_intelligence_decision(text, text, jsonb, text) to service_role;
grant execute on function public.claim_commercial_outbox(text, text, integer, integer) to service_role;
grant execute on function public.ack_commercial_outbox(uuid[], text, jsonb) to service_role;
grant execute on function public.nack_commercial_outbox(uuid[], text, text, integer, integer) to service_role;
grant execute on function public.dead_letter_commercial_outbox(uuid[], text, text, integer) to service_role;

commit;
