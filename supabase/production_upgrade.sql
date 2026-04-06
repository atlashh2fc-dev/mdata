-- ============================================================
-- RUT INTELLIGENCE PLATFORM - PRODUCTION UPGRADE
-- Ejecutar sobre instalaciones ya existentes.
-- Objetivos:
-- 1. Endurecer la capa canonica de consumo
-- 2. Agregar metadata operativa para datasets y cargas
-- 3. Dejar el esquema listo para cargas bulk repetibles
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE OR REPLACE FUNCTION audit_trigger_fn()
RETURNS TRIGGER AS $$
DECLARE
  v_entity_id TEXT;
BEGIN
  v_entity_id := COALESCE(to_jsonb(NEW) ->> 'id', to_jsonb(OLD) ->> 'id');

  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_logs (action, entity, entity_id, new_data)
    VALUES (TG_OP, TG_TABLE_NAME, v_entity_id, to_jsonb(NEW));
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO audit_logs (action, entity, entity_id, old_data, new_data)
    VALUES (TG_OP, TG_TABLE_NAME, v_entity_id, to_jsonb(OLD), to_jsonb(NEW));
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO audit_logs (action, entity, entity_id, old_data)
    VALUES (TG_OP, TG_TABLE_NAME, v_entity_id, to_jsonb(OLD));
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 1. Endurecer tablas resumen 1:1 por rutid
-- ============================================================

DELETE FROM pernat_resumen a
USING pernat_resumen b
WHERE a.rutid = b.rutid
  AND a.id < b.id;

DELETE FROM empresa_resumen a
USING empresa_resumen b
WHERE a.rutid = b.rutid
  AND a.id < b.id;

DELETE FROM domicilio_resumen a
USING domicilio_resumen b
WHERE a.rutid = b.rutid
  AND a.id < b.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pernat_resumen_rutid_unique
  ON pernat_resumen (rutid);

CREATE UNIQUE INDEX IF NOT EXISTS idx_empresa_resumen_rutid_unique
  ON empresa_resumen (rutid);

CREATE UNIQUE INDEX IF NOT EXISTS idx_domicilio_resumen_rutid_unique
  ON domicilio_resumen (rutid);

