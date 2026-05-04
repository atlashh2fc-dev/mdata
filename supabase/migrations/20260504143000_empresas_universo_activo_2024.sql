set statement_timeout = 0;

drop materialized view if exists public.empresas_comercial_unificada_stats;
drop view if exists public.empresas_comercial_unificada;

create or replace view public.empresas_comercial_unificada as
select
  evt.rutid,
  pm.rutid as rutid_master,
  evt.rutid as rutid_tendencia_ventas,
  evt.rut,
  evt.dv,
  coalesce(nullif(pm.razon_social_empresa, ''), nullif(evt.razon_social_ultima, '')) as razon_social,
  case
    when pm.rutid is not null then 'activa_2024_y_pyme_master'
    else 'activa_2024_sii'
  end as fuente_universo_empresa,
  (pm.rutid is not null) as en_base_pyme,
  true as en_base_tendencia_ventas,
  (pm.rutid is not null) as cruza_pyme_tendencia,
  case
    when evt.ultimo_tramo_ventas is null then 'sin_tramo'
    when evt.ultimo_tramo_ventas <= 5 then 'micro'
    when evt.ultimo_tramo_ventas <= 7 then 'pequena'
    when evt.ultimo_tramo_ventas <= 9 then 'mediana'
    when evt.ultimo_tramo_ventas <= 12 then 'gran_empresa'
    else 'corporacion'
  end as segmento_tamano_empresa,
  (evt.ultimo_tramo_ventas between 1 and 9) as es_pyme,
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
  evt.fecha_termino_giro_ultima,
  true as es_universo_operativo_ventas,
  greatest(
    coalesce(pm.updated_at, '-infinity'::timestamptz),
    coalesce(evt.loaded_at, '-infinity'::timestamptz),
    coalesce(addr.source_seen_at, '-infinity'::timestamptz)
  ) as updated_at
from public.empresas_ventas_tendencia evt
left join (
  select
    *,
    nullif(ltrim(regexp_replace(upper(rutid), '[^0-9K]', '', 'g'), '0'), '') as rutid_normalizado
  from public.master_personas_view
  where nullif(razon_social_empresa, '') is not null
) pm
  on pm.rutid_normalizado = evt.rutid
left join public.empresas_direccion_preferida addr
  on addr.rutid = evt.rutid
where evt.anio_ultimo = 2024
  and evt.fecha_termino_giro_ultima is null;

create materialized view public.empresas_comercial_unificada_stats as
select
  count(*)::bigint as total_empresas_unicas,
  count(*) filter (where en_base_pyme)::bigint as empresas_base_pyme,
  count(*) filter (where en_base_tendencia_ventas)::bigint as empresas_base_tendencia,
  count(*) filter (where cruza_pyme_tendencia)::bigint as empresas_cruzadas,
  0::bigint as empresas_solo_pyme_master,
  count(*) filter (where not en_base_pyme)::bigint as empresas_solo_tendencia,
  count(*) filter (where domicilio_direccion is not null)::bigint as empresas_con_direccion,
  count(*) filter (where comuna is not null)::bigint as empresas_con_comuna,
  count(*) filter (where region is not null)::bigint as empresas_con_region,
  count(*) filter (where es_pyme)::bigint as empresas_pyme,
  count(*) filter (where es_gran_empresa)::bigint as empresas_grandes,
  count(*) filter (where es_corporacion)::bigint as empresas_corporacion,
  count(*) filter (where segmento_tamano_empresa = 'micro')::bigint as segmento_micro,
  count(*) filter (where segmento_tamano_empresa = 'micro' and resultado_tendencia = 'sube')::bigint as segmento_micro_sube,
  count(*) filter (where segmento_tamano_empresa = 'micro' and resultado_tendencia = 'baja')::bigint as segmento_micro_baja,
  count(*) filter (where segmento_tamano_empresa = 'pequena')::bigint as segmento_pequena,
  count(*) filter (where segmento_tamano_empresa = 'pequena' and resultado_tendencia = 'sube')::bigint as segmento_pequena_sube,
  count(*) filter (where segmento_tamano_empresa = 'pequena' and resultado_tendencia = 'baja')::bigint as segmento_pequena_baja,
  count(*) filter (where segmento_tamano_empresa = 'mediana')::bigint as segmento_mediana,
  count(*) filter (where segmento_tamano_empresa = 'mediana' and resultado_tendencia = 'sube')::bigint as segmento_mediana_sube,
  count(*) filter (where segmento_tamano_empresa = 'mediana' and resultado_tendencia = 'baja')::bigint as segmento_mediana_baja,
  count(*) filter (where segmento_tamano_empresa = 'gran_empresa')::bigint as segmento_gran_empresa,
  count(*) filter (where segmento_tamano_empresa = 'gran_empresa' and resultado_tendencia = 'sube')::bigint as segmento_gran_empresa_sube,
  count(*) filter (where segmento_tamano_empresa = 'gran_empresa' and resultado_tendencia = 'baja')::bigint as segmento_gran_empresa_baja,
  count(*) filter (where segmento_tamano_empresa = 'corporacion')::bigint as segmento_corporacion,
  count(*) filter (where segmento_tamano_empresa = 'corporacion' and resultado_tendencia = 'sube')::bigint as segmento_corporacion_sube,
  count(*) filter (where segmento_tamano_empresa = 'corporacion' and resultado_tendencia = 'baja')::bigint as segmento_corporacion_baja,
  count(*) filter (where segmento_tamano_empresa = 'sin_tramo')::bigint as segmento_pyme_master_sin_tramo,
  count(*) filter (where segmento_tamano_empresa = 'sin_tramo' and resultado_tendencia = 'sube')::bigint as segmento_pyme_master_sin_tramo_sube,
  count(*) filter (where segmento_tamano_empresa = 'sin_tramo' and resultado_tendencia = 'baja')::bigint as segmento_pyme_master_sin_tramo_baja,
  count(*) filter (where resultado_tendencia = 'sube')::bigint as empresas_sube,
  count(*) filter (where resultado_tendencia = 'baja')::bigint as empresas_baja,
  count(*) filter (where resultado_tendencia = 'estable')::bigint as empresas_estable,
  count(*) filter (where resultado_tendencia = 'sin_datos')::bigint as empresas_sin_datos
from public.empresas_comercial_unificada;

create unique index if not exists idx_empresas_comercial_unificada_stats_one
  on public.empresas_comercial_unificada_stats ((1));

grant select on public.empresas_comercial_unificada to authenticated, anon, service_role;
grant select on public.empresas_comercial_unificada_stats to authenticated, anon, service_role;

update public.data_sources ds
set
  description = 'Universo operativo de empresas activas para venta: SII 2024 sin termino de giro, enriquecido con master PyME, direccion preferida y segmentacion por tramo.',
  record_count = stats.total_empresas_unicas,
  last_loaded_at = now(),
  last_job_status = 'completed',
  updated_at = now()
from public.empresas_comercial_unificada_stats stats
where ds.slug = 'empresas_comercial_unificada';
