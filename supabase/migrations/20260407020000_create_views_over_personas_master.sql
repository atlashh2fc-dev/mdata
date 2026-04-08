-- ============================================================
-- SUPABASE FIX: Crear vistas y vistas materializadas sobre personas_master
-- Ejecutar en Supabase Dashboard > SQL Editor
-- ============================================================

-- 1. Vista principal con columnas computadas (nombre_completo, score, cobertura, etc.)
--    Los strings vacíos se normalizan a NULL para consistencia con el resto del código.
CREATE OR REPLACE VIEW master_personas_view AS
SELECT
  rutid,

  -- Datos personales (normalize empty strings to NULL)
  NULLIF(TRIM(nombres), '')  AS nombres,
  NULLIF(TRIM(paterno), '')  AS paterno,
  NULLIF(TRIM(materno), '')  AS materno,
  NULLIF(TRIM(
    COALESCE(NULLIF(TRIM(nombres),''), '') || ' ' ||
    COALESCE(NULLIF(TRIM(paterno),''), '') || ' ' ||
    COALESCE(NULLIF(TRIM(materno),''), '')
  ), '') AS nombre_completo,

  NULLIF(TRIM(email), '')       AS email,
  NULLIF(TRIM(fono_cel), '')    AS fono_cel,
  NULLIF(TRIM(comuna_part), '') AS comuna_part,
  NULLIF(TRIM(region_part), '') AS region_part,

  -- Bienes y empresa
  n_autos,
  (n_autos > 0) AS tiene_autos,
  razon_social_empresa,
  (razon_social_empresa IS NOT NULL) AS tiene_empresa,
  domicilio_comuna,
  domicilio_region,
  n_bienes_raices,
  totalavaluos,
  (n_bienes_raices > 0) AS tiene_bienes_raices,

  -- Score patrimonial compuesto
  (
    COALESCE(n_autos, 0) * 10 +
    COALESCE(n_bienes_raices, 0) * 20 +
    CASE WHEN razon_social_empresa IS NOT NULL THEN 15 ELSE 0 END +
    CASE WHEN NULLIF(TRIM(email), '') IS NOT NULL THEN 5 ELSE 0 END +
    CASE WHEN NULLIF(TRIM(fono_cel), '') IS NOT NULL THEN 5 ELSE 0 END
  )::INTEGER AS score_patrimonial,

  -- Cobertura de datos (0-100%)
  (
    (CASE WHEN NULLIF(TRIM(nombres), '') IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN NULLIF(TRIM(email), '') IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN NULLIF(TRIM(fono_cel), '') IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN NULLIF(TRIM(region_part), '') IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN n_autos > 0 THEN 1 ELSE 0 END +
     CASE WHEN razon_social_empresa IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN domicilio_region IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN n_bienes_raices > 0 THEN 1 ELSE 0 END
    )::FLOAT / 8.0 * 100
  )::INTEGER AS cobertura_pct,

  -- Región y comuna canónicas (prioriza pernat sobre domicilio)
  COALESCE(NULLIF(TRIM(region_part), ''), domicilio_region)  AS region_canonica,
  COALESCE(NULLIF(TRIM(comuna_part), ''), domicilio_comuna)  AS comuna_canonica,

  loaded_at AS created_at,
  loaded_at AS updated_at
FROM personas_master;


