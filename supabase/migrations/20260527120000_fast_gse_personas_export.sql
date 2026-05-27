set statement_timeout = 0;

create index concurrently if not exists idx_personas_master_gse_export_geo
  on public.personas_master (
    totalavaluos desc,
    n_bienes_raices desc,
    n_autos desc,
    rutid
  )
  where nullif(btrim(coalesce(razon_social_empresa, '')), '') is null
    and coalesce(nullif(btrim(region_part), ''), nullif(btrim(domicilio_region), '')) is not null
    and coalesce(nullif(btrim(comuna_part), ''), nullif(btrim(domicilio_comuna), '')) is not null;

create index concurrently if not exists idx_personas_master_gse_export_all
  on public.personas_master (
    totalavaluos desc,
    n_bienes_raices desc,
    n_autos desc,
    rutid
  )
  where nullif(btrim(coalesce(razon_social_empresa, '')), '') is null;
