set statement_timeout = 0;

create materialized view if not exists public.bbrr_uso_propiedad_por_rut as
with classified as (
  select
    nullif(ltrim(regexp_replace(upper(rutid), '[^0-9K]', '', 'g'), '0'), '') as rutid,
    nullif(btrim(destino), '') as destino,
    avaluo_fiscal,
    case
      when destino in ('HABITACIONAL', 'CASA PATRONAL') then 'residencial'
      when destino in (
        'COMERCIO',
        'OFICINA',
        'BODEGA Y ALMACENAJE',
        'INDUSTRIA',
        'HOTEL, MOTEL',
        'SALUD',
        'EDUCACION Y CULTURA',
        'DEPORTE Y RECREACION',
        'TRANSPORTE Y TELECOMUNICACIONES',
        'AGROINDUSTRIAL',
        'MINERIA'
      ) then 'comercial_operacional'
      when destino in ('AGRICOLA', 'FORESTAL') then 'rural_productivo'
      else 'indeterminado_o_especial'
    end as uso_detalle
  from public.bbrr_propiedades
  where nullif(ltrim(regexp_replace(upper(rutid), '[^0-9K]', '', 'g'), '0'), '') is not null
),
rollup as (
  select
    rutid,
    count(*)::integer as n_propiedades_detalle,
    array_agg(distinct destino order by destino) filter (where destino is not null) as bbrr_destinos,
    count(*) filter (where uso_detalle = 'residencial')::integer as n_propiedades_residenciales,
    count(*) filter (where uso_detalle = 'comercial_operacional')::integer as n_propiedades_comerciales,
    count(*) filter (where uso_detalle = 'rural_productivo')::integer as n_propiedades_rurales,
    count(*) filter (where uso_detalle = 'indeterminado_o_especial')::integer as n_propiedades_indeterminadas,
    coalesce(sum(avaluo_fiscal) filter (where uso_detalle = 'residencial'), 0)::numeric(18,2) as avaluo_residencial,
    coalesce(sum(avaluo_fiscal) filter (where uso_detalle = 'comercial_operacional'), 0)::numeric(18,2) as avaluo_comercial,
    coalesce(sum(avaluo_fiscal) filter (where uso_detalle = 'rural_productivo'), 0)::numeric(18,2) as avaluo_rural,
    coalesce(sum(avaluo_fiscal) filter (where uso_detalle = 'indeterminado_o_especial'), 0)::numeric(18,2) as avaluo_indeterminado
  from classified
  group by rutid
)
select
  rutid,
  case
    when n_propiedades_comerciales > 0 and n_propiedades_residenciales > 0 then 'mixto_comercial_residencial'
    when n_propiedades_comerciales > 0 then 'comercial'
    when n_propiedades_residenciales > 0 then 'residencial'
    when n_propiedades_rurales > 0 then 'rural_productivo'
    else 'indeterminado_o_especial'
  end as uso_propiedad_inferido,
  bbrr_destinos,
  n_propiedades_detalle,
  n_propiedades_residenciales,
  n_propiedades_comerciales,
  n_propiedades_rurales,
  n_propiedades_indeterminadas,
  avaluo_residencial,
  avaluo_comercial,
  avaluo_rural,
  avaluo_indeterminado,
  now() as refreshed_at
from rollup;

create unique index if not exists idx_bbrr_uso_propiedad_por_rut_rutid
  on public.bbrr_uso_propiedad_por_rut (rutid);

create index if not exists idx_bbrr_uso_propiedad_por_rut_uso
  on public.bbrr_uso_propiedad_por_rut (uso_propiedad_inferido);

create index if not exists idx_bbrr_uso_propiedad_por_rut_destinos
  on public.bbrr_uso_propiedad_por_rut using gin (bbrr_destinos);

create index if not exists idx_personas_master_rutid_normalizado_all
  on public.personas_master ((nullif(ltrim(regexp_replace(upper(rutid), '[^0-9K]', '', 'g'), '0'), '')));

create index if not exists idx_personas_master_rutid_ltrim_all
  on public.personas_master ((nullif(ltrim(upper(rutid), '0'), '')));

