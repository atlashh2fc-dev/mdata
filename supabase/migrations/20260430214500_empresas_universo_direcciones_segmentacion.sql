set statement_timeout = 0;

do $$
begin
  if to_regclass('public.empresas_comercial_unificada_stats') is not null then
    if (
      select c.relkind = 'm'
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'empresas_comercial_unificada_stats'
    ) then
      execute 'drop materialized view public.empresas_comercial_unificada_stats';
    else
      execute 'drop view public.empresas_comercial_unificada_stats';
    end if;
  end if;
end $$;

drop view if exists public.empresas_comercial_unificada;
drop materialized view if exists public.empresas_direccion_preferida;

create materialized view public.empresas_direccion_preferida as
with company_scope as (
  select nullif(ltrim(regexp_replace(upper(rutid), '[^0-9K]', '', 'g'), '0'), '') as rutid
  from public.master_personas_view
  where nullif(razon_social_empresa, '') is not null

  union

  select rutid
  from public.empresas_ventas_tendencia
),
candidate_addresses as (
  select
    scope.rutid,
    nullif(
      btrim(
        concat_ws(
          ' ',
          nullif(btrim(pcp.metadata->>'calle_comer'), ''),
          nullif(btrim(pcp.metadata->>'numero_comer'), ''),
          nullif(btrim(pcp.metadata->>'resto_direccion_comer'), '')
        )
      ),
      ''
    ) as direccion,
    coalesce(
      nullif(btrim(pcp.metadata->>'comuna_comer'), ''),
      nullif(btrim(pcp.metadata->>'ciudad_comer'), '')
    ) as comuna,
    nullif(btrim(pcp.metadata->>'region_comer'), '') as region,
    pcp.source_name as fuente,
    100 + coalesce(pcp.source_priority, 0) + coalesce(pcp.quality_score, 0) as ranking,
    pcp.last_seen_at as source_seen_at
  from public.persona_contact_points pcp
  join company_scope scope
    on scope.rutid = nullif(ltrim(regexp_replace(upper(pcp.rutid), '[^0-9K]', '', 'g'), '0'), '')
  where pcp.source_name = 'geobpo_access_phones'
    and (
      nullif(btrim(pcp.metadata->>'calle_comer'), '') is not null
      or nullif(btrim(pcp.metadata->>'comuna_comer'), '') is not null
      or nullif(btrim(pcp.metadata->>'region_comer'), '') is not null
    )

  union all

  select
    scope.rutid,
    nullif(btrim(w.direccion), '') as direccion,
    nullif(btrim(w.comuna), '') as comuna,
    null::text as region,
    w.source_name as fuente,
    75 as ranking,
    coalesce(w.ciclo_date::timestamptz, w.updated_at, w.loaded_at) as source_seen_at
  from public.wom_customer_signals w
  join company_scope scope
    on scope.rutid = nullif(ltrim(regexp_replace(upper(w.rutid), '[^0-9K]', '', 'g'), '0'), '')
  where nullif(btrim(w.direccion), '') is not null
     or nullif(btrim(w.comuna), '') is not null

  union all

  select
    scope.rutid,
    nullif(btrim(b.direccion), '') as direccion,
    nullif(btrim(b.comuna), '') as comuna,
    null::text as region,
    'bbrr_propiedades' as fuente,
    55 as ranking,
    coalesce(b.updated_at, b.source_loaded_at, b.created_at) as source_seen_at
  from public.bbrr_propiedades b
  join company_scope scope
    on scope.rutid = nullif(ltrim(regexp_replace(upper(b.rutid), '[^0-9K]', '', 'g'), '0'), '')
  where nullif(btrim(b.direccion), '') is not null
     or nullif(btrim(b.comuna), '') is not null

  union all

  select
    scope.rutid,
    nullif(btrim(p.direccion), '') as direccion,
    nullif(btrim(p.comuna), '') as comuna,
    nullif(btrim(p.region), '') as region,
    'padron_personas_raw' as fuente,
    35 as ranking,
    coalesce(p.updated_at, p.loaded_at, p.created_at) as source_seen_at
  from public.padron_personas_raw p
  join company_scope scope
    on scope.rutid = nullif(ltrim(regexp_replace(upper(p.rutid), '[^0-9K]', '', 'g'), '0'), '')
  where nullif(btrim(p.direccion), '') is not null
     or nullif(btrim(p.comuna), '') is not null
     or nullif(btrim(p.region), '') is not null
),
ranked as (
  select
    *,
    row_number() over (
      partition by rutid
      order by
        (direccion is not null) desc,
        ranking desc,
        source_seen_at desc nulls last
    ) as rn
  from candidate_addresses
  where rutid is not null
)
select
  rutid,
  direccion,
  comuna,
  region,
  fuente,
  ranking,
  source_seen_at
from ranked
where rn = 1;

create unique index if not exists idx_empresas_direccion_preferida_rutid
  on public.empresas_direccion_preferida (rutid);

