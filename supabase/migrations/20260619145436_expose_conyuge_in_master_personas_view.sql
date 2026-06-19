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
  coalesce(pm.n_autos, 0) * 10 +
    coalesce(pm.n_bienes_raices, 0) * 20 +
    case when pm.razon_social_empresa is not null then 15 else 0 end +
    case when nullif(trim(pm.email), '') is not null then 5 else 0 end +
    case when nullif(trim(pm.fono_cel), '') is not null then 5 else 0 end as score_patrimonial,
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
  gm.rubro,
  gm.facturacion_sub_rango,
  gm.tamano_empresas,
  gm.fecha_direccion_comer,
  gm.con_cargo_ejecutivo,
  gm.con_email_ejecutivo,
  gm.con_fono_celular_ejecutivo,
  gm.con_fono_comercial_ejecutivo,
  nullif(trim(pm.rutid_conyuge), '') as rutid_conyuge,
  nullif(trim(pm.nombre_conyuge), '') as nombre_conyuge,
  nullif(trim(pm.conyuge_source), '') as conyuge_source,
  pm.conyuge_loaded_at
from public.personas_master pm
left join public.bbrr_uso_propiedad_por_rut bu
  on bu.rutid = nullif(ltrim(regexp_replace(upper(pm.rutid::text), '[^0-9K]', '', 'g'), '0'), '')
left join public.geimser_mkt_7245_empresas gm
  on gm.rutid = pm.rutid;

grant select on public.master_personas_view to authenticated, anon, service_role;
