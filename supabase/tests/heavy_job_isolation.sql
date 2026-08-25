begin;

do $$
declare
  v_claim jsonb;
  v_run_id uuid;
  v_anon_execute boolean;
  v_authenticated_execute boolean;
  v_service_execute boolean;
  v_stats record;
  v_cache record;
begin
  if to_regnamespace('mdata_ops') is null then
    raise exception 'Falta esquema privado mdata_ops.';
  end if;

  select has_function_privilege('anon', p.oid, 'execute'),
         has_function_privilege('authenticated', p.oid, 'execute'),
         has_function_privilege('service_role', p.oid, 'execute')
  into v_anon_execute, v_authenticated_execute, v_service_execute
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'get_bbrr_dashboard_usage_stats';

  if v_anon_execute or v_authenticated_execute or not v_service_execute then
    raise exception 'ACL inválida en get_bbrr_dashboard_usage_stats.';
  end if;

  if exists (
    select 1
    from cron.job
    where jobname in ('refresh-empresas-master-crm', 'refresh-base-contact-matview')
  ) then
    raise exception 'Persisten cron DB duplicados de Base Contact.';
  end if;

  select * into v_stats from public.get_bbrr_dashboard_usage_stats();
  select * into v_cache
  from mdata_ops.bbrr_dashboard_usage_cache
  where singleton;

  if to_jsonb(v_stats) is distinct from (to_jsonb(v_cache) - 'singleton' - 'refreshed_at') then
    raise exception 'El RPC BBRR no coincide con el cache privado.';
  end if;

  v_claim := mdata_ops.claim_heavy_job('base_contact_pipeline', true);
  if not coalesce((v_claim ->> 'acquired')::boolean, false) then
    raise exception 'No se pudo adquirir guard en prueba: %', v_claim;
  end if;

  v_run_id := (v_claim ->> 'run_id')::uuid;
  perform mdata_ops.finish_heavy_job(v_run_id, 'succeeded', '{"test":true}'::jsonb, null);

  if not exists (
    select 1
    from mdata_ops.heavy_job_runs
    where id = v_run_id
      and status = 'succeeded'
      and elapsed_ms >= 0
  ) then
    raise exception 'No se cerró telemetría del guard.';
  end if;
end;
$$;

rollback;
