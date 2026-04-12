-- ============================================================
-- EQUIFAX BDD
-- Histórico comercial, catálogo de productos y corridas de leads
-- ============================================================

create table if not exists public.equifax_sales_history (
  id uuid primary key default gen_random_uuid(),
  source_file text not null,
  source_sheet text not null,
  source_row_number integer not null,
  sale_kind text not null check (sale_kind in ('recurrente', 'one_time')),
  mes timestamptz,
  rut_raw text,
  rutid varchar(20),
  cliente text,
  fecha_venta timestamptz,
  ejecutiva text,
  origen text,
  servicio text,
  servicio_normalized text,
  valor numeric(18,2),
  periodo integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_file, source_sheet, source_row_number)
);

create index if not exists idx_equifax_sales_history_rutid
  on public.equifax_sales_history (rutid, fecha_venta desc);

create index if not exists idx_equifax_sales_history_service
  on public.equifax_sales_history (servicio_normalized, fecha_venta desc);

create table if not exists public.equifax_product_catalog (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text,
  description text,
  target_rubro text,
  target_company_keywords text[] not null default '{}'::text[],
  pain_points text[] not null default '{}'::text[],
  pricing_notes text,
  filters jsonb not null default '{}'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_equifax_product_catalog_active
  on public.equifax_product_catalog (is_active, created_at desc);

create table if not exists public.equifax_generation_runs (
  id uuid primary key default gen_random_uuid(),
  requested_volume integer not null default 1000,
  include_existing_customers boolean not null default true,
  minimum_phone_count integer not null default 1,
  minimum_email_count integer not null default 0,
  product_catalog_ids uuid[] not null default '{}'::uuid[],
  product_payload jsonb not null default '[]'::jsonb,
  filter_payload jsonb not null default '{}'::jsonb,
  ai_profile jsonb not null default '{}'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_equifax_generation_runs_created
  on public.equifax_generation_runs (created_at desc);

create table if not exists public.equifax_generation_run_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.equifax_generation_runs(id) on delete cascade,
  rutid varchar(20) not null,
  company_name text not null,
  region text,
  comuna text,
  best_phone text,
  best_email text,
  phone_count integer not null default 0,
  email_count integer not null default 0,
  contactability_score numeric(6,2) not null default 0,
  purchase_propensity_score numeric(6,2) not null default 0,
  equifax_fit_score numeric(6,2) not null default 0,
  priority_score numeric(6,2) not null default 0,
  is_existing_customer boolean not null default false,
  last_equifax_sale_at timestamptz,
  services_bought text[] not null default '{}'::text[],
  reason_tags text[] not null default '{}'::text[],
  export_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, rutid)
);

create index if not exists idx_equifax_generation_run_items_run
  on public.equifax_generation_run_items (run_id, priority_score desc);

create index if not exists idx_equifax_generation_run_items_rutid
  on public.equifax_generation_run_items (rutid, created_at desc);

create or replace view public.equifax_sales_company_summary as
select
  rutid,
  max(cliente) as cliente,
  count(*)::integer as sales_count,
  count(*) filter (where sale_kind = 'recurrente')::integer as recurrent_sales_count,
  count(*) filter (where sale_kind = 'one_time')::integer as one_time_sales_count,
  coalesce(sum(valor), 0)::numeric(18,2) as total_amount,
  max(fecha_venta) as last_sale_at,
  array_remove(array_agg(distinct servicio), null) as services_bought
from public.equifax_sales_history
where rutid is not null
group by rutid;

grant select, insert, update, delete on public.equifax_sales_history to authenticated;
grant select, insert, update, delete on public.equifax_product_catalog to authenticated;
grant select, insert, update, delete on public.equifax_generation_runs to authenticated;
grant select, insert, update, delete on public.equifax_generation_run_items to authenticated;
grant select on public.equifax_sales_company_summary to authenticated;
