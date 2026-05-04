-- ============================================================
-- MIROFISH SCENARIO BRIDGE
-- Persistencia local para corridas de proyeccion multiagente
-- ============================================================

CREATE TABLE IF NOT EXISTS public.mirofish_scenario_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  scenario_scope TEXT NOT NULL DEFAULT 'commercial_brain',
  status TEXT NOT NULL DEFAULT 'draft',
  phase TEXT NOT NULL DEFAULT 'pack_built',
  simulation_requirement TEXT NOT NULL,
  hypothesis TEXT,
  additional_context TEXT,
  scenario_pack_markdown TEXT NOT NULL DEFAULT '',
  source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  remote_project_id TEXT,
  remote_graph_id TEXT,
  remote_graph_task_id TEXT,
  remote_simulation_id TEXT,
  remote_prepare_task_id TEXT,
  remote_report_task_id TEXT,
  remote_report_id TEXT,
  remote_status_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  report_markdown TEXT,
  report_summary TEXT,
  last_error TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mirofish_scenario_runs_scope_check
    CHECK (scenario_scope IN ('commercial_brain', 'portfolio', 'equifax')),
  CONSTRAINT mirofish_scenario_runs_status_check
    CHECK (status IN ('draft', 'running', 'completed', 'failed')),
  CONSTRAINT mirofish_scenario_runs_phase_check
    CHECK (
      phase IN (
        'pack_built',
        'graph_building',
        'graph_ready',
        'simulation_created',
        'simulation_preparing',
        'simulation_ready',
        'simulation_running',
        'simulation_completed',
        'report_generating',
        'report_ready'
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_mirofish_scenario_runs_status
  ON public.mirofish_scenario_runs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mirofish_scenario_runs_phase
  ON public.mirofish_scenario_runs (phase, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mirofish_scenario_runs_created_by
  ON public.mirofish_scenario_runs (created_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mirofish_scenario_runs_remote_project
  ON public.mirofish_scenario_runs (remote_project_id);

CREATE INDEX IF NOT EXISTS idx_mirofish_scenario_runs_remote_simulation
  ON public.mirofish_scenario_runs (remote_simulation_id);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.mirofish_scenario_runs
  TO authenticated;
