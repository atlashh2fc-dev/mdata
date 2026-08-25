begin;

do $$
declare
  v_result jsonb;
  v_feedback public.contact_center_feedback%rowtype;
  v_subject text := 'urn:geimser:atlas2:campaign-lead:test:0761234567';
begin
  v_result := public.ingest_integration_feedback_v2(jsonb_build_array(
    jsonb_build_object(
      'event_id', 'integration-v2-new',
      'event_type', 'operation.feedback.v1',
      'event_source', 'urn:geimser:atlas2',
      'subject', v_subject,
      'occurred_at', '2026-08-25T12:02:00Z',
      'data_schema', 'urn:geimser:schema:operation.feedback.v1:2',
      'tenant_id', 'geimser',
      'entity_version', 2,
      'correlation_id', 'call-test',
      'causation_id', null,
      'external_key', '0761234567',
      'record', jsonb_build_object(
        'rutid', '0761234567',
        'matched_rutid', '0761234567',
        'match_method', 'atlas2_external_key',
        'channel', 'phone',
        'managed_at', '2026-08-25T12:02:00Z',
        'outcome', 'sale',
        'campaign_name', 'Test',
        'sale', true,
        'raw_payload', '{}'::jsonb,
        'metadata', '{}'::jsonb
      )
    ),
    jsonb_build_object(
      'event_id', 'integration-v2-stale',
      'event_type', 'operation.feedback.v1',
      'event_source', 'urn:geimser:atlas2',
      'subject', v_subject,
      'occurred_at', '2026-08-25T12:01:00Z',
      'data_schema', 'urn:geimser:schema:operation.feedback.v1:2',
      'tenant_id', 'geimser',
      'entity_version', 1,
      'correlation_id', 'call-test',
      'causation_id', null,
      'external_key', '0761234567',
      'record', jsonb_build_object(
        'rutid', '0761234567',
        'matched_rutid', '0761234567',
        'channel', 'phone',
        'managed_at', '2026-08-25T12:01:00Z',
        'outcome', 'interested'
      )
    )
  ));

  if jsonb_array_length(v_result->'accepted_event_ids') <> 1
    or v_result#>>'{accepted_event_ids,0}' <> 'integration-v2-new' then
    raise exception 'La versión nueva no fue la única aplicada: %', v_result;
  end if;
  if v_result#>>'{ignored,0,event_id}' <> 'integration-v2-stale' then
    raise exception 'El evento stale no fue ignorado: %', v_result;
  end if;

  select * into strict v_feedback
  from public.contact_center_feedback
  where external_source = 'urn:geimser:atlas2'
    and external_event_id = 'integration-v2-new';
  if v_feedback.entity_version <> 2 or v_feedback.outcome <> 'sale' then
    raise exception 'El estado canónico más nuevo no quedó persistido.';
  end if;
  if exists (
    select 1 from public.contact_center_feedback
    where external_event_id = 'integration-v2-stale'
  ) then
    raise exception 'El evento stale alcanzó contact_center_feedback.';
  end if;

  v_result := public.ingest_integration_feedback_v2(jsonb_build_array(jsonb_build_object(
    'event_id', 'integration-v2-new',
    'event_type', 'operation.feedback.v1',
    'event_source', 'urn:geimser:atlas2',
    'subject', v_subject,
    'occurred_at', '2026-08-25T12:02:00Z',
    'data_schema', 'urn:geimser:schema:operation.feedback.v1:2',
    'tenant_id', 'geimser',
    'entity_version', 2,
    'correlation_id', 'call-test',
    'causation_id', null,
    'external_key', '0761234567',
    'record', '{}'::jsonb
  )));
  if v_result#>>'{ignored,0,reason}' <> 'duplicate' then
    raise exception 'El replay idéntico no fue idempotente: %', v_result;
  end if;
end;
$$;

do $$
declare
  v_result jsonb;
begin
  v_result := public.ingest_integration_feedback_v2(jsonb_build_array(jsonb_build_object(
    'event_id', 'integration-canary-inbound',
    'event_type', 'integration.canary.v1',
    'event_source', 'urn:geimser:atlas2',
    'subject', 'urn:geimser:atlas2:canary:test',
    'occurred_at', now(),
    'data_schema', 'urn:geimser:schema:integration.canary.v1:1',
    'tenant_id', 'geimser',
    'entity_version', 1,
    'correlation_id', 'integration-canary-inbound',
    'causation_id', null,
    'record', null
  )));
  if v_result#>>'{accepted_event_ids,0}' <> 'integration-canary-inbound' then
    raise exception 'Canary no reconocido: %', v_result;
  end if;
  if not exists (
    select 1 from public.integration_canary_runs
    where canary_key = 'urn:geimser:atlas2:integration-canary-inbound'
      and status = 'passed'
  ) then
    raise exception 'Canary no quedó registrado.';
  end if;
  if exists (
    select 1 from public.contact_center_feedback
    where external_event_id = 'integration-canary-inbound'
  ) then
    raise exception 'Canary produjo datos comerciales.';
  end if;
end;
$$;

do $$
declare
  v_id uuid;
  v_claimed uuid;
  v_worker text := 'integration-worker-a';
begin
  v_id := public.enqueue_intelligence_decision(
    'lead', '0761234567', 'integration-worker-crash',
    '{"test":"worker-crash"}'::jsonb, 'integration_test'
  );
  select id into v_claimed
  from public.claim_commercial_outbox('integration_test', v_worker, 1, 15)
  where id = v_id;
  if v_claimed is null then raise exception 'Worker A no reclamó el evento.'; end if;

  update public.commercial_outbox set locked_until = now() - interval '1 second' where id = v_id;
  select id into v_claimed
  from public.claim_commercial_outbox('integration_test', 'integration-worker-b', 1, 15)
  where id = v_id;
  if v_claimed is null then raise exception 'Worker B no recuperó el lease vencido.'; end if;

  update public.commercial_outbox set max_attempts = attempts where id = v_id;
  perform public.nack_commercial_outbox(
    array[v_id], 'integration-worker-b', 'destination_down', 503, 0
  );
  if not exists (select 1 from public.commercial_dead_letters where outbox_id = v_id) then
    raise exception 'El retry storm no terminó en DLQ.';
  end if;
  if not public.replay_commercial_dead_letter(v_id) then
    raise exception 'El replay de DLQ falló.';
  end if;
  if (select status from public.commercial_outbox where id = v_id) <> 'queued' then
    raise exception 'El replay no devolvió el evento a queued.';
  end if;
end;
$$;

insert into public.commercial_outbox (
  destination, aggregate_type, aggregate_id, idempotency_key, payload
)
select
  'load_10x', 'lead', 'rut-' || n, 'load-10x-' || n,
  jsonb_build_object('n', n)
from generate_series(1, 2500) n;

do $$
declare
  v_claimed integer;
begin
  select count(*) into v_claimed
  from public.claim_commercial_outbox('load_10x', 'load-worker', 2500, 60);
  if v_claimed <> 250 then
    raise exception 'El hard cap de 250 falló bajo carga 10x: %', v_claimed;
  end if;
end;
$$;

select public.capture_integration_health_snapshot();

set role anon;
do $$
begin
  begin
    perform count(*) from public.integration_entity_versions;
    raise exception 'anon pudo leer ordering interno.';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

rollback;