CREATE INDEX IF NOT EXISTS idx_pernat_email_trgm
  ON pernat_resumen USING gin (email gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_pernat_fono_cel
  ON pernat_resumen (fono_cel);

-- ============================================================
-- 2. Capa canonica de consumo
-- ============================================================

CREATE OR REPLACE VIEW master_personas_current AS
SELECT
  mp.rutid,
  pr.nombres,
  pr.paterno,
  pr.materno,
  NULLIF(TRIM(CONCAT(COALESCE(pr.nombres, ''), ' ', COALESCE(pr.paterno, ''), ' ', COALESCE(pr.materno, ''))), '') AS nombre_completo,
  pr.email,
  pr.fono_cel,
  pr.comuna_part,
  pr.region_part,
  COALESCE(ar.n_autos, 0) AS n_autos,
  COALESCE(ar.n_autos, 0) > 0 AS tiene_autos,
  er.razon_social_empresa,
  er.razon_social_empresa IS NOT NULL AS tiene_empresa,
  dr.comuna AS domicilio_comuna,
  dr.region AS domicilio_region,
  COALESCE(ac.n_bienes_raices, 0) AS n_bienes_raices,
  COALESCE(ac.totalavaluos, 0) AS totalavaluos,
  COALESCE(ac.n_bienes_raices, 0) > 0 AS tiene_bienes_raices,
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
  COALESCE(dr.region, pr.region_part) AS region_canonica,
  COALESCE(dr.comuna, pr.comuna_part) AS comuna_canonica,
  mp.created_at,
  mp.updated_at
FROM master_personas mp
LEFT JOIN pernat_resumen pr ON pr.rutid = mp.rutid
LEFT JOIN autos_resumen ar ON ar.rutid = mp.rutid
LEFT JOIN empresa_resumen er ON er.rutid = mp.rutid
LEFT JOIN domicilio_resumen dr ON dr.rutid = mp.rutid
LEFT JOIN acumulado_resumen ac ON ac.rutid = mp.rutid;

DROP VIEW IF EXISTS master_personas_view;

CREATE VIEW master_personas_view AS
SELECT *
FROM master_personas_current;

-- ============================================================
-- 3. Metadata operativa de datasets y cargas
-- ============================================================

ALTER TABLE data_sources
  ADD COLUMN IF NOT EXISTS slug TEXT,
  ADD COLUMN IF NOT EXISTS canonical_table TEXT,
  ADD COLUMN IF NOT EXISTS source_table_name TEXT,
  ADD COLUMN IF NOT EXISTS primary_key_column TEXT DEFAULT 'rutid',
  ADD COLUMN IF NOT EXISTS supports_incremental BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS record_count BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coverage_pct NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS last_loaded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_job_status TEXT,
  ADD COLUMN IF NOT EXISTS last_error_message TEXT;

UPDATE data_sources
SET slug = COALESCE(slug, LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]+', '_', 'g')))
WHERE slug IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_data_sources_slug_unique
  ON data_sources (slug);

CREATE TABLE IF NOT EXISTS source_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  version_label TEXT NOT NULL,
  load_mode TEXT NOT NULL DEFAULT 'upsert',
  source_row_count BIGINT NOT NULL DEFAULT 0,
  loaded_row_count BIGINT NOT NULL DEFAULT 0,
  new_rows BIGINT NOT NULL DEFAULT 0,
  updated_rows BIGINT NOT NULL DEFAULT 0,
  failed_rows BIGINT NOT NULL DEFAULT 0,
  checksum TEXT,
  source_snapshot_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_source_versions_source_id
  ON source_versions (source_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_source_versions_status
  ON source_versions (status);

CREATE OR REPLACE VIEW dataset_overview AS
SELECT
  ds.id,
  ds.name,
  ds.slug,
  ds.description,
  ds.source_type,
  ds.is_active,
  ds.config,
  ds.created_by,
  ds.created_at,
  ds.updated_at,
  ds.canonical_table,
  ds.source_table_name,
  ds.primary_key_column,
  ds.supports_incremental,
  ds.record_count,
  ds.coverage_pct,
  ds.last_loaded_at,
  ds.last_job_status,
  ds.last_error_message,
  sv.id AS latest_version_id,
  sv.version_label AS latest_version_label,
  sv.load_mode AS latest_load_mode,
  sv.source_row_count AS latest_source_row_count,
  sv.loaded_row_count AS latest_loaded_row_count,
  sv.new_rows AS latest_new_rows,
  sv.updated_rows AS latest_updated_rows,
  sv.failed_rows AS latest_failed_rows,
  sv.status AS latest_version_status,
  sv.completed_at AS latest_version_completed_at
FROM data_sources ds
LEFT JOIN LATERAL (
  SELECT *
  FROM source_versions sv
  WHERE sv.source_id = ds.id
  ORDER BY COALESCE(sv.completed_at, sv.started_at, sv.created_at) DESC, sv.created_at DESC
  LIMIT 1
) sv ON TRUE;

-- ============================================================
-- 4. Seeds de fuentes reales del producto
-- ============================================================

INSERT INTO data_sources (
  name,
  slug,
  description,
  source_type,
  canonical_table,
  source_table_name,
  primary_key_column,
  supports_incremental,
  record_count,
  is_active
)
VALUES
  ('Master personas', 'master_personas', 'Base maestra canonica de RUTs unicos.', 'mysql', 'master_personas', 'master_personas', 'rutid', TRUE, 9569015, TRUE),
  ('Pernat resumen', 'pernat_resumen', 'Resumen personal principal usado por buscador y perfil 360.', 'mysql', 'pernat_resumen', 'pernat_resumen', 'rutid', TRUE, 6145874, TRUE),
  ('Autos resumen', 'autos_resumen', 'Resumen de vehiculos por rutid.', 'mysql', 'autos_resumen', 'autos_resumen', 'rutid', TRUE, 5292932, TRUE),
  ('Empresa resumen', 'empresa_resumen', 'Resumen empresarial consolidado por rutid.', 'mysql', 'empresa_resumen', 'empresa_resumen', 'rutid', TRUE, 0, TRUE),
  ('Domicilio resumen', 'domicilio_resumen', 'Resumen de domicilio consolidado por rutid.', 'mysql', 'domicilio_resumen', 'domicilio_resumen', 'rutid', TRUE, 0, TRUE),
  ('Acumulado resumen', 'acumulado_resumen', 'Resumen patrimonial y de bienes raices por rutid.', 'mysql', 'acumulado_resumen', 'acumulado_resumen', 'rutid', TRUE, 8200371, TRUE)
ON CONFLICT (slug) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  source_type = EXCLUDED.source_type,
  canonical_table = EXCLUDED.canonical_table,
  source_table_name = EXCLUDED.source_table_name,
  primary_key_column = EXCLUDED.primary_key_column,
  supports_incremental = EXCLUDED.supports_incremental,
  record_count = GREATEST(data_sources.record_count, EXCLUDED.record_count),
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

-- ============================================================
-- 5. Utilidad para registrar resultado de una carga bulk
-- ============================================================

CREATE OR REPLACE FUNCTION finalize_source_version(
  p_source_slug TEXT,
  p_version_label TEXT,
  p_load_mode TEXT,
  p_source_row_count BIGINT,
  p_loaded_row_count BIGINT,
  p_new_rows BIGINT,
  p_updated_rows BIGINT,
  p_failed_rows BIGINT,
  p_status TEXT,
  p_notes TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID AS $$
DECLARE
  v_source_id UUID;
  v_version_id UUID;
BEGIN
  SELECT id INTO v_source_id
  FROM data_sources
  WHERE slug = p_source_slug;

  IF v_source_id IS NULL THEN
    RAISE EXCEPTION 'data_sources.slug % no existe', p_source_slug;
  END IF;

  INSERT INTO source_versions (
    source_id,
    version_label,
    load_mode,
    source_row_count,
    loaded_row_count,
    new_rows,
    updated_rows,
    failed_rows,
    completed_at,
    status,
    notes,
    metadata
  )
  VALUES (
    v_source_id,
    p_version_label,
    p_load_mode,
    p_source_row_count,
    p_loaded_row_count,
    p_new_rows,
    p_updated_rows,
    p_failed_rows,
    NOW(),
    p_status,
    p_notes,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_version_id;

  UPDATE data_sources
  SET
    record_count = p_loaded_row_count,
    last_loaded_at = NOW(),
    last_job_status = p_status,
    last_error_message = CASE WHEN p_status = 'failed' THEN p_notes ELSE NULL END,
    updated_at = NOW()
  WHERE id = v_source_id;

  RETURN v_version_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
