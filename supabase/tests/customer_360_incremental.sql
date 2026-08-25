begin;

insert into public.empresas_master (
  rutid, razon_social, tamano_empresas, region, comuna, sii_activa_sin_termino_giro,
  tramo_ventas_2024, ultimo_tramo_ventas, trabajadores_2024, resultado_tendencia,
  mejor_fono, mejor_email, crm_contact_name, crm_should_contact, crm_priority_score,
  es_cliente_equifax, es_cliente_wom, n_fuentes, build_at, crm_synced_at
) values (
  '0761234567', 'Empresa Demo SpA', 'mediana', 'Metropolitana', 'Santiago', true,
  8, 8, 25, 'sube', '+56911111111', 'contacto@demo.cl', 'Ana', true, 87,
  true, false, 4, now(), now()
);

insert into public.empresas_ventas_tendencia (
  rut, dv, razon_social_ultima, anio_ultimo, ultimo_tramo_ventas, region_ultima,
  comuna_ultima, tramo_ventas_2024, trabajadores_2024, resultado_tendencia
) values (
  '76123456', '7', 'Empresa Demo SII', 2024, 8, 'Metropolitana',
  'Santiago', 8, 25, 'sube'
);

insert into public.contact_center_feedback (
  external_source, external_event_id, matched_rutid, managed_at, updated_at,
  effective_contact, interested, outcome, channel, campaign_name, agent_name,
  callback_at, contact_phone, contact_email, metadata
) values (
  'atlas2_operation_feedback', 'customer-360-test-event', '0761234567',
  now() - interval '1 minute', now(), true, true, 'interested', 'phone',
  'Campaña Demo', 'Atlas 2.0', now() + interval '1 day', '+56922222222',
  'lead@demo.cl', '{"company_name":"Empresa Demo"}'::jsonb
);

select public.enqueue_intelligence_decision(
  'lead',
  '0761234567',
  'customer-360-test-decision',
  '{"campaign_key":"Campaña Demo","item":{"event_id":"customer-360-test-decision","event_type":"intelligence.decision.v1","external_key":"0761234567","occurred_at":"2026-08-25T12:00:00Z","payload":{"priority_rank":3,"dynamic_priority_score":98,"priority_reason":"Alta intención","recommended_channel":"phone","optimal_window":"AM","decision_version":"v1"}}}'::jsonb,
  'atlas2'
);

do $$
declare
  v_result jsonb;
  v_row public.customer_360_companies%rowtype;
begin
  if not exists (select 1 from public.customer_360_pending where rutid = '0761234567') then
    raise exception 'Los triggers no encolaron el RUT.';
  end if;
  v_result := public.process_customer_360_pending('customer-360-sql-test', 500, 120);
  if not coalesce((v_result->>'ok')::boolean, false) then raise exception 'El micro-batch falló: %', v_result; end if;
  select * into strict v_row from public.customer_360_companies where rutid = '0761234567';
  if v_row.razon_social <> 'Empresa Demo SpA' then raise exception 'Razón social incorrecta.'; end if;
  if v_row.interaction_count <> 1 or v_row.interested_count <> 1 then raise exception 'Agregados incorrectos.'; end if;
  if v_row.last_feedback_event_id <> 'customer-360-test-event' then raise exception 'Último evento incorrecto.'; end if;
  if v_row.decision_priority_rank <> 3 or v_row.dynamic_priority_score <> 98 then raise exception 'Decisión incorrecta.'; end if;
  if not v_row.in_empresas_master or not v_row.in_empresas_comercial_unificada then raise exception 'Cobertura base incorrecta.'; end if;
end;
$$;

update public.contact_center_feedback
set outcome = 'sale', interested = false, sale = true, updated_at = now() + interval '1 second'
where external_source = 'atlas2_operation_feedback'
  and external_event_id = 'customer-360-test-event';

select public.process_customer_360_pending('customer-360-sql-test-2', 500, 120);

do $$
declare
  v_row public.customer_360_companies%rowtype;
begin
  select * into strict v_row from public.customer_360_companies where rutid = '0761234567';
  if v_row.interaction_count <> 1 then raise exception 'El upsert idempotente duplicó interacciones.'; end if;
  if v_row.sale_count <> 1 or v_row.last_outcome <> 'sale' then raise exception 'La actualización incremental no llegó.'; end if;
  if v_row.projection_version < 2 then raise exception 'La versión de proyección no avanzó.'; end if;
end;
$$;

select public.reconcile_customer_360_events(1000);
select public.reconcile_customer_360_base(1000);

set role anon;
do $$
begin
  begin
    perform count(*) from public.customer_360_companies;
    raise exception 'anon pudo leer Customer 360.';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

rollback;
