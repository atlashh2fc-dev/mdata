set statement_timeout = 0;

create table if not exists public.empresas_ventas_tendencia (
  rut text not null,
  dv text not null,
  rutid text generated always as (rut || dv) stored,
  razon_social_ultima text,
  anio_ultimo integer,
  tipo_contribuyente_ultimo text,
  subtipo_contribuyente_ultimo text,
  rubro_economico_ultimo text,
  subrubro_economico_ultimo text,
  actividad_economica_ultima text,
  region_ultima text,
  provincia_ultima text,
  comuna_ultima text,
  fecha_termino_giro_ultima date,
  tramo_ventas_2020 integer,
  tramo_ventas_2021 integer,
  tramo_ventas_2022 integer,
  tramo_ventas_2023 integer,
  tramo_ventas_2024 integer,
  trabajadores_2020 integer,
  trabajadores_2021 integer,
  trabajadores_2022 integer,
  trabajadores_2023 integer,
  trabajadores_2024 integer,
  anios_con_tramo integer,
  primer_anio_con_tramo integer,
  ultimo_anio_con_tramo integer,
  primer_tramo_ventas integer,
  ultimo_tramo_ventas integer,
  tramo_ventas_promedio_2020_2024 numeric(10,2),
  cambio_promedio_anual_tramo numeric(10,4),
  pendiente_tendencia_tramo numeric(10,4),
  movimientos_alza integer,
  movimientos_baja integer,
  resultado_tendencia text not null,
  loaded_at timestamptz not null default now(),
  constraint empresas_ventas_tendencia_resultado_check
    check (resultado_tendencia in ('sube', 'baja', 'estable', 'sin_datos'))
);

create unique index if not exists idx_empresas_ventas_tendencia_rutid
  on public.empresas_ventas_tendencia (rutid);

create index if not exists idx_empresas_ventas_tendencia_resultado
  on public.empresas_ventas_tendencia (resultado_tendencia);

create index if not exists idx_empresas_ventas_tendencia_region
  on public.empresas_ventas_tendencia (region_ultima);

create index if not exists idx_empresas_ventas_tendencia_rubro
  on public.empresas_ventas_tendencia (rubro_economico_ultimo);

create index if not exists idx_empresas_ventas_tendencia_ultimo_anio
  on public.empresas_ventas_tendencia (anio_ultimo);

create index if not exists idx_empresas_ventas_tendencia_pendiente
  on public.empresas_ventas_tendencia (pendiente_tendencia_tramo);

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
values (
  'Empresas tendencia ventas 2020-2024',
  'empresas_ventas_tendencia',
  'Tendencia anual de tramo de ventas por RUT empresa calculada desde PUB_EMPRESAS_PJ_2020_A_2024.',
  'csv',
  'empresas_ventas_tendencia',
  'empresas_ventas_tendencia',
  'rutid',
  false,
  true,
  0,
  now(),
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
