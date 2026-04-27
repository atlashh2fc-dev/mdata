-- ============================================================
-- Contact blacklist dataset
-- Telefonos erroneos del CRM + emails rebotados desde Atlas Lead
-- ============================================================

CREATE OR REPLACE VIEW public.contact_blacklist AS
WITH feedback_signals AS (
  SELECT
    f.*,
    LOWER(CONCAT_WS(
      ' ',
      f.outcome::text,
      f.outcome_subtype,
      f.outcome_reason,
      f.metadata::text,
      f.raw_payload::text
    )) AS signal_text
  FROM public.contact_center_feedback f
), blacklist_events AS (
  SELECT
    'phone'::TEXT AS contact_type,
    f.contact_phone AS contact_value,
    f.phone_normalized AS normalized_value,
    'telefono_erroneo_crm'::TEXT AS blacklist_reason,
    CASE WHEN f.external_source = 'vocal' THEN 'Vocal' ELSE 'CRM' END AS source_label,
    f.external_source,
    f.external_event_id,
    f.rutid,
    f.matched_rutid,
    f.channel::TEXT AS channel,
    f.outcome::TEXT AS outcome,
    f.outcome_subtype,
    f.outcome_reason,
    f.agent_name,
    f.campaign_name,
    f.managed_at,
    f.created_at,
    f.updated_at,
    f.metadata
  FROM feedback_signals f
  WHERE f.phone_normalized IS NOT NULL
    AND COALESCE(f.external_source, '') NOT IN ('atlas_lead_engine', 'atlas_lead_engine_bridge')
    AND (
      f.signal_text ~ '(n[uú]mero|numero|tel[eé]fono|telefono|fono|phone).*(equivocado|err[oó]neo|erroneo|incorrecto|inv[aá]lido|invalido|no existe|no corresponde|fuera de servicio|sin servicio|wrong|invalid)'
      OR f.signal_text ~ '(equivocado|err[oó]neo|erroneo|incorrecto|inv[aá]lido|invalido|no existe|no corresponde|fuera de servicio|sin servicio|wrong|invalid).*(n[uú]mero|numero|tel[eé]fono|telefono|fono|phone)'
    )

  UNION ALL

  SELECT
    'email'::TEXT AS contact_type,
    f.contact_email AS contact_value,
    f.email_normalized AS normalized_value,
    'email_rebotado_atlas'::TEXT AS blacklist_reason,
    'Atlas Lead'::TEXT AS source_label,
    f.external_source,
    f.external_event_id,
    f.rutid,
    f.matched_rutid,
    f.channel::TEXT AS channel,
    f.outcome::TEXT AS outcome,
    f.outcome_subtype,
    f.outcome_reason,
    f.agent_name,
    f.campaign_name,
    f.managed_at,
    f.created_at,
    f.updated_at,
    f.metadata
  FROM feedback_signals f
  WHERE f.email_normalized IS NOT NULL
    AND (
      f.external_source IN ('atlas_lead_engine', 'atlas_lead_engine_bridge')
      OR f.metadata->>'bridge_source' = 'atlas_lead_engine'
    )
    AND (
      f.outcome = 'bounced'
      OR f.signal_text ~ '(bounce|bounced|rebote|rebotado|rebotad[ao]|undeliverable|delivery failed)'
    )
), ranked_events AS (
  SELECT
    be.*,
    ROW_NUMBER() OVER (
      PARTITION BY be.contact_type, be.normalized_value
      ORDER BY be.managed_at DESC, be.updated_at DESC, be.external_event_id DESC
    ) AS event_rank,
    COUNT(*) OVER (PARTITION BY be.contact_type, be.normalized_value) AS event_count,
    MIN(be.managed_at) OVER (PARTITION BY be.contact_type, be.normalized_value) AS first_seen_at,
    MAX(be.managed_at) OVER (PARTITION BY be.contact_type, be.normalized_value) AS last_seen_at
  FROM blacklist_events be
)
SELECT
  MD5(CONCAT_WS('|', contact_type, normalized_value)) AS blacklist_key,
  contact_type,
  contact_value,
  normalized_value,
  blacklist_reason,
  source_label,
  external_source,
  external_event_id AS latest_external_event_id,
  COALESCE(matched_rutid, rutid) AS rutid,
  matched_rutid,
  channel,
  outcome,
  outcome_subtype,
  outcome_reason,
  agent_name,
  campaign_name,
  event_count,
  first_seen_at,
  last_seen_at,
  managed_at AS latest_event_at,
  metadata
FROM ranked_events
WHERE event_rank = 1;

INSERT INTO public.data_sources (
  name,
  slug,
  description,
  source_type,
  canonical_table,
  source_table_name,
  primary_key_column,
  supports_incremental,
  record_count,
  last_loaded_at,
  last_job_status,
  is_active
)
VALUES (
  'Blacklist contactos',
  'contact_blacklist',
  'Telefonos erroneos detectados en CRM y emails rebotados desde Atlas Lead. No incluye no_contact generico.',
  'postgres',
  'contact_blacklist',
  'contact_blacklist',
  'blacklist_key',
  TRUE,
  (SELECT COUNT(*) FROM public.contact_blacklist),
  NOW(),
  'completed',
  TRUE
)
ON CONFLICT (slug) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  source_type = EXCLUDED.source_type,
  canonical_table = EXCLUDED.canonical_table,
  source_table_name = EXCLUDED.source_table_name,
  primary_key_column = EXCLUDED.primary_key_column,
  supports_incremental = EXCLUDED.supports_incremental,
  record_count = EXCLUDED.record_count,
  last_loaded_at = EXCLUDED.last_loaded_at,
  last_job_status = EXCLUDED.last_job_status,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

CREATE OR REPLACE FUNCTION public.refresh_contact_blacklist_dataset_metadata()
RETURNS VOID AS $$
BEGIN
  UPDATE public.data_sources
  SET
    record_count = (SELECT COUNT(*) FROM public.contact_blacklist),
    last_loaded_at = NOW(),
    last_job_status = 'completed',
    updated_at = NOW()
  WHERE slug = 'contact_blacklist';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.refresh_contact_blacklist_dataset_metadata_trigger()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM public.refresh_contact_blacklist_dataset_metadata();
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS refresh_contact_blacklist_dataset_metadata_on_feedback
  ON public.contact_center_feedback;

CREATE TRIGGER refresh_contact_blacklist_dataset_metadata_on_feedback
AFTER INSERT OR UPDATE OR DELETE ON public.contact_center_feedback
FOR EACH STATEMENT
EXECUTE FUNCTION public.refresh_contact_blacklist_dataset_metadata_trigger();

SELECT public.refresh_contact_blacklist_dataset_metadata();
