-- ============================================================
-- HH HORSE RACING INTELLIGENCE
-- Persistencia de historico, programas y proyecciones hipicas
-- ============================================================

CREATE TABLE IF NOT EXISTS public.hh_racing_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  adapter_status TEXT NOT NULL DEFAULT 'registered',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.hh_racing_meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id TEXT NOT NULL REFERENCES public.hh_racing_sources(id) ON DELETE RESTRICT,
  meeting_date DATE NOT NULL,
  hippodrome TEXT NOT NULL,
  description TEXT,
  meeting_number TEXT,
  scheduled_time TIME,
  program_url TEXT,
  program_status TEXT NOT NULL DEFAULT 'unknown',
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hh_racing_meetings_unique UNIQUE (source_id, meeting_date, hippodrome)
);

CREATE TABLE IF NOT EXISTS public.hh_racing_races (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id TEXT NOT NULL REFERENCES public.hh_racing_sources(id) ON DELETE RESTRICT,
  meeting_id UUID REFERENCES public.hh_racing_meetings(id) ON DELETE SET NULL,
  race_date DATE NOT NULL,
  hippodrome TEXT NOT NULL,
  race_number INTEGER NOT NULL,
  title TEXT,
  race_type TEXT,
  distance_meters INTEGER,
  surface TEXT,
  track_condition TEXT,
  participants_count INTEGER,
  winner TEXT,
  final_time TEXT,
  favorite TEXT,
  retirements TEXT,
  source_url TEXT NOT NULL DEFAULT '',
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hh_racing_races_unique UNIQUE (source_id, race_date, hippodrome, race_number, source_url)
);

CREATE TABLE IF NOT EXISTS public.hh_racing_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  race_id UUID REFERENCES public.hh_racing_races(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES public.hh_racing_sources(id) ON DELETE RESTRICT,
  source_url TEXT,
  race_date DATE NOT NULL,
  hippodrome TEXT NOT NULL,
  race_number INTEGER NOT NULL,
  horse TEXT NOT NULL,
  horse_key TEXT NOT NULL,
  final_position INTEGER,
  saddle_number INTEGER,
  jockey TEXT,
  jockey_key TEXT,
  trainer TEXT,
  trainer_key TEXT,
  stud TEXT,
  age INTEGER,
  age_sex TEXT,
  assigned_weight_kg NUMERIC,
  horse_weight_kg NUMERIC,
  jockey_weight_kg NUMERIC,
  dividend NUMERIC,
  beaten_margin TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hh_racing_results_unique UNIQUE (source_id, race_date, hippodrome, race_number, horse_key)
);

CREATE TABLE IF NOT EXISTS public.hh_racing_program_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id TEXT NOT NULL REFERENCES public.hh_racing_sources(id) ON DELETE RESTRICT,
  meeting_id UUID REFERENCES public.hh_racing_meetings(id) ON DELETE SET NULL,
  race_date DATE NOT NULL,
  hippodrome TEXT NOT NULL,
  race_number INTEGER NOT NULL,
  scheduled_time TEXT,
  program_url TEXT,
  horse TEXT NOT NULL,
  horse_key TEXT NOT NULL,
  saddle_number INTEGER,
  jockey TEXT,
  jockey_key TEXT,
  trainer TEXT,
  trainer_key TEXT,
  stud TEXT,
  age_sex TEXT,
  assigned_weight_kg NUMERIC,
  recent_positions JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_dividend NUMERIC,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hh_racing_program_entries_unique UNIQUE (source_id, race_date, hippodrome, race_number, horse_key)
);

CREATE TABLE IF NOT EXISTS public.hh_racing_prediction_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type TEXT NOT NULL DEFAULT 'week',
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  model_version TEXT NOT NULL DEFAULT 'hh-baseline-0.1',
  report_path TEXT,
  json_path TEXT,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.hh_racing_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.hh_racing_prediction_runs(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES public.hh_racing_sources(id) ON DELETE RESTRICT,
  race_date DATE NOT NULL,
  hippodrome TEXT NOT NULL,
  race_number INTEGER NOT NULL,
  horse TEXT NOT NULL,
  horse_key TEXT NOT NULL,
  saddle_number INTEGER,
  jockey TEXT,
  trainer TEXT,
  win_probability NUMERIC NOT NULL,
  podium_probability NUMERIC NOT NULL,
  risk TEXT NOT NULL,
  score NUMERIC,
  signal JSONB NOT NULL DEFAULT '{}'::jsonb,
  technical_comment TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hh_racing_predictions_unique UNIQUE (run_id, source_id, race_date, hippodrome, race_number, horse_key)
);

CREATE INDEX IF NOT EXISTS idx_hh_racing_meetings_date
  ON public.hh_racing_meetings (meeting_date DESC, hippodrome);

CREATE INDEX IF NOT EXISTS idx_hh_racing_races_date
  ON public.hh_racing_races (race_date DESC, hippodrome, race_number);

CREATE INDEX IF NOT EXISTS idx_hh_racing_results_horse
  ON public.hh_racing_results (horse_key, race_date DESC);

CREATE INDEX IF NOT EXISTS idx_hh_racing_results_jockey
  ON public.hh_racing_results (jockey_key, race_date DESC);

CREATE INDEX IF NOT EXISTS idx_hh_racing_results_trainer
  ON public.hh_racing_results (trainer_key, race_date DESC);

CREATE INDEX IF NOT EXISTS idx_hh_racing_program_entries_date
  ON public.hh_racing_program_entries (race_date, hippodrome, race_number);

CREATE INDEX IF NOT EXISTS idx_hh_racing_predictions_run
  ON public.hh_racing_predictions (run_id, race_date, race_number);

INSERT INTO public.hh_racing_sources (id, name, base_url, adapter_status, notes)
VALUES
  ('sporting', 'Valparaiso Sporting', 'https://www.sporting.cl', 'historical_and_program', 'HTML oficial parseable para resultados y programas.'),
  ('clubhipico', 'Club Hipico de Santiago', 'https://www.clubhipico.cl', 'program_pdf', 'Programa PDF via volante oficial; historico adapter pendiente.'),
  ('hipodromo-chile', 'Hipodromo Chile', 'https://hipodromo.cl', 'calendar_pdf', 'Calendario y PDFs Teletrak; historico adapter pendiente.'),
  ('concepcion', 'Club Hipico de Concepcion', 'https://www.clubhipicoconcepcion.cl', 'program_pdf_partial', 'Programa PDF Teletrak; parser fino pendiente.'),
  ('teletrak', 'Teletrak', 'https://teletrak.cl', 'calendar', 'Indice maestro de calendario y programas.')
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  base_url = EXCLUDED.base_url,
  adapter_status = EXCLUDED.adapter_status,
  notes = EXCLUDED.notes,
  updated_at = NOW();

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.hh_racing_sources,
     public.hh_racing_meetings,
     public.hh_racing_races,
     public.hh_racing_results,
     public.hh_racing_program_entries,
     public.hh_racing_prediction_runs,
     public.hh_racing_predictions
  TO authenticated;
