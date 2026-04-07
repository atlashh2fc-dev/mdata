-- ============================================================
-- TABLA CONSOLIDADA PLANA: personas_master
-- Contiene el JOIN completo de las 6 tablas MySQL originales
-- Optimizada para 9.5M+ registros en Supabase (Postgres)
-- ============================================================

-- Extensión para índices trigram (búsqueda por texto parcial)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------
-- Tabla principal consolidada (flat / denormalized)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS personas_master (
  -- Identificador primario
  rutid             VARCHAR(20)     NOT NULL,

  -- Datos personales (pernat_resumen)
  nombres           VARCHAR(150),
  paterno           VARCHAR(80),
  materno           VARCHAR(80),
  email             VARCHAR(180),
  fono_cel          VARCHAR(30),
  comuna_part       VARCHAR(80),
  region_part       VARCHAR(80),

  -- Bienes (autos_resumen)
  n_autos           INTEGER         DEFAULT 0,

  -- Empresa (empresa_resumen)
  razon_social_empresa VARCHAR(250),

  -- Domicilio tributario (domicilio_resumen)
  domicilio_comuna  VARCHAR(80),
  domicilio_region  VARCHAR(80),

  -- Bienes raíces (acumulado_resumen)
  n_bienes_raices   INTEGER         DEFAULT 0,
  totalavaluos      NUMERIC(18, 2)  DEFAULT 0,

  -- Score de riqueza calculado (para ranking rápido)
  score             INTEGER         GENERATED ALWAYS AS (
    COALESCE(n_autos, 0) * 10 +
    COALESCE(n_bienes_raices, 0) * 20 +
    CASE WHEN razon_social_empresa IS NOT NULL THEN 15 ELSE 0 END +
    CASE WHEN email IS NOT NULL THEN 5 ELSE 0 END +
    CASE WHEN fono_cel IS NOT NULL THEN 5 ELSE 0 END
  ) STORED,

  -- Control de carga
  loaded_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  -- Restricciones
  CONSTRAINT personas_master_pkey PRIMARY KEY (rutid)
);

-- ---------------------------------------------------------------
-- Índices de performance (crear DESPUÉS de cargar los datos)
-- ---------------------------------------------------------------

-- Búsqueda full text por nombre completo
CREATE INDEX IF NOT EXISTS idx_pm_nombre_trgm
  ON personas_master
  USING gin (
    (COALESCE(nombres,'') || ' ' || COALESCE(paterno,'') || ' ' || COALESCE(materno,''))
    gin_trgm_ops
  );

-- Filtrado por región
CREATE INDEX IF NOT EXISTS idx_pm_region
  ON personas_master (region_part)
  WHERE region_part IS NOT NULL;

-- Filtrado por comuna
CREATE INDEX IF NOT EXISTS idx_pm_comuna
  ON personas_master (comuna_part)
  WHERE comuna_part IS NOT NULL;

-- Filtrado por email disponible
CREATE INDEX IF NOT EXISTS idx_pm_email
  ON personas_master (email)
  WHERE email IS NOT NULL;

-- Filtrado por teléfono
CREATE INDEX IF NOT EXISTS idx_pm_fono
  ON personas_master (fono_cel)
  WHERE fono_cel IS NOT NULL;

-- Score para ranking
CREATE INDEX IF NOT EXISTS idx_pm_score
  ON personas_master (score DESC);

-- Con empresa
CREATE INDEX IF NOT EXISTS idx_pm_empresa
  ON personas_master (razon_social_empresa)
  WHERE razon_social_empresa IS NOT NULL;

-- Autos > 0
CREATE INDEX IF NOT EXISTS idx_pm_autos
  ON personas_master (n_autos)
  WHERE n_autos > 0;

-- Bienes raíces > 0
CREATE INDEX IF NOT EXISTS idx_pm_bienes
  ON personas_master (n_bienes_raices)
  WHERE n_bienes_raices > 0;

-- ---------------------------------------------------------------
-- Vista de estadísticas por región (para dashboard)
-- ---------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS pm_stats_region AS
SELECT
  COALESCE(region_part, 'Sin región') AS region,
  COUNT(*)                             AS total,
  COUNT(email)                         AS con_email,
  COUNT(fono_cel)                      AS con_fono,
  COUNT(razon_social_empresa)          AS con_empresa,
  SUM(n_autos)                         AS total_autos,
  SUM(n_bienes_raices)                 AS total_bienes,
  ROUND(AVG(score))                    AS avg_score
FROM personas_master
GROUP BY region_part
ORDER BY COUNT(*) DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_stats_region ON pm_stats_region (region);

-- ---------------------------------------------------------------
-- Vista de distribución de score
-- ---------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS pm_stats_score AS
SELECT
  CASE
    WHEN score = 0         THEN '0 - Sin datos'
    WHEN score BETWEEN 1  AND 20  THEN '1-20 Básico'
    WHEN score BETWEEN 21 AND 40  THEN '21-40 Medio'
    WHEN score BETWEEN 41 AND 60  THEN '41-60 Alto'
    WHEN score BETWEEN 61 AND 80  THEN '61-80 Premium'
    ELSE '81+ Elite'
  END AS rango,
  COUNT(*) AS total
FROM personas_master
GROUP BY rango
ORDER BY rango;

-- ---------------------------------------------------------------
-- Vista de KPIs generales (para dashboard principal)
-- ---------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS pm_kpis AS
SELECT
  COUNT(*)                                AS total_ruts,
  COUNT(email)                            AS con_email,
  COUNT(fono_cel)                         AS con_fono,
  COUNT(razon_social_empresa)             AS con_empresa,
  COUNT(*) FILTER (WHERE n_autos > 0)     AS con_autos,
  COUNT(*) FILTER (WHERE n_bienes_raices > 0) AS con_bienes,
  ROUND(COUNT(email)::numeric / COUNT(*) * 100, 1) AS pct_email,
  ROUND(COUNT(fono_cel)::numeric / COUNT(*) * 100, 1) AS pct_fono,
  ROUND(AVG(score), 1)                    AS avg_score,
  MAX(loaded_at)                          AS ultima_carga
FROM personas_master;

-- ---------------------------------------------------------------
-- Función para refrescar todas las vistas materializadas
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_pm_stats()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY pm_stats_region;
  REFRESH MATERIALIZED VIEW CONCURRENTLY pm_stats_score;
  REFRESH MATERIALIZED VIEW CONCURRENTLY pm_kpis;
END;
$$;

-- ---------------------------------------------------------------
-- RLS: Solo usuarios autenticados pueden leer
-- ---------------------------------------------------------------
ALTER TABLE personas_master ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_personas_master"
  ON personas_master
  FOR SELECT
  TO authenticated
  USING (true);

-- Service role bypasses RLS (para scripts de carga)
-- No se necesita policy de escritura pública
