set statement_timeout = 0;

drop materialized view if exists public.empresas_comercial_unificada_stats;

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
  count(*) filter (where segmento_tamano_empresa = 'pyme_master_sin_tramo')::bigint as segmento_pyme_master_sin_tramo,
  count(*) filter (where segmento_tamano_empresa = 'pyme_master_sin_tramo' and resultado_tendencia = 'sube')::bigint as segmento_pyme_master_sin_tramo_sube,
  count(*) filter (where segmento_tamano_empresa = 'pyme_master_sin_tramo' and resultado_tendencia = 'baja')::bigint as segmento_pyme_master_sin_tramo_baja,
  count(*) filter (where resultado_tendencia = 'sube')::bigint as empresas_sube,
  count(*) filter (where resultado_tendencia = 'baja')::bigint as empresas_baja,
  count(*) filter (where resultado_tendencia = 'estable')::bigint as empresas_estable,
  count(*) filter (where resultado_tendencia = 'sin_datos')::bigint as empresas_sin_datos
from public.empresas_comercial_unificada;

create unique index if not exists idx_empresas_comercial_unificada_stats_one
  on public.empresas_comercial_unificada_stats ((1));

grant select on public.empresas_comercial_unificada_stats to authenticated, anon, service_role;

update public.data_sources ds
set
  record_count = stats.total_empresas_unicas,
  last_loaded_at = now(),
  last_job_status = 'completed',
  updated_at = now()
from public.empresas_comercial_unificada_stats stats
where ds.slug = 'empresas_comercial_unificada';
