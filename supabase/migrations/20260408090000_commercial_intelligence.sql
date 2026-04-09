-- ============================================================
-- COMMERCIAL INTELLIGENCE LAYER
-- Feedback operativo, scoring incremental y estrategia de contacto
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'feedback_channel'
  ) THEN
    CREATE TYPE feedback_channel AS ENUM (
      'phone',
      'email',
      'whatsapp',
      'sms',
      'bot',
      'web',
      'in_person',
      'other'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'feedback_outcome'
  ) THEN
    CREATE TYPE feedback_outcome AS ENUM (
      'contacted',
      'no_contact',
      'interested',
      'callback',
      'rejected',
      'sale',
      'opened',
      'clicked',
      'bounced',
      'do_not_contact',
      'unknown'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'sync_run_status'
  ) THEN
    CREATE TYPE sync_run_status AS ENUM (
      'running',
      'completed',
      'failed',
      'partial'
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION normalize_feedback_email(value TEXT)
RETURNS TEXT AS $$
BEGIN
  IF value IS NULL OR BTRIM(value) = '' THEN
    RETURN NULL;
  END IF;

  RETURN LOWER(BTRIM(value));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION normalize_feedback_phone(value TEXT)
RETURNS TEXT AS $$
DECLARE
  digits TEXT;
BEGIN
  IF value IS NULL OR BTRIM(value) = '' THEN
    RETURN NULL;
  END IF;

  digits := REGEXP_REPLACE(value, '[^0-9]', '', 'g');
  IF digits = '' THEN
    RETURN NULL;
  END IF;

  IF LENGTH(digits) = 8 THEN
    RETURN '+569' || digits;
  ELSIF LENGTH(digits) = 9 AND LEFT(digits, 1) = '9' THEN
    RETURN '+56' || digits;
  ELSIF LENGTH(digits) = 11 AND LEFT(digits, 2) = '56' THEN
    RETURN '+' || digits;
  ELSIF LEFT(digits, 3) = '569' THEN
    RETURN '+' || digits;
  END IF;

  RETURN '+' || digits;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION normalize_feedback_rutid(value TEXT)
RETURNS VARCHAR(20) AS $$
DECLARE
  cleaned TEXT;
BEGIN
  IF value IS NULL OR BTRIM(value) = '' THEN
    RETURN NULL;
  END IF;

  cleaned := UPPER(REGEXP_REPLACE(value, '[.\-\s]', '', 'g'));
  IF LENGTH(cleaned) < 2 THEN
    RETURN NULL;
  END IF;

  RETURN LPAD(cleaned, 10, '0');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE TABLE IF NOT EXISTS external_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'api',
  status sync_run_status NOT NULL DEFAULT 'running',
  requested_from TIMESTAMPTZ,
  requested_to TIMESTAMPTZ,
  cursor_value TEXT,
  records_fetched INTEGER NOT NULL DEFAULT 0,
  records_loaded INTEGER NOT NULL DEFAULT 0,
  affected_ruts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_external_sync_runs_source
  ON external_sync_runs (source_name, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_external_sync_runs_status
  ON external_sync_runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS contact_center_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_source TEXT NOT NULL DEFAULT 'registro_intel',
  external_event_id TEXT NOT NULL,
  external_record_type TEXT,
  rutid VARCHAR(20),
  matched_rutid VARCHAR(20),
  match_method TEXT,
  contact_phone TEXT,
  phone_normalized TEXT GENERATED ALWAYS AS (normalize_feedback_phone(contact_phone)) STORED,
  contact_email TEXT,
  email_normalized TEXT GENERATED ALWAYS AS (normalize_feedback_email(contact_email)) STORED,
  channel feedback_channel NOT NULL DEFAULT 'other',
  managed_at TIMESTAMPTZ NOT NULL,
  outcome feedback_outcome NOT NULL DEFAULT 'unknown',
  outcome_subtype TEXT,
  outcome_reason TEXT,
  direction TEXT,
  duration_seconds INTEGER,
  talk_seconds INTEGER,
  wait_seconds INTEGER,
  agent_id TEXT,
  agent_name TEXT,
  campaign_id TEXT,
  campaign_name TEXT,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  callback_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  sold_at TIMESTAMPTZ,
  value_amount NUMERIC(18,2),
  mail_opened BOOLEAN NOT NULL DEFAULT FALSE,
  clicked BOOLEAN NOT NULL DEFAULT FALSE,
  callback_requested BOOLEAN NOT NULL DEFAULT FALSE,
  interested BOOLEAN NOT NULL DEFAULT FALSE,
  contacted BOOLEAN NOT NULL DEFAULT FALSE,
  effective_contact BOOLEAN NOT NULL DEFAULT FALSE,
  sale BOOLEAN NOT NULL DEFAULT FALSE,
  is_best_management BOOLEAN NOT NULL DEFAULT FALSE,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (external_source, external_event_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_rutid
  ON contact_center_feedback (COALESCE(matched_rutid, rutid), managed_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_channel
  ON contact_center_feedback (channel, managed_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_campaign
  ON contact_center_feedback (campaign_name, managed_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_email
  ON contact_center_feedback (email_normalized);

CREATE INDEX IF NOT EXISTS idx_feedback_phone
  ON contact_center_feedback (phone_normalized);

CREATE INDEX IF NOT EXISTS idx_feedback_best_management
  ON contact_center_feedback (is_best_management, managed_at DESC)
  WHERE is_best_management = TRUE;

CREATE TABLE IF NOT EXISTS persona_contact_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rutid VARCHAR(20) NOT NULL REFERENCES master_personas(rutid) ON DELETE CASCADE,
  contact_type TEXT NOT NULL CHECK (contact_type IN ('phone', 'email')),
  contact_value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_priority INTEGER NOT NULL DEFAULT 50,
  quality_score INTEGER NOT NULL DEFAULT 50,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  is_deliverable BOOLEAN,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_feedback_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rutid, contact_type, normalized_value)
);

CREATE INDEX IF NOT EXISTS idx_persona_contact_points_rutid
  ON persona_contact_points (rutid, contact_type, is_primary DESC, quality_score DESC);

CREATE INDEX IF NOT EXISTS idx_persona_contact_points_normalized
  ON persona_contact_points (contact_type, normalized_value);

CREATE TABLE IF NOT EXISTS persona_scores (
  rutid VARCHAR(20) PRIMARY KEY REFERENCES master_personas(rutid) ON DELETE CASCADE,
  contactability_score INTEGER NOT NULL DEFAULT 0,
  purchase_propensity_score INTEGER NOT NULL DEFAULT 0,
  priority_score INTEGER NOT NULL DEFAULT 0,
  best_channel feedback_channel NOT NULL DEFAULT 'other',
  best_contact_hour SMALLINT,
  best_phone TEXT,
  best_email TEXT,
  next_best_action TEXT NOT NULL DEFAULT 'contactar',
  action_priority TEXT NOT NULL DEFAULT 'normal',
  should_contact BOOLEAN NOT NULL DEFAULT TRUE,
  total_interactions INTEGER NOT NULL DEFAULT 0,
  effective_contacts INTEGER NOT NULL DEFAULT 0,
  no_contact_events INTEGER NOT NULL DEFAULT 0,
  interest_events INTEGER NOT NULL DEFAULT 0,
  callback_events INTEGER NOT NULL DEFAULT 0,
  sales_events INTEGER NOT NULL DEFAULT 0,
  opened_events INTEGER NOT NULL DEFAULT 0,
  clicked_events INTEGER NOT NULL DEFAULT 0,
  best_management_events INTEGER NOT NULL DEFAULT 0,
  known_phone_count INTEGER NOT NULL DEFAULT 0,
  known_email_count INTEGER NOT NULL DEFAULT 0,
  last_contact_at TIMESTAMPTZ,
  last_sale_at TIMESTAMPTZ,
  last_feedback_at TIMESTAMPTZ,
  feedback_coverage BOOLEAN NOT NULL DEFAULT FALSE,
  signal_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_persona_scores_priority
  ON persona_scores (priority_score DESC, purchase_propensity_score DESC, contactability_score DESC);

CREATE INDEX IF NOT EXISTS idx_persona_scores_channel
  ON persona_scores (best_channel, next_best_action, priority_score DESC);

CREATE OR REPLACE FUNCTION refresh_persona_scores(p_rutids VARCHAR[] DEFAULT NULL)
RETURNS INTEGER AS $$
DECLARE
  affected_count INTEGER := 0;
BEGIN
  WITH candidate_ruts AS (
    SELECT mp.rutid
    FROM master_personas mp
    WHERE p_rutids IS NULL OR mp.rutid = ANY(p_rutids)
  ),
  feedback_agg AS (
    SELECT
      COALESCE(f.matched_rutid, f.rutid) AS rutid,
      COUNT(*) AS total_interactions,
      COUNT(*) FILTER (WHERE f.effective_contact) AS effective_contacts,
      COUNT(*) FILTER (WHERE f.contacted AND NOT f.effective_contact) AS contacted_without_effective,
      COUNT(*) FILTER (WHERE f.outcome = 'no_contact') AS no_contact_events,
      COUNT(*) FILTER (WHERE f.interested OR f.outcome = 'interested') AS interest_events,
      COUNT(*) FILTER (WHERE f.callback_requested OR f.outcome = 'callback') AS callback_events,
      COUNT(*) FILTER (WHERE f.sale OR f.outcome = 'sale') AS sales_events,
      COUNT(*) FILTER (WHERE f.mail_opened OR f.outcome = 'opened') AS opened_events,
      COUNT(*) FILTER (WHERE f.clicked OR f.outcome = 'clicked') AS clicked_events,
      COUNT(*) FILTER (WHERE f.is_best_management) AS best_management_events,
      MAX(f.managed_at) AS last_contact_at,
      MAX(f.sold_at) AS last_sale_at,
      MAX(f.managed_at) AS last_feedback_at
    FROM contact_center_feedback f
    INNER JOIN candidate_ruts c
      ON c.rutid = COALESCE(f.matched_rutid, f.rutid)
    GROUP BY COALESCE(f.matched_rutid, f.rutid)
  ),
  channel_ranked AS (
    SELECT DISTINCT ON (rutid)
      rutid,
      channel
    FROM (
      SELECT
        COALESCE(f.matched_rutid, f.rutid) AS rutid,
        f.channel,
        (
          COUNT(*) FILTER (WHERE f.effective_contact) * 3 +
          COUNT(*) FILTER (WHERE f.sale OR f.outcome = 'sale') * 6 +
          COUNT(*) FILTER (WHERE f.interested OR f.outcome = 'interested') * 2 +
          COUNT(*) FILTER (WHERE f.callback_requested OR f.outcome = 'callback') * 2 -
          COUNT(*) FILTER (WHERE f.outcome = 'no_contact')
        )::NUMERIC / GREATEST(COUNT(*), 1) AS channel_score
      FROM contact_center_feedback f
      INNER JOIN candidate_ruts c
        ON c.rutid = COALESCE(f.matched_rutid, f.rutid)
      GROUP BY COALESCE(f.matched_rutid, f.rutid), f.channel
    ) ranked
    ORDER BY rutid, channel_score DESC, channel
  ),
  best_hour AS (
    SELECT DISTINCT ON (rutid)
      rutid,
      contact_hour
    FROM (
      SELECT
        COALESCE(f.matched_rutid, f.rutid) AS rutid,
        EXTRACT(HOUR FROM f.managed_at)::SMALLINT AS contact_hour,
        (
          COUNT(*) FILTER (WHERE f.effective_contact) * 2 +
          COUNT(*) FILTER (WHERE f.sale OR f.outcome = 'sale') * 4 +
          COUNT(*) FILTER (WHERE f.interested OR f.outcome = 'interested')
        ) AS hour_score
      FROM contact_center_feedback f
      INNER JOIN candidate_ruts c
        ON c.rutid = COALESCE(f.matched_rutid, f.rutid)
      GROUP BY COALESCE(f.matched_rutid, f.rutid), EXTRACT(HOUR FROM f.managed_at)
    ) scored
    ORDER BY rutid, hour_score DESC, contact_hour
  ),
  phone_choice AS (
    SELECT DISTINCT ON (pcp.rutid)
      pcp.rutid,
      pcp.contact_value AS best_phone
    FROM persona_contact_points pcp
    INNER JOIN candidate_ruts c ON c.rutid = pcp.rutid
    WHERE pcp.contact_type = 'phone'
    ORDER BY pcp.rutid, pcp.is_primary DESC, pcp.quality_score DESC, pcp.last_seen_at DESC
  ),
  email_choice AS (
    SELECT DISTINCT ON (pcp.rutid)
      pcp.rutid,
      pcp.contact_value AS best_email
    FROM persona_contact_points pcp
    INNER JOIN candidate_ruts c ON c.rutid = pcp.rutid
    WHERE pcp.contact_type = 'email'
    ORDER BY pcp.rutid, pcp.is_primary DESC, pcp.quality_score DESC, pcp.last_seen_at DESC
  ),
  contact_points_agg AS (
    SELECT
      pcp.rutid,
      COUNT(*) FILTER (WHERE pcp.contact_type = 'phone') AS known_phone_count,
      COUNT(*) FILTER (WHERE pcp.contact_type = 'email') AS known_email_count
    FROM persona_contact_points pcp
    INNER JOIN candidate_ruts c ON c.rutid = pcp.rutid
    GROUP BY pcp.rutid
  ),
  score_rows AS (
    SELECT
      c.rutid,
      LEAST(
        100,
        GREATEST(
          0,
          ROUND(
            (
              CASE WHEN COALESCE(cp.known_phone_count, 0) > 0 OR mpv.fono_cel IS NOT NULL THEN 18 ELSE 0 END +
              CASE WHEN COALESCE(cp.known_phone_count, 0) > 1 THEN 8 ELSE 0 END +
              CASE WHEN COALESCE(cp.known_email_count, 0) > 0 OR mpv.email IS NOT NULL THEN 10 ELSE 0 END +
              COALESCE(mpv.cobertura_pct, 0) * 0.12 +
              CASE
                WHEN COALESCE(fa.total_interactions, 0) > 0
                THEN (fa.effective_contacts::NUMERIC / fa.total_interactions) * 35
                ELSE 0
              END +
              CASE
                WHEN COALESCE(fa.total_interactions, 0) > 0
                THEN (fa.opened_events::NUMERIC / fa.total_interactions) * 10
                ELSE 0
              END +
              CASE
                WHEN COALESCE(fa.total_interactions, 0) > 0
                THEN (fa.callback_events::NUMERIC / fa.total_interactions) * 10
                ELSE 0
              END -
              CASE
                WHEN COALESCE(fa.total_interactions, 0) > 0
                THEN (fa.no_contact_events::NUMERIC / fa.total_interactions) * 18
                ELSE 0
              END
            ),
            0
          )::INTEGER
        )
      ) AS contactability_score,
      LEAST(
        100,
        GREATEST(
          0,
          ROUND(
            (
              COALESCE(mpv.score_patrimonial, 0) * 0.42 +
              CASE WHEN mpv.tiene_empresa THEN 8 ELSE 0 END +
              CASE WHEN mpv.tiene_bienes_raices THEN 8 ELSE 0 END +
              CASE WHEN mpv.tiene_autos THEN 5 ELSE 0 END +
              CASE
                WHEN COALESCE(fa.total_interactions, 0) > 0
                THEN (fa.sales_events::NUMERIC / fa.total_interactions) * 30
                ELSE 0
              END +
              CASE
                WHEN COALESCE(fa.total_interactions, 0) > 0
                THEN (fa.interest_events::NUMERIC / fa.total_interactions) * 18
                ELSE 0
              END +
              CASE
                WHEN COALESCE(fa.total_interactions, 0) > 0
                THEN (fa.clicked_events::NUMERIC / fa.total_interactions) * 12
                ELSE 0
              END +
              CASE
                WHEN COALESCE(fa.total_interactions, 0) > 0
                THEN (fa.best_management_events::NUMERIC / fa.total_interactions) * 8
                ELSE 0
              END
            ),
            0
          )::INTEGER
        )
      ) AS purchase_propensity_score,
      COALESCE(cr.channel, CASE
        WHEN COALESCE(cp.known_phone_count, 0) > 0 OR mpv.fono_cel IS NOT NULL THEN 'phone'::feedback_channel
        WHEN COALESCE(cp.known_email_count, 0) > 0 OR mpv.email IS NOT NULL THEN 'email'::feedback_channel
        ELSE 'other'::feedback_channel
      END) AS best_channel,
      COALESCE(bh.contact_hour, 10) AS best_contact_hour,
      COALESCE(pc.best_phone, mpv.fono_cel) AS best_phone,
      COALESCE(ec.best_email, mpv.email) AS best_email,
      COALESCE(fa.total_interactions, 0) AS total_interactions,
      COALESCE(fa.effective_contacts, 0) AS effective_contacts,
      COALESCE(fa.no_contact_events, 0) AS no_contact_events,
      COALESCE(fa.interest_events, 0) AS interest_events,
      COALESCE(fa.callback_events, 0) AS callback_events,
      COALESCE(fa.sales_events, 0) AS sales_events,
      COALESCE(fa.opened_events, 0) AS opened_events,
      COALESCE(fa.clicked_events, 0) AS clicked_events,
      COALESCE(fa.best_management_events, 0) AS best_management_events,
      COALESCE(cp.known_phone_count, 0) + CASE WHEN mpv.fono_cel IS NOT NULL THEN 1 ELSE 0 END AS known_phone_count,
      COALESCE(cp.known_email_count, 0) + CASE WHEN mpv.email IS NOT NULL THEN 1 ELSE 0 END AS known_email_count,
      fa.last_contact_at,
      fa.last_sale_at,
      fa.last_feedback_at,
      COALESCE(fa.total_interactions, 0) > 0 AS feedback_coverage,
      jsonb_strip_nulls(
        jsonb_build_object(
          'score_patrimonial', COALESCE(mpv.score_patrimonial, 0),
          'cobertura_pct', COALESCE(mpv.cobertura_pct, 0),
          'tiene_empresa', COALESCE(mpv.tiene_empresa, FALSE),
          'tiene_bienes_raices', COALESCE(mpv.tiene_bienes_raices, FALSE),
          'tiene_autos', COALESCE(mpv.tiene_autos, FALSE),
          'contact_rate', CASE
            WHEN COALESCE(fa.total_interactions, 0) > 0
            THEN ROUND((fa.effective_contacts::NUMERIC / fa.total_interactions), 4)
            ELSE 0
          END,
          'sale_rate', CASE
            WHEN COALESCE(fa.total_interactions, 0) > 0
            THEN ROUND((fa.sales_events::NUMERIC / fa.total_interactions), 4)
            ELSE 0
          END,
          'interest_rate', CASE
            WHEN COALESCE(fa.total_interactions, 0) > 0
            THEN ROUND((fa.interest_events::NUMERIC / fa.total_interactions), 4)
            ELSE 0
          END,
          'known_phone_count', COALESCE(cp.known_phone_count, 0),
          'known_email_count', COALESCE(cp.known_email_count, 0),
          'best_management_events', COALESCE(fa.best_management_events, 0)
        )
      ) AS signal_summary
    FROM candidate_ruts c
    LEFT JOIN master_personas_view mpv ON mpv.rutid = c.rutid
    LEFT JOIN feedback_agg fa ON fa.rutid = c.rutid
    LEFT JOIN channel_ranked cr ON cr.rutid = c.rutid
    LEFT JOIN best_hour bh ON bh.rutid = c.rutid
    LEFT JOIN contact_points_agg cp ON cp.rutid = c.rutid
    LEFT JOIN phone_choice pc ON pc.rutid = c.rutid
    LEFT JOIN email_choice ec ON ec.rutid = c.rutid
  )
  INSERT INTO persona_scores (
    rutid,
    contactability_score,
    purchase_propensity_score,
    priority_score,
    best_channel,
    best_contact_hour,
    best_phone,
    best_email,
    next_best_action,
    action_priority,
    should_contact,
    total_interactions,
    effective_contacts,
    no_contact_events,
    interest_events,
    callback_events,
    sales_events,
    opened_events,
    clicked_events,
    best_management_events,
    known_phone_count,
    known_email_count,
    last_contact_at,
    last_sale_at,
    last_feedback_at,
    feedback_coverage,
    signal_summary,
    updated_at
  )
  SELECT
    sr.rutid,
    sr.contactability_score,
    sr.purchase_propensity_score,
    LEAST(
      100,
      ROUND(
        (sr.contactability_score * 0.45 + sr.purchase_propensity_score * 0.55),
        0
      )::INTEGER
    ) AS priority_score,
    sr.best_channel,
    sr.best_contact_hour,
    sr.best_phone,
    sr.best_email,
    CASE
      WHEN sr.sales_events > 0 AND sr.last_sale_at > NOW() - INTERVAL '45 days' THEN 'enfriar'
      WHEN sr.interest_events > 0 AND sr.callback_events > 0 THEN 'escalar'
      WHEN sr.contactability_score >= 65 AND sr.purchase_propensity_score >= 65 THEN 'insistir'
      WHEN sr.no_contact_events >= 3 AND sr.contactability_score < 35 THEN 'enfriar'
      WHEN sr.contactability_score >= 50 THEN 'contactar'
      ELSE 'enriquecer'
    END AS next_best_action,
    CASE
      WHEN (sr.contactability_score * 0.45 + sr.purchase_propensity_score * 0.55) >= 80 THEN 'alta'
      WHEN (sr.contactability_score * 0.45 + sr.purchase_propensity_score * 0.55) >= 60 THEN 'media'
      ELSE 'baja'
    END AS action_priority,
    CASE
      WHEN sr.sales_events > 0 AND sr.last_sale_at > NOW() - INTERVAL '45 days' THEN FALSE
      WHEN sr.no_contact_events >= 5 AND sr.contactability_score < 25 THEN FALSE
      ELSE TRUE
    END AS should_contact,
    sr.total_interactions,
    sr.effective_contacts,
    sr.no_contact_events,
    sr.interest_events,
    sr.callback_events,
    sr.sales_events,
    sr.opened_events,
    sr.clicked_events,
    sr.best_management_events,
    sr.known_phone_count,
    sr.known_email_count,
    sr.last_contact_at,
    sr.last_sale_at,
    sr.last_feedback_at,
    sr.feedback_coverage,
    sr.signal_summary,
    NOW()
  FROM score_rows sr
  ON CONFLICT (rutid) DO UPDATE
  SET
    contactability_score = EXCLUDED.contactability_score,
    purchase_propensity_score = EXCLUDED.purchase_propensity_score,
    priority_score = EXCLUDED.priority_score,
    best_channel = EXCLUDED.best_channel,
    best_contact_hour = EXCLUDED.best_contact_hour,
    best_phone = EXCLUDED.best_phone,
    best_email = EXCLUDED.best_email,
    next_best_action = EXCLUDED.next_best_action,
    action_priority = EXCLUDED.action_priority,
    should_contact = EXCLUDED.should_contact,
    total_interactions = EXCLUDED.total_interactions,
    effective_contacts = EXCLUDED.effective_contacts,
    no_contact_events = EXCLUDED.no_contact_events,
    interest_events = EXCLUDED.interest_events,
    callback_events = EXCLUDED.callback_events,
    sales_events = EXCLUDED.sales_events,
    opened_events = EXCLUDED.opened_events,
    clicked_events = EXCLUDED.clicked_events,
    best_management_events = EXCLUDED.best_management_events,
    known_phone_count = EXCLUDED.known_phone_count,
    known_email_count = EXCLUDED.known_email_count,
    last_contact_at = EXCLUDED.last_contact_at,
    last_sale_at = EXCLUDED.last_sale_at,
    last_feedback_at = EXCLUDED.last_feedback_at,
    feedback_coverage = EXCLUDED.feedback_coverage,
    signal_summary = EXCLUDED.signal_summary,
    updated_at = NOW();

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RETURN affected_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE VIEW commercial_intelligence_overview AS
SELECT
  COUNT(*) AS total_scored_personas,
  COUNT(*) FILTER (WHERE feedback_coverage) AS with_feedback,
  COUNT(*) FILTER (WHERE action_priority = 'alta') AS high_priority_personas,
  COUNT(*) FILTER (WHERE best_channel = 'phone') AS recommended_phone,
  COUNT(*) FILTER (WHERE best_channel = 'email') AS recommended_email,
  ROUND(AVG(contactability_score)::NUMERIC, 2) AS avg_contactability_score,
  ROUND(AVG(purchase_propensity_score)::NUMERIC, 2) AS avg_purchase_propensity_score,
  ROUND(AVG(priority_score)::NUMERIC, 2) AS avg_priority_score,
  MAX(updated_at) AS last_score_refresh,
  (SELECT MAX(completed_at) FROM external_sync_runs WHERE source_name = 'registro_intel' AND status IN ('completed', 'partial')) AS last_feedback_sync
FROM persona_scores;

SELECT refresh_persona_scores(NULL);
