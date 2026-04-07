CREATE TABLE IF NOT EXISTS personas_master (
  rutid VARCHAR(20) PRIMARY KEY,
  nombres VARCHAR(200),
  paterno VARCHAR(100),
  materno VARCHAR(100),
  nombre_completo VARCHAR(500),
  email VARCHAR(255),
  fono_cel VARCHAR(20),
  comuna_part VARCHAR(100),
  region_part VARCHAR(100),
  n_autos INTEGER NOT NULL DEFAULT 0,
  tiene_autos BOOLEAN NOT NULL DEFAULT FALSE,
  razon_social_empresa VARCHAR(255),
  tiene_empresa BOOLEAN NOT NULL DEFAULT FALSE,
  domicilio_comuna VARCHAR(100),
  domicilio_region VARCHAR(100),
  n_bienes_raices INTEGER NOT NULL DEFAULT 0,
  totalavaluos NUMERIC(18,2) NOT NULL DEFAULT 0,
  tiene_bienes_raices BOOLEAN NOT NULL DEFAULT FALSE,
  score_patrimonial INTEGER NOT NULL DEFAULT 0,
  cobertura_pct INTEGER NOT NULL DEFAULT 0,
  region_canonica VARCHAR(100),
  comuna_canonica VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_personas_master_nombre
  ON personas_master USING gin (nombre_completo gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_personas_master_email
  ON personas_master (email);

CREATE INDEX IF NOT EXISTS idx_personas_master_region
  ON personas_master (region_canonica);

CREATE INDEX IF NOT EXISTS idx_personas_master_comuna
  ON personas_master (comuna_canonica);

CREATE INDEX IF NOT EXISTS idx_personas_master_score
  ON personas_master (score_patrimonial DESC);

CREATE INDEX IF NOT EXISTS idx_personas_master_autos
  ON personas_master (n_autos);

CREATE INDEX IF NOT EXISTS idx_personas_master_bienes
  ON personas_master (n_bienes_raices);

CREATE OR REPLACE VIEW master_personas_current AS
SELECT
  pm.rutid,
  pm.nombres,
  pm.paterno,
  pm.materno,
  pm.nombre_completo,
  pm.email,
  pm.fono_cel,
  pm.comuna_part,
  pm.region_part,
  pm.n_autos,
  pm.tiene_autos,
  pm.razon_social_empresa,
  pm.tiene_empresa,
  pm.domicilio_comuna,
  pm.domicilio_region,
  pm.n_bienes_raices,
  pm.totalavaluos,
  pm.tiene_bienes_raices,
  pm.score_patrimonial,
  pm.cobertura_pct,
  pm.region_canonica,
  pm.comuna_canonica,
  pm.created_at,
  pm.updated_at
FROM personas_master pm
WHERE EXISTS (SELECT 1 FROM personas_master LIMIT 1)

UNION ALL

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
  COALESCE(pr.region_part, dr.region) AS region_canonica,
  COALESCE(pr.comuna_part, dr.comuna) AS comuna_canonica,
  mp.created_at,
  mp.updated_at
FROM master_personas mp
LEFT JOIN pernat_resumen pr ON pr.rutid = mp.rutid
LEFT JOIN autos_resumen ar ON ar.rutid = mp.rutid
LEFT JOIN empresa_resumen er ON er.rutid = mp.rutid
LEFT JOIN domicilio_resumen dr ON dr.rutid = mp.rutid
LEFT JOIN acumulado_resumen ac ON ac.rutid = mp.rutid
WHERE NOT EXISTS (SELECT 1 FROM personas_master LIMIT 1);

CREATE OR REPLACE VIEW master_personas_view AS
SELECT * FROM master_personas_current;

DROP MATERIALIZED VIEW IF EXISTS dashboard_stats;
CREATE MATERIALIZED VIEW dashboard_stats AS
SELECT
  COUNT(*)::BIGINT AS total_ruts,
  COUNT(*) FILTER (WHERE nombres IS NOT NULL) AS con_nombre,
  COUNT(*) FILTER (WHERE email IS NOT NULL) AS con_email,
  COUNT(*) FILTER (WHERE fono_cel IS NOT NULL) AS con_fono,
  COUNT(*) FILTER (WHERE n_autos > 0) AS con_autos,
  COALESCE(SUM(n_autos), 0) AS total_autos,
  COUNT(*) FILTER (WHERE razon_social_empresa IS NOT NULL) AS con_empresa,
  COUNT(*) FILTER (WHERE domicilio_region IS NOT NULL) AS con_domicilio,
  COUNT(*) FILTER (WHERE n_bienes_raices > 0) AS con_bienes_raices,
  COALESCE(SUM(totalavaluos), 0) AS total_avaluos,
  (SELECT COUNT(*) FROM ingestion_jobs WHERE status = 'completed') AS jobs_completados,
  (SELECT COUNT(*) FROM ingestion_jobs WHERE status = 'failed') AS jobs_fallidos,
  (SELECT COUNT(*) FROM segmentos WHERE is_active = TRUE) AS total_segmentos,
  NOW() AS last_refreshed
FROM master_personas_view;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_stats ON dashboard_stats ((1));

DROP MATERIALIZED VIEW IF EXISTS stats_por_region;
CREATE MATERIALIZED VIEW stats_por_region AS
SELECT
  COALESCE(region_canonica, 'Sin región') AS region,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE email IS NOT NULL) AS con_email,
  COUNT(*) FILTER (WHERE fono_cel IS NOT NULL) AS con_fono
FROM master_personas_view
GROUP BY region_canonica
ORDER BY COUNT(*) DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_stats_por_region ON stats_por_region (region);

DROP MATERIALIZED VIEW IF EXISTS stats_score_dist;
CREATE MATERIALIZED VIEW stats_score_dist AS
SELECT
  CASE
    WHEN score_patrimonial = 0 THEN '0'
    WHEN score_patrimonial BETWEEN 1 AND 20 THEN '1-20'
    WHEN score_patrimonial BETWEEN 21 AND 40 THEN '21-40'
    WHEN score_patrimonial BETWEEN 41 AND 60 THEN '41-60'
    WHEN score_patrimonial BETWEEN 61 AND 80 THEN '61-80'
    ELSE '81+'
  END AS range,
  COUNT(*) AS count
FROM master_personas_view
GROUP BY range
ORDER BY range;

INSERT INTO data_sources (
  name,
  slug,
  source_type,
  canonical_table,
  source_table_name,
  primary_key_column,
  supports_incremental,
  is_active
)
VALUES (
  'personas master',
  'personas_master',
  'mysql',
  'personas_master',
  'personas_master',
  'rutid',
  true,
  true
)
ON CONFLICT (slug) DO UPDATE
SET
  canonical_table = EXCLUDED.canonical_table,
  source_table_name = EXCLUDED.source_table_name,
  primary_key_column = EXCLUDED.primary_key_column,
  supports_incremental = EXCLUDED.supports_incremental,
  is_active = true,
  updated_at = NOW();
