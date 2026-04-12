-- ============================================================
-- EQUIFAX SCORING PIPELINE
-- Corridas auditables para refresh, entrenamiento y proyecciones
-- ============================================================

create table if not exists public.equifax_scoring_pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  trigger_source text not null default 'manual',
  trigger_mode text not null default 'safe',
  status text not null default 'running'
    check (status in ('running', 'success', 'failed')),
  refreshed_rutids integer not null default 0,
  refreshed_batches integer not null default 0,
  models_trained integer not null default 0,
  activated_targets text[] not null default '{}'::text[],
  model_version text,
  training_payload jsonb not null default '{}'::jsonb,
  projection_payload jsonb not null default '{}'::jsonb,
  notes text,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_equifax_scoring_pipeline_runs_status
  on public.equifax_scoring_pipeline_runs (status, created_at desc);

create index if not exists idx_equifax_scoring_pipeline_runs_trigger
  on public.equifax_scoring_pipeline_runs (trigger_source, started_at desc);

grant select, insert, update, delete on public.equifax_scoring_pipeline_runs to authenticated;
