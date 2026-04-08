-- ============================================================
-- Creación de Matriz Combinatoria (Universos)
-- ============================================================

DROP MATERIALIZED VIEW IF EXISTS stats_universos;

CREATE MATERIALIZED VIEW stats_universos AS
WITH flags AS (
  SELECT
    (NULLIF(TRIM(nombres), '') IS NOT NULL) AS con_nombre,
    (NULLIF(TRIM(email), '') IS NOT NULL) AS con_email,
    (NULLIF(TRIM(fono_cel), '') IS NOT NULL) AS con_fono,
    (n_autos > 0) AS con_autos,
    (razon_social_empresa IS NOT NULL) AS con_empresa,
    (COALESCE(NULLIF(TRIM(region_part), ''), NULLIF(TRIM(comuna_part), ''), NULLIF(TRIM(domicilio_region), '')) IS NOT NULL) AS con_domicilio,
    (n_bienes_raices > 0) AS con_bienes_raices
  FROM personas_master
)
SELECT
  con_nombre,
  con_email,
  con_fono,
  con_autos,
  con_empresa,
  con_domicilio,
  con_bienes_raices,
  COUNT(*) AS total
FROM flags
GROUP BY 
  con_nombre,
  con_email,
  con_fono,
  con_autos,
  con_empresa,
  con_domicilio,
  con_bienes_raices;

CREATE UNIQUE INDEX idx_stats_universos ON stats_universos (
  con_nombre,
  con_email,
  con_fono,
  con_autos,
  con_empresa,
  con_domicilio,
  con_bienes_raices
);

-- Actualizar la función de refresco global
CREATE OR REPLACE FUNCTION refresh_dashboard_stats()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_stats;
  REFRESH MATERIALIZED VIEW CONCURRENTLY stats_por_region;
  REFRESH MATERIALIZED VIEW CONCURRENTLY stats_score_dist;
  REFRESH MATERIALIZED VIEW CONCURRENTLY stats_universos;
END;
$$;

GRANT SELECT ON stats_universos TO authenticated;
GRANT SELECT ON stats_universos TO anon;
