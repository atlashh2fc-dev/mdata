-- ============================================================
-- RUT INTELLIGENCE PLATFORM — INITIAL SCHEMA
-- Basado en supabase/schema.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";

CREATE TABLE IF NOT EXISTS master_personas (
  rutid        VARCHAR(20) PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_master_personas_rutid ON master_personas (rutid);

CREATE TABLE IF NOT EXISTS pernat_resumen (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rutid        VARCHAR(20) NOT NULL REFERENCES master_personas(rutid) ON DELETE CASCADE,
  nombres      VARCHAR(200),
  paterno      VARCHAR(100),
  materno      VARCHAR(100),
  email        VARCHAR(255),
  fono_cel     VARCHAR(20),
  comuna_part  VARCHAR(100),
  region_part  VARCHAR(100),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pernat_rutid     ON pernat_resumen (rutid);
CREATE INDEX IF NOT EXISTS idx_pernat_email     ON pernat_resumen (email);
CREATE INDEX IF NOT EXISTS idx_pernat_nombres   ON pernat_resumen USING gin(nombres gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_pernat_region    ON pernat_resumen (region_part);
CREATE INDEX IF NOT EXISTS idx_pernat_comuna    ON pernat_resumen (comuna_part);

CREATE TABLE IF NOT EXISTS autos_resumen (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rutid      VARCHAR(20) NOT NULL REFERENCES master_personas(rutid) ON DELETE CASCADE,
  n_autos    INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_autos_rutid ON autos_resumen (rutid);
CREATE INDEX IF NOT EXISTS idx_autos_n_autos      ON autos_resumen (n_autos);

CREATE TABLE IF NOT EXISTS empresa_resumen (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rutid                VARCHAR(20) NOT NULL REFERENCES master_personas(rutid) ON DELETE CASCADE,
  razon_social_empresa VARCHAR(500),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_empresa_rutid        ON empresa_resumen (rutid);
CREATE INDEX IF NOT EXISTS idx_empresa_razon_social ON empresa_resumen USING gin(razon_social_empresa gin_trgm_ops);

CREATE TABLE IF NOT EXISTS domicilio_resumen (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rutid      VARCHAR(20) NOT NULL REFERENCES master_personas(rutid) ON DELETE CASCADE,
  comuna     VARCHAR(100),
  region     VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_domicilio_rutid  ON domicilio_resumen (rutid);
CREATE INDEX IF NOT EXISTS idx_domicilio_region ON domicilio_resumen (region);
CREATE INDEX IF NOT EXISTS idx_domicilio_comuna ON domicilio_resumen (comuna);

CREATE TABLE IF NOT EXISTS acumulado_resumen (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rutid            VARCHAR(20) NOT NULL REFERENCES master_personas(rutid) ON DELETE CASCADE,
  n_bienes_raices  INTEGER DEFAULT 0,
  totalavaluos     NUMERIC(18,2) DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_acumulado_rutid    ON acumulado_resumen (rutid);
CREATE INDEX IF NOT EXISTS idx_acumulado_n_bienes_raices ON acumulado_resumen (n_bienes_raices);
CREATE INDEX IF NOT EXISTS idx_acumulado_totalavaluos    ON acumulado_resumen (totalavaluos);

CREATE OR REPLACE VIEW master_personas_view AS
SELECT
  mp.rutid,
  pr.nombres,
  pr.paterno,
  pr.materno,
  TRIM(CONCAT(COALESCE(pr.nombres,''), ' ', COALESCE(pr.paterno,''), ' ', COALESCE(pr.materno,''))) AS nombre_completo,
  pr.email,
  pr.fono_cel,
  pr.comuna_part,
  pr.region_part,
  COALESCE(ar.n_autos, 0) AS n_autos,
  CASE WHEN ar.n_autos > 0 THEN TRUE ELSE FALSE END AS tiene_autos,
  er.razon_social_empresa,
  CASE WHEN er.razon_social_empresa IS NOT NULL THEN TRUE ELSE FALSE END AS tiene_empresa,
  dr.comuna AS domicilio_comuna,
  dr.region AS domicilio_region,
  COALESCE(ac.n_bienes_raices, 0) AS n_bienes_raices,
  COALESCE(ac.totalavaluos, 0) AS totalavaluos,
  CASE WHEN ac.n_bienes_raices > 0 THEN TRUE ELSE FALSE END AS tiene_bienes_raices,
  (
    COALESCE(ar.n_autos, 0) * 10 +
    COALESCE(ac.n_bienes_raices, 0) * 20 +
    CASE WHEN er.razon_social_empresa IS NOT NULL THEN 15 ELSE 0 END +
    CASE WHEN pr.email IS NOT NULL THEN 5 ELSE 0 END +
    CASE WHEN pr.fono_cel IS NOT NULL THEN 5 ELSE 0 END
  )::INTEGER AS score_patrimonial,
  (
    (
      CASE WHEN pr.nombres IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN pr.email IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN pr.fono_cel IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN pr.region_part IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN ar.n_autos IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN er.razon_social_empresa IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN dr.region IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN ac.n_bienes_raices IS NOT NULL THEN 1 ELSE 0 END
    )::FLOAT / 8.0 * 100
  )::INTEGER AS cobertura_pct,
  mp.created_at,
  mp.updated_at
FROM master_personas mp
LEFT JOIN pernat_resumen pr ON pr.rutid = mp.rutid
LEFT JOIN autos_resumen ar ON ar.rutid = mp.rutid
LEFT JOIN empresa_resumen er ON er.rutid = mp.rutid
LEFT JOIN domicilio_resumen dr ON dr.rutid = mp.rutid
LEFT JOIN acumulado_resumen ac ON ac.rutid = mp.rutid;

CREATE TYPE ingestion_status AS ENUM (
  'pending', 'processing', 'validating', 'merging', 'completed', 'failed', 'cancelled'
);

CREATE TYPE source_type AS ENUM (
  'csv', 'xlsx', 'json', 'api', 'mysql', 'postgres'
);

CREATE TABLE IF NOT EXISTS data_sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  description   TEXT,
  source_type   source_type NOT NULL DEFAULT 'csv',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  config        JSONB DEFAULT '{}',
  created_by    UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_sources_active ON data_sources (is_active);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       UUID REFERENCES data_sources(id),
  file_name       VARCHAR(500),
  file_size       BIGINT,
  file_path       TEXT,
  status          ingestion_status NOT NULL DEFAULT 'pending',
  total_rows      INTEGER DEFAULT 0,
  valid_rows      INTEGER DEFAULT 0,
  invalid_rows    INTEGER DEFAULT 0,
  merged_rows     INTEGER DEFAULT 0,
  new_rows        INTEGER DEFAULT 0,
  error_message   TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status     ON ingestion_jobs (status);
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_source     ON ingestion_jobs (source_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_created_at ON ingestion_jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS ingestion_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  level       VARCHAR(10) NOT NULL DEFAULT 'info',
  message     TEXT NOT NULL,
  row_number  INTEGER,
  raw_data    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_logs_job   ON ingestion_logs (job_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_logs_level ON ingestion_logs (level);
CREATE INDEX IF NOT EXISTS idx_ingestion_logs_ts    ON ingestion_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS source_column_mappings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  source_column VARCHAR(255) NOT NULL,
  target_table  VARCHAR(100) NOT NULL,
  target_column VARCHAR(100) NOT NULL,
  transform_fn  VARCHAR(100),
  is_rut_column BOOLEAN NOT NULL DEFAULT FALSE,
  is_required   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, source_column)
);

CREATE INDEX IF NOT EXISTS idx_mappings_source ON source_column_mappings (source_id);

CREATE TABLE IF NOT EXISTS merge_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  target_table  VARCHAR(100) NOT NULL,
  on_conflict   VARCHAR(20) NOT NULL DEFAULT 'update',
  condition_sql TEXT,
  priority      INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staging_data (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            UUID NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  row_number        INTEGER NOT NULL,
  raw_data          JSONB NOT NULL,
  mapped_data       JSONB,
  rutid             VARCHAR(20),
  is_valid_rut      BOOLEAN,
  validation_errors JSONB DEFAULT '[]',
  status            VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staging_job_id ON staging_data (job_id);
CREATE INDEX IF NOT EXISTS idx_staging_rutid  ON staging_data (rutid);
CREATE INDEX IF NOT EXISTS idx_staging_status ON staging_data (status);

CREATE TABLE IF NOT EXISTS segmentos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  description   TEXT,
  filters       JSONB NOT NULL DEFAULT '{}',
  sql_query     TEXT,
  row_count     INTEGER DEFAULT 0,
  last_computed TIMESTAMPTZ,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_segmentos_active ON segmentos (is_active);

CREATE TABLE IF NOT EXISTS segment_exports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id   UUID NOT NULL REFERENCES segmentos(id) ON DELETE CASCADE,
  file_name    VARCHAR(500),
  file_path    TEXT,
  file_size    BIGINT,
  row_count    INTEGER,
  format       VARCHAR(10) NOT NULL DEFAULT 'csv',
  status       VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_by   UUID REFERENCES auth.users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ai_analysis_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_type VARCHAR(50) NOT NULL,
  input_data    JSONB,
  output_data   JSONB,
  model         VARCHAR(100) DEFAULT 'mercury-2',
  tokens_used   INTEGER,
  duration_ms   INTEGER,
  created_by    UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_logs_type ON ai_analysis_logs (analysis_type);
CREATE INDEX IF NOT EXISTS idx_ai_logs_ts   ON ai_analysis_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id),
  action      VARCHAR(100) NOT NULL,
  entity      VARCHAR(100),
  entity_id   VARCHAR(100),
  old_data    JSONB,
  new_data    JSONB,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_logs (entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at DESC);

ALTER TABLE data_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE segmentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_sources" ON data_sources
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "authenticated_write_sources" ON data_sources
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "authenticated_read_jobs" ON ingestion_jobs
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "authenticated_write_jobs" ON ingestion_jobs
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "authenticated_read_segmentos" ON segmentos
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "authenticated_write_segmentos" ON segmentos
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "authenticated_read_audit" ON audit_logs
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE OR REPLACE FUNCTION validate_rut_cl(rut TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  clean_rut TEXT;
  digits    TEXT;
  dv        TEXT;
  sum       INTEGER := 0;
  mult      INTEGER := 2;
  i         INTEGER;
  calc_dv   TEXT;
BEGIN
  IF rut IS NULL OR LENGTH(TRIM(rut)) = 0 THEN RETURN FALSE; END IF;
  clean_rut := REGEXP_REPLACE(UPPER(TRIM(rut)), '[.\-\s]', '', 'g');
  IF LENGTH(clean_rut) < 2 THEN RETURN FALSE; END IF;
  dv     := RIGHT(clean_rut, 1);
  digits := LEFT(clean_rut, LENGTH(clean_rut) - 1);
  IF digits !~ '^[0-9]+$' THEN RETURN FALSE; END IF;
  FOR i IN REVERSE LENGTH(digits)..1 LOOP
    sum  := sum + (SUBSTRING(digits, i, 1)::INTEGER * mult);
    mult := CASE WHEN mult = 7 THEN 2 ELSE mult + 1 END;
  END LOOP;
  calc_dv := CASE (11 - (sum % 11))
    WHEN 11 THEN '0'
    WHEN 10 THEN 'K'
    ELSE (11 - (sum % 11))::TEXT
  END;
  RETURN calc_dv = dv;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION format_rut_cl(rut TEXT)
RETURNS TEXT AS $$
DECLARE
  clean_rut TEXT;
BEGIN
  IF rut IS NULL THEN RETURN NULL; END IF;
  clean_rut := REGEXP_REPLACE(UPPER(TRIM(rut)), '[.\-\s]', '', 'g');
  RETURN LEFT(clean_rut, LENGTH(clean_rut)-1) || '-' || RIGHT(clean_rut, 1);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'master_personas', 'pernat_resumen', 'autos_resumen',
    'empresa_resumen', 'domicilio_resumen', 'acumulado_resumen',
    'data_sources', 'ingestion_jobs', 'segmentos', 'source_column_mappings'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$s', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at
       BEFORE UPDATE ON %1$s
       FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()',
      t
    );
  END LOOP;
END $$;

CREATE MATERIALIZED VIEW IF NOT EXISTS dashboard_stats AS
SELECT
  (SELECT COUNT(*) FROM master_personas) AS total_ruts,
  (SELECT COUNT(*) FROM pernat_resumen WHERE nombres IS NOT NULL) AS con_nombre,
  (SELECT COUNT(*) FROM pernat_resumen WHERE email IS NOT NULL) AS con_email,
  (SELECT COUNT(*) FROM pernat_resumen WHERE fono_cel IS NOT NULL) AS con_fono,
  (SELECT COUNT(*) FROM autos_resumen WHERE n_autos > 0) AS con_autos,
  (SELECT SUM(n_autos) FROM autos_resumen) AS total_autos,
  (SELECT COUNT(*) FROM empresa_resumen WHERE razon_social_empresa IS NOT NULL) AS con_empresa,
  (SELECT COUNT(*) FROM domicilio_resumen WHERE region IS NOT NULL) AS con_domicilio,
  (SELECT COUNT(*) FROM acumulado_resumen WHERE n_bienes_raices > 0) AS con_bienes_raices,
  (SELECT SUM(totalavaluos) FROM acumulado_resumen) AS total_avaluos,
  (SELECT COUNT(*) FROM ingestion_jobs WHERE status = 'completed') AS jobs_completados,
  (SELECT COUNT(*) FROM ingestion_jobs WHERE status = 'failed') AS jobs_fallidos,
  (SELECT COUNT(*) FROM segmentos WHERE is_active = TRUE) AS total_segmentos,
  NOW() AS last_refreshed;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_stats ON dashboard_stats ((1));

CREATE OR REPLACE FUNCTION refresh_dashboard_stats()
RETURNS VOID AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_stats;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
