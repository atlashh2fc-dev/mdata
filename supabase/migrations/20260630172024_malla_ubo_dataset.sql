create extension if not exists pg_trgm;

create table if not exists public.malla_ubo (
  id bigserial primary key,
  rutid_sociedad text not null,
  nombre_sociedad text,
  etapa integer,
  rutid_socio text not null,
  nombre_socio text,
  rutid_sociedad_norm text generated always as (upper(ltrim(regexp_replace(coalesce(rutid_sociedad, ''), '[^0-9Kk]', '', 'g'), '0'))) stored,
  rutid_socio_norm text generated always as (upper(ltrim(regexp_replace(coalesce(rutid_socio, ''), '[^0-9Kk]', '', 'g'), '0'))) stored,
  source_file text not null default 'MALLA_UBO.txt',
  source_loaded_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_malla_ubo_sociedad_norm
  on public.malla_ubo (rutid_sociedad_norm);

create index if not exists idx_malla_ubo_socio_norm
  on public.malla_ubo (rutid_socio_norm);

create index if not exists idx_malla_ubo_sociedad_etapa
  on public.malla_ubo (rutid_sociedad_norm, etapa);

create index if not exists idx_malla_ubo_nombre_sociedad_trgm
  on public.malla_ubo using gin (nombre_sociedad gin_trgm_ops);

create index if not exists idx_malla_ubo_nombre_socio_trgm
  on public.malla_ubo using gin (nombre_socio gin_trgm_ops);

alter table public.malla_ubo enable row level security;

create table if not exists public.malla_ubo_empresas (
  rutid_sociedad_norm text primary key,
  rutid_sociedad_sample text,
  nombre_sociedad_ubo text,
  nombre_empresa_dataset text,
  etapa_min integer,
  etapa_max integer,
  socios_total integer,
  socios_directos integer,
  socios_indirectos integer,
  socios_persona_natural integer,
  socios_empresa integer,
  tiene_empresa_dataset boolean not null default false,
  source_names text[] not null default '{}'::text[],
  tramo_ventas_2024 integer,
  trabajadores_2024 integer,
  rubro_economico text,
  subrubro_economico text,
  actividad_economica text,
  region text,
  comuna text,
  refreshed_at timestamptz not null default now()
);

create index if not exists idx_malla_ubo_empresas_tiene_dataset
  on public.malla_ubo_empresas (tiene_empresa_dataset);

create index if not exists idx_malla_ubo_empresas_sources
  on public.malla_ubo_empresas using gin (source_names);

alter table public.malla_ubo_empresas enable row level security;

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
  'Malla UBO sociedades',
  'malla_ubo',
  'Malla de sociedades, socios y etapas UBO cargada desde MALLA_UBO.txt.',
  'csv',
  'malla_ubo',
  'malla_ubo',
  'id',
  false,
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
