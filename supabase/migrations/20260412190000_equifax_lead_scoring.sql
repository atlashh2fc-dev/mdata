-- ============================================================
-- EQUIFAX LEAD SCORING
-- Features, modelos y scores para contactabilidad/interes/compra
-- ============================================================

create table if not exists public.equifax_scoring_models (
  id uuid primary key default gen_random_uuid(),
  model_key text not null,
  model_version text not null,
  model_type text not null check (model_type in ('heuristic', 'logistic', 'hybrid')),
  target text not null check (target in ('contact', 'interest', 'purchase')),
  is_active boolean not null default false,
  trained_rows integer not null default 0,
  feature_names text[] not null default '{}'::text[],
  coefficients jsonb not null default '{}'::jsonb,
  intercept numeric(12,6) not null default 0,
  metrics jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  trained_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (model_key, model_version, target)
);

create index if not exists idx_equifax_scoring_models_active
  on public.equifax_scoring_models (model_key, target, is_active, trained_at desc);

create table if not exists public.equifax_lead_features (
  rutid varchar(20) primary key,
  company_name text,
  region text,
  comuna text,
  is_existing_customer boolean not null default false,
  equifax_sales_count integer not null default 0,
  equifax_recurrent_sales_count integer not null default 0,
  equifax_one_time_sales_count integer not null default 0,
  equifax_total_amount numeric(18,2) not null default 0,
  last_equifax_sale_at timestamptz,
  known_phone_count integer not null default 0,
  known_email_count integer not null default 0,
  best_channel text,
  best_contact_hour smallint,
  feedback_total_interactions integer not null default 0,
  feedback_equifax_interactions integer not null default 0,
  effective_contacts integer not null default 0,
  no_contact_events integer not null default 0,
  interest_events integer not null default 0,
  callback_events integer not null default 0,
  sales_events integer not null default 0,
  opened_events integer not null default 0,
  clicked_events integer not null default 0,
  best_management_events integer not null default 0,
  last_feedback_at timestamptz,
  last_contact_at timestamptz,
  last_interest_at timestamptz,
  last_sale_feedback_at timestamptz,
  days_since_last_feedback integer,
  days_since_last_contact integer,
  days_since_last_interest integer,
  days_since_last_sale_feedback integer,
  score_patrimonial numeric(10,2) not null default 0,
  cobertura_pct numeric(10,2) not null default 0,
  totalavaluos numeric(18,2) not null default 0,
  n_autos integer not null default 0,
  n_bienes_raices integer not null default 0,
  contact_rate numeric(8,4) not null default 0,
  interest_rate numeric(8,4) not null default 0,
  callback_rate numeric(8,4) not null default 0,
  sale_rate numeric(8,4) not null default 0,
  no_contact_rate numeric(8,4) not null default 0,
  email_open_rate numeric(8,4) not null default 0,
  email_click_rate numeric(8,4) not null default 0,
  equifax_contact_share numeric(8,4) not null default 0,
  feature_payload jsonb not null default '{}'::jsonb,
  label_contact boolean not null default false,
  label_interest boolean not null default false,
  label_purchase boolean not null default false,
  feature_version text not null default 'v1',
  refreshed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_equifax_lead_features_customer
  on public.equifax_lead_features (is_existing_customer, refreshed_at desc);

create index if not exists idx_equifax_lead_features_labels
  on public.equifax_lead_features (label_contact, label_interest, label_purchase);

create table if not exists public.equifax_lead_scores (
  rutid varchar(20) primary key,
  company_name text,
  model_version text not null default 'heuristic-v1',
  model_type text not null default 'heuristic' check (model_type in ('heuristic', 'logistic', 'hybrid')),
  contact_probability numeric(6,2) not null default 0,
  interest_probability numeric(6,2) not null default 0,
  purchase_probability numeric(6,2) not null default 0,
  fit_score numeric(6,2) not null default 0,
  lead_score numeric(6,2) not null default 0,
  lead_temperature text not null default 'red' check (lead_temperature in ('green', 'yellow', 'red')),
  recommended_channel text,
  recommended_hour smallint,
  reason_tags jsonb not null default '[]'::jsonb,
  score_breakdown jsonb not null default '{}'::jsonb,
  feature_snapshot jsonb not null default '{}'::jsonb,
  scored_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_equifax_lead_scores_temperature
  on public.equifax_lead_scores (lead_temperature, lead_score desc);

create index if not exists idx_equifax_lead_scores_score
  on public.equifax_lead_scores (lead_score desc, contact_probability desc, purchase_probability desc);

alter table public.equifax_generation_run_items
  add column if not exists contact_probability numeric(6,2) not null default 0,
  add column if not exists interest_probability numeric(6,2) not null default 0,
  add column if not exists purchase_probability numeric(6,2) not null default 0,
  add column if not exists lead_score numeric(6,2) not null default 0,
  add column if not exists lead_temperature text not null default 'red',
  add column if not exists recommended_channel text,
  add column if not exists recommended_hour smallint;

create index if not exists idx_equifax_generation_run_items_temperature
  on public.equifax_generation_run_items (run_id, lead_temperature, lead_score desc);

grant select, insert, update, delete on public.equifax_scoring_models to authenticated;
grant select, insert, update, delete on public.equifax_lead_features to authenticated;
grant select, insert, update, delete on public.equifax_lead_scores to authenticated;
