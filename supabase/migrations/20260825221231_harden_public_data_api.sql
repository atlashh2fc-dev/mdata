begin;

-- These 49 relations were reported as ERROR/rls_disabled_in_public by the
-- Security Advisor on 2026-08-25. Bigdata accesses them server-side with the
-- service role. The only direct authenticated consumer is the private HH page.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'equifax_product_catalog',
    'import_personas_master_stage',
    'persona_contact_points_rebuild_stage',
    'personas_master_rutid_map',
    'personas_master_rebuild_stage',
    '_bbrr_rollup_work',
    'ingestion_logs',
    'company_contact_enrichment_cache',
    'equifax_bdd_credito_b2b',
    'segment_exports',
    'ai_analysis_logs',
    'company_name_lookup',
    'source_versions',
    '_padron2024_fix_keys',
    'persona_scores',
    'external_sync_runs',
    '_bdd_excl_rut',
    '_bdd_excl_tel',
    'persona_contact_points',
    'contact_center_feedback',
    'padron_personas_raw',
    'equifax_sales_history',
    'equifax_lead_features',
    'equifax_scoring_models',
    'equifax_generation_run_items',
    'equifax_scoring_pipeline_runs',
    'automoviles2025',
    'bbrr_propiedades',
    'ejecutivos',
    'equifax_lead_scores',
    'equifax_generation_runs',
    'wom_customer_signals',
    'empresas_ventas_tendencia',
    'geimser_mkt_7245_empresas',
    'hh_racing_sources',
    'hh_racing_meetings',
    'hh_racing_races',
    'hh_racing_results',
    'hh_racing_program_entries',
    'hh_racing_prediction_runs',
    'hh_racing_predictions',
    'company_web_enrichment_queue',
    'company_web_enrichment_results',
    '_bdd_emp',
    '_bdd_rescate',
    'equifax_bdd_5fonos',
    '_bdd_ntel',
    'empresa_telefonos',
    'equifax_bdd_5fonos_export'
  ]
  loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated', v_table);
    execute format('grant all on table public.%I to service_role', v_table);
  end loop;
end;
$$;

-- The authenticated HH page is the sole browser/session consumer among these
-- tables. Keep its current read path, scoped to the already enforced operator.
grant select on table
  public.hh_racing_sources,
  public.hh_racing_meetings,
  public.hh_racing_races,
  public.hh_racing_results,
  public.hh_racing_program_entries,
  public.hh_racing_prediction_runs,
  public.hh_racing_predictions
to authenticated;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'hh_racing_sources',
    'hh_racing_meetings',
    'hh_racing_races',
    'hh_racing_results',
    'hh_racing_program_entries',
    'hh_racing_prediction_runs',
    'hh_racing_predictions'
  ]
  loop
    execute format('drop policy if exists hh_operator_read on public.%I', v_table);
    execute format(
      'create policy hh_operator_read on public.%I for select to authenticated using (lower(coalesce((select auth.jwt()) ->> ''email'', '''')) = ''hh2fc24@gmail.com'')',
      v_table
    );
  end loop;
end;
$$;

-- These ten views were reported as ERROR/security_definer_view. All current
-- Bigdata call sites use service_role, so invoker semantics preserve their
-- behavior while preventing the owner from bypassing underlying RLS.
do $$
declare
  v_view text;
begin
  foreach v_view in array array[
    'equifax_sales_company_summary',
    'company_best_executive_contact',
    'empresas_comercial_unificada',
    'master_personas_view',
    'commercial_intelligence_overview',
    'master_personas',
    'personas_master_clasificada',
    'contact_blacklist',
    'company_web_enrichment_progress',
    'dataset_overview'
  ]
  loop
    execute format('alter view public.%I set (security_invoker = true)', v_view);
    execute format('revoke all on table public.%I from public, anon, authenticated', v_view);
    execute format('grant select on table public.%I to service_role', v_view);
  end loop;
end;
$$;

-- Harden only audited Bigdata SECURITY DEFINER functions. The Forum-owned
-- create_tenant_api_key function is intentionally excluded from this migration.
do $$
declare
  v_proc regprocedure;
begin
  for v_proc in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.proname = any(array[
        'audit_trigger_fn',
        'finalize_source_version',
        'get_bbrr_dashboard_usage_stats',
        'get_bbrr_destino_counts',
        'get_bbrr_uso_counts',
        'refresh_all_stats',
        'refresh_base_contact_dataset',
        'refresh_bbrr_uso_propiedad_por_rut',
        'refresh_contact_blacklist_dataset_metadata',
        'refresh_contact_blacklist_dataset_metadata_trigger',
        'refresh_dashboard_stats'
      ])
  loop
    execute format('alter function %s set search_path = public, extensions', v_proc);
    execute format('revoke all on function %s from public, anon, authenticated', v_proc);
    execute format('grant execute on function %s to service_role', v_proc);
  end loop;
end;
$$;

commit;
