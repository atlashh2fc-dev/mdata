create table if not exists public.geimser_mkt_7245_empresas (
  rutid varchar(20) primary key references public.personas_master(rutid) on delete cascade,
  razon_social text,
  tipovia_comer text,
  calle_comer text,
  numero_comer text,
  resto_direccion_comer text,
  comuna_comer text,
  ciudad_comer text,
  region_comer text,
  fecha_direccion_comer text,
  rubro text,
  facturacion_sub_rango text,
  tamano_empresas text,
  con_cargo_ejecutivo boolean,
  con_email_ejecutivo boolean,
  con_fono_celular_ejecutivo boolean,
  con_fono_comercial_ejecutivo boolean,
  source_name text not null default 'geimser_mkt_7245_resultado',
  source_loaded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_geimser_mkt_7245_empresas_rubro
  on public.geimser_mkt_7245_empresas (rubro);

create index if not exists idx_geimser_mkt_7245_empresas_tamano
  on public.geimser_mkt_7245_empresas (tamano_empresas);

create index if not exists idx_geimser_mkt_7245_empresas_facturacion
  on public.geimser_mkt_7245_empresas (facturacion_sub_rango);

create or replace view public.master_personas_view as
select
  pm.rutid,
  nullif(trim(pm.nombres), '') as nombres,
  nullif(trim(pm.paterno), '') as paterno,
  nullif(trim(pm.materno), '') as materno,
  nullif(trim(
    coalesce(nullif(trim(pm.nombres), ''), '') || ' ' ||
    coalesce(nullif(trim(pm.paterno), ''), '') || ' ' ||
    coalesce(nullif(trim(pm.materno), ''), '')
  ), '') as nombre_completo,
  nullif(trim(pm.email), '') as email,
  nullif(trim(pm.fono_cel), '') as fono_cel,
  nullif(trim(pm.comuna_part), '') as comuna_part,
  nullif(trim(pm.region_part), '') as region_part,
  pm.n_autos,
  pm.n_autos > 0 as tiene_autos,
  pm.razon_social_empresa,
  pm.razon_social_empresa is not null as tiene_empresa,
  pm.domicilio_comuna,
  pm.domicilio_region,
  pm.n_bienes_raices,
  pm.totalavaluos,
  pm.n_bienes_raices > 0 as tiene_bienes_raices,
  (
    coalesce(pm.n_autos, 0) * 10 +
    coalesce(pm.n_bienes_raices, 0) * 20 +
    case when pm.razon_social_empresa is not null then 15 else 0 end +
    case when nullif(trim(pm.email), '') is not null then 5 else 0 end +
    case when nullif(trim(pm.fono_cel), '') is not null then 5 else 0 end
  ) as score_patrimonial,
  ((
    case when nullif(trim(pm.nombres), '') is not null then 1 else 0 end +
    case when nullif(trim(pm.email), '') is not null then 1 else 0 end +
    case when nullif(trim(pm.fono_cel), '') is not null then 1 else 0 end +
    case when nullif(trim(pm.region_part), '') is not null then 1 else 0 end +
    case when pm.n_autos > 0 then 1 else 0 end +
    case when pm.razon_social_empresa is not null then 1 else 0 end +
    case when pm.domicilio_region is not null then 1 else 0 end +
    case when pm.n_bienes_raices > 0 then 1 else 0 end
  )::float / 8.0 * 100)::integer as cobertura_pct,
  coalesce(nullif(trim(pm.region_part), ''), pm.domicilio_region) as region_canonica,
  coalesce(nullif(trim(pm.comuna_part), ''), pm.domicilio_comuna) as comuna_canonica,
  pm.loaded_at as created_at,
  pm.loaded_at as updated_at,
  bu.uso_propiedad_inferido,
  coalesce(bu.bbrr_destinos, array[]::text[]) as bbrr_destinos,
  coalesce(bu.n_propiedades_detalle, 0) as n_propiedades_detalle,
  coalesce(bu.n_propiedades_residenciales, 0) as n_propiedades_residenciales,
  coalesce(bu.n_propiedades_comerciales, 0) as n_propiedades_comerciales,
  coalesce(bu.n_propiedades_rurales, 0) as n_propiedades_rurales,
  coalesce(bu.n_propiedades_indeterminadas, 0) as n_propiedades_indeterminadas,
  coalesce(bu.avaluo_residencial, 0::numeric) as avaluo_residencial,
  coalesce(bu.avaluo_comercial, 0::numeric) as avaluo_comercial,
  coalesce(bu.avaluo_rural, 0::numeric) as avaluo_rural,
  coalesce(bu.avaluo_indeterminado, 0::numeric) as avaluo_indeterminado,
  gm.rubro as rubro,
  gm.facturacion_sub_rango as facturacion_sub_rango,
  gm.tamano_empresas as tamano_empresas,
  gm.fecha_direccion_comer as fecha_direccion_comer,
  gm.con_cargo_ejecutivo as con_cargo_ejecutivo,
  gm.con_email_ejecutivo as con_email_ejecutivo,
  gm.con_fono_celular_ejecutivo as con_fono_celular_ejecutivo,
  gm.con_fono_comercial_ejecutivo as con_fono_comercial_ejecutivo
from public.personas_master pm
left join public.bbrr_uso_propiedad_por_rut bu
  on bu.rutid = nullif(ltrim(regexp_replace(upper(pm.rutid::text), '[^0-9K]', '', 'g'), '0'), '')
left join public.geimser_mkt_7245_empresas gm
  on gm.rutid = pm.rutid;

grant select on public.master_personas_view to authenticated, anon, service_role;

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
  last_job_status
)
values (
  'GEIMSER MKT-7245 resultado',
  'geimser_mkt_7245_empresas',
  'Enriquecimiento comercial de empresas por RUT: rubro, rango de facturacion, tamano, direccion comercial y flags de ejecutivo.',
  'xlsx',
  'geimser_mkt_7245_empresas',
  'Resultado_FOLIO_MKT-7245_GEIMSER.xlsx',
  'rutid',
  true,
  true,
  'pending'
)
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  source_type = excluded.source_type,
  canonical_table = excluded.canonical_table,
  source_table_name = excluded.source_table_name,
  primary_key_column = excluded.primary_key_column,
  supports_incremental = excluded.supports_incremental,
  is_active = excluded.is_active,
  updated_at = now();
