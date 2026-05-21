-- Pipeline masivo de enriquecimiento web de contactos para empresas.
-- Mantiene cola, evidencia y resumen por RUT antes de promover datos al maestro.

alter table if exists public.company_contact_enrichment_cache
  add column if not exists rutid varchar(20);

create sequence if not exists public.company_web_enrichment_queue_id_seq;

create table if not exists public.company_web_enrichment_queue (
  id bigint primary key default nextval('public.company_web_enrichment_queue_id_seq'),
  rutid text not null unique,
  company_name text not null,
  normalized_name text not null,
  needs_email boolean not null default true,
  needs_phone boolean not null default true,
  existing_email text,
  existing_phone text,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'no_result', 'failed', 'skipped')),
  priority integer not null default 100,
  attempts integer not null default 0,
  locked_at timestamptz,
  locked_by text,
  completed_at timestamptz,
  last_error text,
  source text not null default 'empresas_comercial_unificada',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter sequence public.company_web_enrichment_queue_id_seq
  owned by public.company_web_enrichment_queue.id;

create index if not exists idx_company_web_enrichment_queue_status_priority
  on public.company_web_enrichment_queue (status, priority, created_at);

create index if not exists idx_company_web_enrichment_queue_locked_at
  on public.company_web_enrichment_queue (locked_at)
  where status = 'processing';

create table if not exists public.company_web_enrichment_results (
  rutid text primary key,
  match_key text not null,
  company_name text not null,
  website text,
  emails text[] not null default '{}'::text[],
  phones text[] not null default '{}'::text[],
  source_urls jsonb not null default '[]'::jsonb,
  enrichment_source text not null default 'none',
  search_provider text not null default 'none',
  status text not null default 'none'
    check (status in ('found', 'none', 'error')),
  promoted_to_master boolean not null default false,
  first_found_at timestamptz,
  searched_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb
);

create index if not exists idx_company_web_enrichment_results_status
  on public.company_web_enrichment_results (status, searched_at desc);

create index if not exists idx_company_web_enrichment_results_match_key
  on public.company_web_enrichment_results (match_key);

create or replace view public.company_web_enrichment_progress as
select
  count(*)::bigint as queued_total,
  count(*) filter (where status = 'queued')::bigint as queued,
  count(*) filter (where status = 'processing')::bigint as processing,
  count(*) filter (where status = 'completed')::bigint as completed,
  count(*) filter (where status = 'no_result')::bigint as no_result,
  count(*) filter (where status = 'failed')::bigint as failed,
  count(*) filter (where status = 'skipped')::bigint as skipped,
  count(*) filter (where needs_email)::bigint as needing_email,
  count(*) filter (where needs_phone)::bigint as needing_phone,
  max(updated_at) as last_queue_update
from public.company_web_enrichment_queue;

alter table public.company_web_enrichment_queue enable row level security;
alter table public.company_web_enrichment_results enable row level security;

grant select on public.company_web_enrichment_progress to authenticated, service_role;
grant select, insert, update, delete on public.company_web_enrichment_queue to service_role;
grant select, insert, update, delete on public.company_web_enrichment_results to service_role;
