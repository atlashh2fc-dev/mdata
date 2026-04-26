set statement_timeout = 0;

create table if not exists public.automoviles2025 (
  id bigserial primary key,
  ppu text,
  ppu_dv text,
  marca text,
  modelo text,
  tipo_vehiculo text,
  anio_fabricacion integer,
  fecha_transferencia date,
  color text,
  resto_color text,
  codigo_chassis text,
  codigo_motor text,
  clasificacion text,
  avaluo_fiscal numeric(18,2),
  avaluo_comercial numeric(18,2),
  rutid varchar(20) not null,
  nombre_razon_social text,
  paterno text,
  materno text,
  nombres text,
  tipo_rut text,
  loaded_at timestamptz not null default now()
);

create index if not exists idx_automoviles2025_rutid on public.automoviles2025 (rutid);
create index if not exists idx_automoviles2025_ppu on public.automoviles2025 (ppu);
create index if not exists idx_automoviles2025_marca_modelo on public.automoviles2025 (marca, modelo);
create index if not exists idx_automoviles2025_tipo_rut on public.automoviles2025 (tipo_rut);

insert into public.data_sources (
  name,
  slug,
  description,
  source_type,
  source_table_name,
  canonical_table,
  primary_key_column,
  is_active,
  record_count,
  last_loaded_at,
  last_job_status
)
values (
  'Automóviles 2025',
  'automoviles2025',
  'Detalle de vehículos con propietario, patente, marca, modelo y avalúos.',
  'mysql',
  'automoviles2025',
  'automoviles2025',
  'id',
  true,
  0,
  now(),
  'pending'
)
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  source_type = excluded.source_type,
  source_table_name = excluded.source_table_name,
  canonical_table = excluded.canonical_table,
  primary_key_column = excluded.primary_key_column,
  is_active = excluded.is_active,
  last_loaded_at = excluded.last_loaded_at,
  last_job_status = excluded.last_job_status;
