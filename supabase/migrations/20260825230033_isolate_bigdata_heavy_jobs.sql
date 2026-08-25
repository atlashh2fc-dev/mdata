-- Aislamiento operacional para cargas pesadas propias de Bigdata.
--
-- La base también sirve a Forum, por lo que este cambio no altera objetos de
-- Forum ni parámetros globales. Los límites son locales a cada sesión de job.

create schema if not exists mdata_ops;
revoke all on schema mdata_ops from public, anon, authenticated;

create table if not exists mdata_ops.heavy_job_control (
  job_name text primary key,
  enabled boolean not null default true,
  kill_switch boolean not null default false,
  allowed_start time not null default time '20:00',
  allowed_end time not null default time '07:00',
  timezone_name text not null default 'America/Santiago',
  statement_timeout_ms integer not null default 540000
    check (statement_timeout_ms between 1000 and 600000),
  lock_timeout_ms integer not null default 5000
    check (lock_timeout_ms between 100 and 30000),
  updated_at timestamptz not null default now(),
  updated_by text
);

create table if not exists mdata_ops.heavy_job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null references mdata_ops.heavy_job_control(job_name),
  status text not null check (status in ('running', 'succeeded', 'failed', 'skipped')),
  reason text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  elapsed_ms bigint,
  backend_pid integer not null default pg_backend_pid(),
  application_name text,
  result jsonb,
  error_message text
);

create index if not exists heavy_job_runs_job_started_idx
  on mdata_ops.heavy_job_runs (job_name, started_at desc);

create index if not exists heavy_job_runs_running_idx
  on mdata_ops.heavy_job_runs (started_at)
  where status = 'running';

insert into mdata_ops.heavy_job_control (
  job_name,
  allowed_start,
  allowed_end,
  statement_timeout_ms,
  lock_timeout_ms
)
values
  -- La ruta Vercel vive 300s. Cada sentencia del pipeline queda bajo 135s
  -- para reservar margen de cierre de telemetría y liberación del lock.
  ('base_contact_pipeline', time '20:00', time '07:00', 135000, 5000),
  ('equifax_bdd_rebuild', time '20:00', time '07:00', 540000, 5000),
  ('bbrr_rollup', time '20:00', time '07:00', 540000, 5000)
on conflict (job_name) do nothing;

