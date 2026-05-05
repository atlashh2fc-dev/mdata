drop materialized view if exists public.stats_universos_empresas;

create materialized view public.stats_universos_empresas as
select
  'persona_juridica'::text as entidad_tipo,
  (nullif(btrim(razon_social), '') is not null) as con_nombre,
  (nullif(btrim(email), '') is not null) as con_email,
  (nullif(btrim(fono_cel), '') is not null) as con_fono,
  (coalesce(n_autos, 0) > 0) as con_autos,
  true as con_empresa,
  (
    coalesce(
      nullif(btrim(domicilio_direccion), ''),
      nullif(btrim(region), ''),
      nullif(btrim(comuna), '')
    ) is not null
  ) as con_domicilio,
  (coalesce(n_bienes_raices, 0) > 0 or coalesce(totalavaluos, 0) > 0) as con_bienes_raices,
  count(*)::bigint as total
from public.empresas_comercial_unificada
where coalesce(es_universo_operativo_ventas, true) = true
group by
  con_nombre,
  con_email,
  con_fono,
  con_autos,
  con_domicilio,
  con_bienes_raices;

create unique index if not exists idx_stats_universos_empresas
  on public.stats_universos_empresas (
    entidad_tipo,
    con_nombre,
    con_email,
    con_fono,
    con_autos,
    con_empresa,
    con_domicilio,
    con_bienes_raices
  );

grant select on public.stats_universos_empresas to authenticated, anon, service_role;

create or replace function public.refresh_dashboard_stats()
returns void
language plpgsql
security definer
as $$
begin
  refresh materialized view public.dashboard_stats;
  refresh materialized view public.stats_por_region;
  refresh materialized view public.stats_score_dist;

  if to_regclass('public.stats_universos') is not null then
    refresh materialized view public.stats_universos;
  end if;

  if to_regclass('public.stats_universos_empresas') is not null then
    refresh materialized view public.stats_universos_empresas;
  end if;
end;
$$;

grant execute on function public.refresh_dashboard_stats() to authenticated, anon, service_role;