create or replace view public.empresas_comercial_unificada as
select
  coalesce(pm.rutid_normalizado, evt.rutid) as rutid,
  pm.rutid as rutid_master,
  evt.rutid as rutid_tendencia_ventas,
  evt.rut,
  evt.dv,
  coalesce(nullif(pm.razon_social_empresa, ''), nullif(evt.razon_social_ultima, '')) as razon_social,
  case
    when pm.rutid is not null and evt.rutid is not null then 'pyme_master_y_tendencia'
    when evt.rutid is not null then 'solo_tendencia_ventas'
    else 'solo_pyme_master'
  end as fuente_universo_empresa,
  (pm.rutid is not null) as en_base_pyme,
  (evt.rutid is not null) as en_base_tendencia_ventas,
  (pm.rutid is not null and evt.rutid is not null) as cruza_pyme_tendencia,
  case
    when evt.ultimo_tramo_ventas is null and pm.rutid is not null then 'pyme_master_sin_tramo'
    when evt.ultimo_tramo_ventas is null then 'sin_tramo'
    when evt.ultimo_tramo_ventas <= 5 then 'micro'
    when evt.ultimo_tramo_ventas <= 7 then 'pequena'
    when evt.ultimo_tramo_ventas <= 9 then 'mediana'
    when evt.ultimo_tramo_ventas <= 12 then 'gran_empresa'
    else 'corporacion'
  end as segmento_tamano_empresa,
  (
    pm.rutid is not null
    or evt.ultimo_tramo_ventas between 1 and 9
  ) as es_pyme,
  (evt.ultimo_tramo_ventas >= 10) as es_gran_empresa,
  (evt.ultimo_tramo_ventas >= 13) as es_corporacion,
  pm.email,
  pm.fono_cel,
  addr.direccion as domicilio_direccion,
  addr.fuente as domicilio_fuente,
  coalesce(
    nullif(addr.region, ''),
    nullif(pm.region_canonica, ''),
    nullif(pm.domicilio_region, ''),
    nullif(evt.region_ultima, '')
  ) as region,
  coalesce(
    nullif(addr.comuna, ''),
    nullif(pm.comuna_canonica, ''),
    nullif(pm.domicilio_comuna, ''),
    nullif(evt.comuna_ultima, '')
  ) as comuna,
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
    coalesce(evt.loaded_at, '-infinity'::timestamptz),
    coalesce(addr.source_seen_at, '-infinity'::timestamptz)
  ) as updated_at
from (
  select
    *,
    nullif(ltrim(regexp_replace(upper(rutid), '[^0-9K]', '', 'g'), '0'), '') as rutid_normalizado
  from public.master_personas_view
  where nullif(razon_social_empresa, '') is not null
) pm
full outer join public.empresas_ventas_tendencia evt
  on evt.rutid = pm.rutid_normalizado
left join public.empresas_direccion_preferida addr
  on addr.rutid = coalesce(pm.rutid_normalizado, evt.rutid);

create materialized view public.empresas_comercial_unificada_stats as
select
  count(*)::bigint as total_empresas_unicas,
  count(*) filter (where en_base_pyme)::bigint as empresas_base_pyme,
  count(*) filter (where en_base_tendencia_ventas)::bigint as empresas_base_tendencia,
  count(*) filter (where cruza_pyme_tendencia)::bigint as empresas_cruzadas,
  count(*) filter (where fuente_universo_empresa = 'solo_pyme_master')::bigint as empresas_solo_pyme_master,
  count(*) filter (where fuente_universo_empresa = 'solo_tendencia_ventas')::bigint as empresas_solo_tendencia,
  count(*) filter (where domicilio_direccion is not null)::bigint as empresas_con_direccion,
  count(*) filter (where comuna is not null)::bigint as empresas_con_comuna,
  count(*) filter (where region is not null)::bigint as empresas_con_region,
  count(*) filter (where es_pyme)::bigint as empresas_pyme,
  count(*) filter (where es_gran_empresa)::bigint as empresas_grandes,
  count(*) filter (where es_corporacion)::bigint as empresas_corporacion,
  count(*) filter (where segmento_tamano_empresa = 'micro')::bigint as segmento_micro,
  count(*) filter (where segmento_tamano_empresa = 'pequena')::bigint as segmento_pequena,
  count(*) filter (where segmento_tamano_empresa = 'mediana')::bigint as segmento_mediana,
  count(*) filter (where segmento_tamano_empresa = 'gran_empresa')::bigint as segmento_gran_empresa,
  count(*) filter (where segmento_tamano_empresa = 'corporacion')::bigint as segmento_corporacion,
  count(*) filter (where segmento_tamano_empresa = 'pyme_master_sin_tramo')::bigint as segmento_pyme_master_sin_tramo,
  count(*) filter (where resultado_tendencia = 'sube')::bigint as empresas_sube,
  count(*) filter (where resultado_tendencia = 'baja')::bigint as empresas_baja,
  count(*) filter (where resultado_tendencia = 'estable')::bigint as empresas_estable,
  count(*) filter (where resultado_tendencia = 'sin_datos')::bigint as empresas_sin_datos
from public.empresas_comercial_unificada;

create unique index if not exists idx_empresas_comercial_unificada_stats_one
  on public.empresas_comercial_unificada_stats ((1));

grant select on public.empresas_direccion_preferida to authenticated, anon, service_role;
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
  'Universo unico de empresas por RUT normalizado: PyME master, tendencia de ventas 2020-2024, direccion preferida y segmentacion interna por tramo.',
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
  description = excluded.description,
  record_count = excluded.record_count,
  last_loaded_at = excluded.last_loaded_at,
  last_job_status = excluded.last_job_status,
  updated_at = now();