create or replace function mdata_ops.claim_heavy_job(
  p_job_name text,
  p_force_outside_window boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, mdata_ops
as $$
declare
  v_control mdata_ops.heavy_job_control%rowtype;
  v_run_id uuid;
  v_local_time time;
  v_in_window boolean;
  v_acquired boolean := false;
begin
  select *
  into v_control
  from mdata_ops.heavy_job_control
  where job_name = p_job_name;

  if not found then
    raise exception 'Heavy job no registrado: %', p_job_name;
  end if;

  -- Una sesión caída libera el advisory lock, pero puede dejar telemetría en
  -- running. La siguiente invocación la reconcilia sin bloquear el job.
  update mdata_ops.heavy_job_runs
  set status = 'failed',
      reason = 'abandoned_session',
      completed_at = now(),
      elapsed_ms = greatest(0, (extract(epoch from (now() - started_at)) * 1000)::bigint),
      error_message = coalesce(error_message, 'La sesión terminó sin cierre de telemetría.')
  where job_name = p_job_name
    and status = 'running'
    and started_at < now() - interval '15 minutes'
    and not exists (
      select 1
      from pg_stat_activity a
      where a.pid = mdata_ops.heavy_job_runs.backend_pid
    );

  if not v_control.enabled or v_control.kill_switch then
    insert into mdata_ops.heavy_job_runs (job_name, status, reason, completed_at, elapsed_ms)
    values (
      p_job_name,
      'skipped',
      case when v_control.kill_switch then 'kill_switch' else 'disabled' end,
      now(),
      0
    )
    returning id into v_run_id;

    return jsonb_build_object(
      'acquired', false,
      'run_id', v_run_id,
      'reason', case when v_control.kill_switch then 'kill_switch' else 'disabled' end
    );
  end if;

  v_local_time := (now() at time zone v_control.timezone_name)::time;
  v_in_window := case
    when v_control.allowed_start < v_control.allowed_end
      then v_local_time >= v_control.allowed_start and v_local_time < v_control.allowed_end
    else v_local_time >= v_control.allowed_start or v_local_time < v_control.allowed_end
  end;

  if not v_in_window and not p_force_outside_window then
    insert into mdata_ops.heavy_job_runs (job_name, status, reason, completed_at, elapsed_ms)
    values (p_job_name, 'skipped', 'outside_allowed_window', now(), 0)
    returning id into v_run_id;

    return jsonb_build_object(
      'acquired', false,
      'run_id', v_run_id,
      'reason', 'outside_allowed_window',
      'timezone', v_control.timezone_name,
      'local_time', v_local_time,
      'allowed_start', v_control.allowed_start,
      'allowed_end', v_control.allowed_end
    );
  end if;

  v_acquired := pg_try_advisory_lock(hashtextextended('mdata:heavy-jobs', 0));
  if not v_acquired then
    insert into mdata_ops.heavy_job_runs (job_name, status, reason, completed_at, elapsed_ms)
    values (p_job_name, 'skipped', 'concurrency_lock_busy', now(), 0)
    returning id into v_run_id;

    return jsonb_build_object(
      'acquired', false,
      'run_id', v_run_id,
      'reason', 'concurrency_lock_busy'
    );
  end if;

  insert into mdata_ops.heavy_job_runs (
    job_name,
    status,
    application_name
  )
  values (
    p_job_name,
    'running',
    current_setting('application_name', true)
  )
  returning id into v_run_id;

  return jsonb_build_object(
    'acquired', true,
    'run_id', v_run_id,
    'statement_timeout_ms', v_control.statement_timeout_ms,
    'lock_timeout_ms', v_control.lock_timeout_ms,
    'timezone', v_control.timezone_name,
    'local_time', v_local_time
  );
exception
  when others then
    if v_acquired then
      perform pg_advisory_unlock(hashtextextended('mdata:heavy-jobs', 0));
    end if;
    raise;
end;
$$;

create or replace function mdata_ops.finish_heavy_job(
  p_run_id uuid,
  p_status text,
  p_result jsonb default null,
  p_error_message text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, mdata_ops
as $$
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'Estado final inválido: %', p_status;
  end if;

  update mdata_ops.heavy_job_runs
  set status = p_status,
      completed_at = now(),
      elapsed_ms = greatest(0, (extract(epoch from (now() - started_at)) * 1000)::bigint),
      result = p_result,
      error_message = left(p_error_message, 4000)
  where id = p_run_id
    and status = 'running';

  perform pg_advisory_unlock(hashtextextended('mdata:heavy-jobs', 0));
end;
$$;

create or replace function mdata_ops.is_heavy_job_stop_requested(p_job_name text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, mdata_ops
as $$
  select coalesce((
    select not enabled or kill_switch
    from mdata_ops.heavy_job_control
    where job_name = p_job_name
  ), true);
$$;

revoke all on all tables in schema mdata_ops from public, anon, authenticated;
revoke all on all functions in schema mdata_ops from public, anon, authenticated;

-- Cache de una fila para evitar recorrer ~5 millones de filas en cada carga
-- del dashboard. El seed que sigue hace un único scan pesado durante la
-- migración; debe aplicarse dentro de la ventana nocturna. Después se actualiza
-- solamente al finalizar el rollup BBRR.
create table if not exists mdata_ops.bbrr_dashboard_usage_cache (
  singleton boolean primary key default true check (singleton),
  bbrr_ruts_residencial bigint not null default 0,
  bbrr_ruts_comercial bigint not null default 0,
  bbrr_ruts_mixto bigint not null default 0,
  bbrr_ruts_rural bigint not null default 0,
  bbrr_ruts_especial bigint not null default 0,
  bbrr_propiedades_residenciales bigint not null default 0,
  bbrr_propiedades_comerciales bigint not null default 0,
  bbrr_propiedades_rurales bigint not null default 0,
  bbrr_propiedades_especiales bigint not null default 0,
  refreshed_at timestamptz not null default now()
);

create or replace function mdata_ops.refresh_bbrr_dashboard_usage_cache()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, mdata_ops
as $$
begin
  insert into mdata_ops.bbrr_dashboard_usage_cache (
    singleton,
    bbrr_ruts_residencial,
    bbrr_ruts_comercial,
    bbrr_ruts_mixto,
    bbrr_ruts_rural,
    bbrr_ruts_especial,
    bbrr_propiedades_residenciales,
    bbrr_propiedades_comerciales,
    bbrr_propiedades_rurales,
    bbrr_propiedades_especiales,
    refreshed_at
  )
  select
    true,
    count(*) filter (where uso_propiedad_inferido = 'residencial')::bigint,
    count(*) filter (where uso_propiedad_inferido = 'comercial')::bigint,
    count(*) filter (where uso_propiedad_inferido = 'mixto_comercial_residencial')::bigint,
    count(*) filter (where uso_propiedad_inferido = 'rural_productivo')::bigint,
    count(*) filter (where uso_propiedad_inferido = 'indeterminado_o_especial')::bigint,
    coalesce(sum(n_propiedades_residenciales), 0)::bigint,
    coalesce(sum(n_propiedades_comerciales), 0)::bigint,
    coalesce(sum(n_propiedades_rurales), 0)::bigint,
    coalesce(sum(n_propiedades_indeterminadas), 0)::bigint,
    now()
  from public.bbrr_uso_propiedad_por_rut
  where true
  on conflict (singleton) do update
  set bbrr_ruts_residencial = excluded.bbrr_ruts_residencial,
      bbrr_ruts_comercial = excluded.bbrr_ruts_comercial,
      bbrr_ruts_mixto = excluded.bbrr_ruts_mixto,
      bbrr_ruts_rural = excluded.bbrr_ruts_rural,
      bbrr_ruts_especial = excluded.bbrr_ruts_especial,
      bbrr_propiedades_residenciales = excluded.bbrr_propiedades_residenciales,
      bbrr_propiedades_comerciales = excluded.bbrr_propiedades_comerciales,
      bbrr_propiedades_rurales = excluded.bbrr_propiedades_rurales,
      bbrr_propiedades_especiales = excluded.bbrr_propiedades_especiales,
      refreshed_at = excluded.refreshed_at;
end;
$$;

select mdata_ops.refresh_bbrr_dashboard_usage_cache();

create or replace function public.get_bbrr_dashboard_usage_stats()
returns table (
  bbrr_ruts_residencial bigint,
  bbrr_ruts_comercial bigint,
  bbrr_ruts_mixto bigint,
  bbrr_ruts_rural bigint,
  bbrr_ruts_especial bigint,
  bbrr_propiedades_residenciales bigint,
  bbrr_propiedades_comerciales bigint,
  bbrr_propiedades_rurales bigint,
  bbrr_propiedades_especiales bigint
)
language sql
stable
security definer
set search_path = pg_catalog, public, mdata_ops
as $$
  select
    c.bbrr_ruts_residencial,
    c.bbrr_ruts_comercial,
    c.bbrr_ruts_mixto,
    c.bbrr_ruts_rural,
    c.bbrr_ruts_especial,
    c.bbrr_propiedades_residenciales,
    c.bbrr_propiedades_comerciales,
    c.bbrr_propiedades_rurales,
    c.bbrr_propiedades_especiales
  from mdata_ops.bbrr_dashboard_usage_cache c
  where c.singleton;
$$;

revoke all on function mdata_ops.refresh_bbrr_dashboard_usage_cache() from public, anon, authenticated;
revoke all on table mdata_ops.bbrr_dashboard_usage_cache from public, anon, authenticated;
revoke all on function public.get_bbrr_dashboard_usage_stats() from public, anon, authenticated;
grant execute on function public.get_bbrr_dashboard_usage_stats() to service_role;

-- Había dos crons DB que duplicaban el cron Vercel y podían solaparse. La
-- ingesta externa debe seguir entrando por /api/base-contact/refresh; el cron
-- DB no conoce esa fuente y por eso se elimina, no se reemplaza.
do $$
declare
  v_job record;
begin
  for v_job in
    select jobid
    from cron.job
    where jobname in ('refresh-empresas-master-crm', 'refresh-base-contact-matview')
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

comment on schema mdata_ops is
  'Controles privados, telemetría y cachés operacionales exclusivos de Bigdata.';
comment on table mdata_ops.heavy_job_control is
  'Kill switch, ventana horaria y límites por trabajo pesado.';
comment on table mdata_ops.heavy_job_runs is
  'Telemetría de ejecuciones pesadas; no es una cola de negocio.';