-- 2. Vista materializada para KPIs del dashboard
--    Nota: También incluye jobs y segmentos si las tablas existen.
DROP MATERIALIZED VIEW IF EXISTS dashboard_stats;
CREATE MATERIALIZED VIEW dashboard_stats AS
SELECT
  COUNT(*)::BIGINT AS total_ruts,
  COUNT(*) FILTER (WHERE NULLIF(TRIM(nombres), '') IS NOT NULL)    AS con_nombre,
  COUNT(*) FILTER (WHERE NULLIF(TRIM(email), '') IS NOT NULL)      AS con_email,
  COUNT(*) FILTER (WHERE NULLIF(TRIM(fono_cel), '') IS NOT NULL)   AS con_fono,
  COUNT(*) FILTER (WHERE n_autos > 0)                              AS con_autos,
  COALESCE(SUM(n_autos), 0)                                        AS total_autos,
  COUNT(*) FILTER (WHERE razon_social_empresa IS NOT NULL)         AS con_empresa,
  COUNT(*) FILTER (WHERE COALESCE(NULLIF(TRIM(region_part), ''), NULLIF(TRIM(comuna_part), ''), NULLIF(TRIM(domicilio_region), '')) IS NOT NULL) AS con_domicilio,
  COUNT(*) FILTER (WHERE n_bienes_raices > 0)                      AS con_bienes_raices,
  COALESCE(SUM(totalavaluos), 0)                                   AS total_avaluos,
  0::BIGINT                                                         AS jobs_completados,
  0::BIGINT                                                         AS jobs_fallidos,
  0::BIGINT                                                         AS total_segmentos,
  NOW()                                                             AS last_refreshed
FROM personas_master;

CREATE UNIQUE INDEX idx_dashboard_stats ON dashboard_stats ((1));

-- 3. Stats por región (CTE para evitar mismatch entre GROUP BY y SELECT)
DROP MATERIALIZED VIEW IF EXISTS stats_por_region;
CREATE MATERIALIZED VIEW stats_por_region AS
WITH base AS (
  SELECT
    COALESCE(NULLIF(TRIM(region_part), ''), domicilio_region, 'Sin región') AS region,
    email,
    fono_cel
  FROM personas_master
)
SELECT
  region,
  COUNT(*)                                                        AS total,
  COUNT(*) FILTER (WHERE NULLIF(TRIM(email), '') IS NOT NULL)    AS con_email,
  COUNT(*) FILTER (WHERE NULLIF(TRIM(fono_cel), '') IS NOT NULL) AS con_fono
FROM base
GROUP BY region
ORDER BY COUNT(*) DESC;

CREATE UNIQUE INDEX idx_stats_por_region ON stats_por_region (region);

-- 4. Distribución de score
DROP MATERIALIZED VIEW IF EXISTS stats_score_dist;
CREATE MATERIALIZED VIEW stats_score_dist AS
WITH scored AS (
  SELECT (
    COALESCE(n_autos, 0) * 10 +
    COALESCE(n_bienes_raices, 0) * 20 +
    CASE WHEN razon_social_empresa IS NOT NULL THEN 15 ELSE 0 END +
    CASE WHEN NULLIF(TRIM(email), '') IS NOT NULL THEN 5 ELSE 0 END +
    CASE WHEN NULLIF(TRIM(fono_cel), '') IS NOT NULL THEN 5 ELSE 0 END
  ) AS s
  FROM personas_master
)
SELECT
  CASE
    WHEN s = 0            THEN '0'
    WHEN s BETWEEN 1  AND 20 THEN '1-20'
    WHEN s BETWEEN 21 AND 40 THEN '21-40'
    WHEN s BETWEEN 41 AND 60 THEN '41-60'
    WHEN s BETWEEN 61 AND 80 THEN '61-80'
    ELSE '81+'
  END AS range,
  COUNT(*) AS count
FROM scored
GROUP BY range
ORDER BY range;

CREATE UNIQUE INDEX idx_stats_score_dist ON stats_score_dist (range);

-- 5. Función para refrescar todas las vistas materializadas
CREATE OR REPLACE FUNCTION refresh_dashboard_stats()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_stats;
  REFRESH MATERIALIZED VIEW CONCURRENTLY stats_por_region;
  REFRESH MATERIALIZED VIEW CONCURRENTLY stats_score_dist;
END;
$$;

-- 6. Permisos para usuarios autenticados
GRANT SELECT ON master_personas_view TO authenticated;
GRANT SELECT ON dashboard_stats TO authenticated;
GRANT SELECT ON stats_por_region TO authenticated;
GRANT SELECT ON stats_score_dist TO authenticated;
GRANT EXECUTE ON FUNCTION refresh_dashboard_stats() TO authenticated;