create or replace view public.master_personas_view as
select
  pm.rutid,

  nullif(trim(pm.nombres), '') as nombres,
  nullif(trim(pm.paterno), '') as paterno,
  nullif(trim(pm.materno), '') as materno,
  nullif(trim(
    coalesce(nullif(trim(pm.nombres),''), '') || ' ' ||
    coalesce(nullif(trim(pm.paterno),''), '') || ' ' ||
    coalesce(nullif(trim(pm.materno),''), '')
  ), '') as nombre_completo,

  nullif(trim(pm.email), '') as email,
  nullif(trim(pm.fono_cel), '') as fono_cel,
  nullif(trim(pm.comuna_part), '') as comuna_part,
  nullif(trim(pm.region_part), '') as region_part,

  pm.n_autos,
  (pm.n_autos > 0) as tiene_autos,
  pm.razon_social_empresa,
  (pm.razon_social_empresa is not null) as tiene_empresa,
  pm.domicilio_comuna,
  pm.domicilio_region,
  pm.n_bienes_raices,
  pm.totalavaluos,
  (pm.n_bienes_raices > 0) as tiene_bienes_raices,

  (
    coalesce(pm.n_autos, 0) * 10 +
    coalesce(pm.n_bienes_raices, 0) * 20 +
    case when pm.razon_social_empresa is not null then 15 else 0 end +
    case when nullif(trim(pm.email), '') is not null then 5 else 0 end +
    case when nullif(trim(pm.fono_cel), '') is not null then 5 else 0 end
  )::integer as score_patrimonial,

  (
    (case when nullif(trim(pm.nombres), '') is not null then 1 else 0 end +
     case when nullif(trim(pm.email), '') is not null then 1 else 0 end +
     case when nullif(trim(pm.fono_cel), '') is not null then 1 else 0 end +
     case when nullif(trim(pm.region_part), '') is not null then 1 else 0 end +
     case when pm.n_autos > 0 then 1 else 0 end +
     case when pm.razon_social_empresa is not null then 1 else 0 end +
     case when pm.domicilio_region is not null then 1 else 0 end +
     case when pm.n_bienes_raices > 0 then 1 else 0 end
    )::float / 8.0 * 100
  )::integer as cobertura_pct,

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
  coalesce(bu.avaluo_residencial, 0) as avaluo_residencial,
  coalesce(bu.avaluo_comercial, 0) as avaluo_comercial,
  coalesce(bu.avaluo_rural, 0) as avaluo_rural,
  coalesce(bu.avaluo_indeterminado, 0) as avaluo_indeterminado
from public.personas_master pm
left join public.bbrr_uso_propiedad_por_rut bu
  on bu.rutid = nullif(ltrim(regexp_replace(upper(pm.rutid), '[^0-9K]', '', 'g'), '0'), '');

create or replace function public.refresh_bbrr_uso_propiedad_por_rut()
returns void
language plpgsql
security definer
as $$
begin
  refresh materialized view concurrently public.bbrr_uso_propiedad_por_rut;
end;
$$;

create or replace function public.get_bbrr_uso_counts()
returns table(value text, count bigint)
language sql
stable
security definer
as $$
  select uso_propiedad_inferido as value, count(*)::bigint as count
  from public.bbrr_uso_propiedad_por_rut
  group by uso_propiedad_inferido
  order by count(*) desc;
$$;

create or replace function public.get_bbrr_destino_counts()
returns table(value text, count bigint)
language sql
stable
security definer
as $$
  select destino as value, count(*)::bigint as count
  from public.bbrr_propiedades
  where nullif(btrim(destino), '') is not null
  group by destino
  order by count(*) desc;
$$;

grant select on public.bbrr_uso_propiedad_por_rut to authenticated, anon, service_role;
grant execute on function public.refresh_bbrr_uso_propiedad_por_rut() to authenticated, anon, service_role;
grant execute on function public.get_bbrr_uso_counts() to authenticated, anon, service_role;
grant execute on function public.get_bbrr_destino_counts() to authenticated, anon, service_role;
