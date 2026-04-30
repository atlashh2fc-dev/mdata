set statement_timeout = 0;

drop materialized view if exists public.empresas_ventas_tendencia_stats;
create materialized view public.empresas_ventas_tendencia_stats as
select
  count(*)::bigint as total_empresas,
  count(*) filter (where resultado_tendencia = 'sube')::bigint as empresas_sube,
  count(*) filter (where resultado_tendencia = 'baja')::bigint as empresas_baja,
  count(*) filter (where resultado_tendencia = 'estable')::bigint as empresas_estable,
  count(*) filter (where resultado_tendencia = 'sin_datos')::bigint as empresas_sin_datos,
  now() as refreshed_at
from public.empresas_ventas_tendencia;

create unique index if not exists idx_empresas_ventas_tendencia_stats_one
  on public.empresas_ventas_tendencia_stats ((1));

create index if not exists idx_personas_master_empresa_rutid_normalizado
  on public.personas_master ((ltrim(upper(rutid), '0')))
  where nullif(razon_social_empresa, '') is not null;

drop view if exists public.empresas_comercial_unificada_stats;
drop view if exists public.empresas_comercial_unificada;

create or replace view public.empresas_comercial_unificada as
select
  coalesce(pm.rutid_normalizado, evt.rutid) as rutid,
  pm.rutid as rutid_master,
  evt.rutid as rutid_tendencia_ventas,
  evt.rut,
  evt.dv,
  coalesce(nullif(pm.razon_social_empresa, ''), nullif(evt.razon_social_ultima, '')) as razon_social,
  (pm.rutid is not null) as en_base_pyme,
  (evt.rutid is not null) as en_base_tendencia_ventas,
  (pm.rutid is not null and evt.rutid is not null) as cruza_pyme_tendencia,
  pm.email,
  pm.fono_cel,
  coalesce(nullif(pm.region_canonica, ''), nullif(pm.domicilio_region, ''), nullif(evt.region_ultima, '')) as region,
  coalesce(nullif(pm.comuna_canonica, ''), nullif(pm.domicilio_comuna, ''), nullif(evt.comuna_ultima, '')) as comuna,
  pm.n_autos,
  pm.n_bienes_raices,
  pm.totalavaluos,
  pm.score_patrimonial,
  pm.cobertura_pct,
  evt.anio_ultimo,
  evt.tipo_contribuyente_ultimo,
  evt.subtipo_contribuyente_ultimo,
  evt.rubro_economico_ultimo,
  evt.subrubro_economico_ultimo,
  evt.actividad_economica_ultima,
  evt.tramo_ventas_2020,
  evt.tramo_ventas_2021,
  evt.tramo_ventas_2022,
  evt.tramo_ventas_2023,
  evt.tramo_ventas_2024,
  evt.trabajadores_2020,
  evt.trabajadores_2021,
  evt.trabajadores_2022,
  evt.trabajadores_2023,
  evt.trabajadores_2024,
  evt.anios_con_tramo,
  evt.primer_anio_con_tramo,
  evt.ultimo_anio_con_tramo,
  evt.primer_tramo_ventas,
  evt.ultimo_tramo_ventas,
  evt.tramo_ventas_promedio_2020_2024,
  evt.cambio_promedio_anual_tramo,
  evt.pendiente_tendencia_tramo,
  evt.movimientos_alza,
  evt.movimientos_baja,
  evt.resultado_tendencia,
  greatest(
    coalesce(pm.updated_at, '-infinity'::timestamptz),
    coalesce(evt.loaded_at, '-infinity'::timestamptz)
  ) as updated_at
from (
  select
    *,
    ltrim(upper(rutid), '0') as rutid_normalizado
  from public.master_personas_view
  where nullif(razon_social_empresa, '') is not null
) pm
full outer join public.empresas_ventas_tendencia evt
  on evt.rutid = pm.rutid_normalizado;

create or replace view public.empresas_comercial_unificada_stats as
select
  count(*)::bigint as total_empresas_unicas,
  count(*) filter (where en_base_pyme)::bigint as empresas_base_pyme,
  count(*) filter (where en_base_tendencia_ventas)::bigint as empresas_base_tendencia,
  count(*) filter (where cruza_pyme_tendencia)::bigint as empresas_cruzadas,
  count(*) filter (where resultado_tendencia = 'sube')::bigint as empresas_sube,
  count(*) filter (where resultado_tendencia = 'baja')::bigint as empresas_baja,
  count(*) filter (where resultado_tendencia = 'estable')::bigint as empresas_estable,
  count(*) filter (where resultado_tendencia = 'sin_datos')::bigint as empresas_sin_datos
from public.empresas_comercial_unificada;

grant select on public.empresas_ventas_tendencia_stats to authenticated, anon, service_role;
grant select on public.empresas_comercial_unificada to authenticated, anon, service_role;
grant select on public.empresas_comercial_unificada_stats to authenticated, anon, service_role;

insert into public.data_sources (
  name,
  slug,
  description,
  source_type,
  canonical_table,
  source_table_name,
  primary_key_column,
  supports_incremental,
  is_active,
  record_count,
  last_loaded_at,
  last_job_status
)
select
  'Empresas comercial unificada',
  'empresas_comercial_unificada',
  'Vista unificada por RUT normalizado que cruza PyME master con tendencia de ventas 2020-2024 sin duplicar empresas.',
  'postgres',
  'empresas_comercial_unificada',
  'empresas_comercial_unificada',
  'rutid',
  false,
  true,
  total_empresas_unicas,
  now(),
  'completed'
from public.empresas_comercial_unificada_stats
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  source_type = excluded.source_type,
  canonical_table = excluded.canonical_table,
  source_table_name = excluded.source_table_name,
  primary_key_column = excluded.primary_key_column,
  supports_incremental = excluded.supports_incremental,
  is_active = excluded.is_active,
  record_count = excluded.record_count,
  last_loaded_at = excluded.last_loaded_at,
  last_job_status = excluded.last_job_status,
  updated_at = now();
