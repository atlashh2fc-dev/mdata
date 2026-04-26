set statement_timeout = 0;

drop function if exists public.sync_automoviles2025_rollup_to_personas_master();

create or replace function public.sync_automoviles2025_rollup_to_personas_master()
returns table (
  updated_different_counts bigint,
  inserted_missing_owners bigint,
  reset_summary_only bigint,
  total_owner_rutids bigint,
  total_vehicle_rows bigint
)
language plpgsql
as $$
begin
  drop table if exists public._automoviles2025_rollup_work;

  create table public._automoviles2025_rollup_work as
  select
    rutid,
    count(*)::integer as n_autos,
    max(nullif(btrim(nombre_razon_social), '')) as nombre_razon_social,
    max(nullif(btrim(paterno), '')) as paterno,
    max(nullif(btrim(materno), '')) as materno,
    max(nullif(btrim(nombres), '')) as nombres,
    max(nullif(btrim(tipo_rut), '')) as tipo_rut,
    max(loaded_at) as loaded_at
  from public.automoviles2025
  group by rutid;

  create unique index idx_automoviles2025_rollup_work_rutid
    on public._automoviles2025_rollup_work (rutid);

  analyze public._automoviles2025_rollup_work;

  with changed as (
    update public.personas_master pm
    set n_autos = w.n_autos,
        loaded_at = greatest(pm.loaded_at, w.loaded_at)
    from public._automoviles2025_rollup_work w
    where pm.rutid = w.rutid
      and coalesce(pm.n_autos, 0) is distinct from w.n_autos
    returning pm.rutid
  )
  select count(*) into updated_different_counts
  from changed;

  with inserted as (
    insert into public.personas_master (
      rutid,
      nombres,
      paterno,
      materno,
      n_autos,
      razon_social_empresa,
      loaded_at
    )
    select
      w.rutid,
      case when w.tipo_rut ilike '%NATURAL%' then left(w.nombres, 150) end,
      case when w.tipo_rut ilike '%NATURAL%' then left(w.paterno, 80) end,
      case when w.tipo_rut ilike '%NATURAL%' then left(w.materno, 80) end,
      w.n_autos,
      case when w.tipo_rut not ilike '%NATURAL%' then left(w.nombre_razon_social, 250) end,
      coalesce(w.loaded_at, now())
    from public._automoviles2025_rollup_work w
    where not exists (
      select 1
      from public.personas_master pm
      where pm.rutid = w.rutid
    )
    returning rutid
  )
  select count(*) into inserted_missing_owners
  from inserted;

  with reset as (
    update public.personas_master pm
    set n_autos = 0
    where coalesce(pm.n_autos, 0) > 0
      and not exists (
        select 1
        from public._automoviles2025_rollup_work w
        where w.rutid = pm.rutid
      )
    returning pm.rutid
  )
  select count(*) into reset_summary_only
  from reset;

  select count(*), coalesce(sum(n_autos), 0)
  into total_owner_rutids, total_vehicle_rows
  from public._automoviles2025_rollup_work;

  drop table if exists public._automoviles2025_rollup_work;

  return next;
end;
$$;

grant execute on function public.sync_automoviles2025_rollup_to_personas_master() to authenticated, anon, service_role;
