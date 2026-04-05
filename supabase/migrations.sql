-- ============================================================
-- MIGRACIONES ADICIONALES
-- Ejecutar DESPUÉS del schema principal
-- ============================================================

-- ---------------------------------------------------------------
-- Índices adicionales para performance en búsquedas frecuentes
-- ---------------------------------------------------------------

-- Búsqueda por nombre completo
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pernat_nombre_completo
ON pernat_resumen USING gin(
  (TRIM(CONCAT(
    COALESCE(nombres,''), ' ',
    COALESCE(paterno,''), ' ',
    COALESCE(materno,'')
  ))) gin_trgm_ops
);

-- Índice de cobertura para queries frecuentes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pernat_composite
ON pernat_resumen (rutid, region_part, comuna_part)
WHERE email IS NOT NULL;

-- ---------------------------------------------------------------
-- Vista materializada por región para dashboard
-- ---------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS stats_por_region AS
SELECT
  COALESCE(region_part, 'Sin región') AS region,
  COUNT(*)                             AS total,
  COUNT(email)                         AS con_email,
  COUNT(fono_cel)                      AS con_fono
FROM pernat_resumen
GROUP BY region_part
ORDER BY COUNT(*) DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_stats_por_region ON stats_por_region (region);

-- ---------------------------------------------------------------
-- Vista materializada score distribution
-- ---------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS stats_score_dist AS
SELECT
  CASE
    WHEN sc = 0         THEN '0'
    WHEN sc BETWEEN 1  AND 20  THEN '1-20'
    WHEN sc BETWEEN 21 AND 40  THEN '21-40'
    WHEN sc BETWEEN 41 AND 60  THEN '41-60'
    WHEN sc BETWEEN 61 AND 80  THEN '61-80'
    ELSE '81+'
  END AS range,
  COUNT(*) AS count
FROM (
  SELECT (
    COALESCE(ar.n_autos, 0) * 10 +
    COALESCE(ac.n_bienes_raices, 0) * 20 +
    CASE WHEN er.razon_social_empresa IS NOT NULL THEN 15 ELSE 0 END +
    CASE WHEN pr.email IS NOT NULL THEN 5 ELSE 0 END +
    CASE WHEN pr.fono_cel IS NOT NULL THEN 5 ELSE 0 END
  ) AS sc
  FROM master_personas mp
  LEFT JOIN pernat_resumen    pr ON pr.rutid = mp.rutid
  LEFT JOIN autos_resumen     ar ON ar.rutid = mp.rutid
  LEFT JOIN empresa_resumen   er ON er.rutid = mp.rutid
  LEFT JOIN acumulado_resumen ac ON ac.rutid = mp.rutid
) scores
GROUP BY range
ORDER BY range;

-- ---------------------------------------------------------------
-- Función para refrescar todas las vistas materializadas
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_all_stats()
RETURNS VOID AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_stats;
  REFRESH MATERIALIZED VIEW CONCURRENTLY stats_por_region;
  REFRESH MATERIALIZED VIEW CONCURRENTLY stats_score_dist;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------
-- Storage bucket para archivos de ingesta
-- (requiere ejecutar desde Supabase Dashboard o CLI)
-- ---------------------------------------------------------------
-- INSERT INTO storage.buckets (id, name, public) VALUES ('ingestion-files', 'ingestion-files', false);

-- Policy para archivos de ingesta
-- CREATE POLICY "auth_upload_ingestion"
--   ON storage.objects FOR INSERT TO authenticated
--   WITH CHECK (bucket_id = 'ingestion-files');

-- ---------------------------------------------------------------
-- Trigger de audit log automático
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_trigger_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_logs (action, entity, entity_id, new_data)
    VALUES (TG_OP, TG_TABLE_NAME, NEW::TEXT, to_jsonb(NEW));
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO audit_logs (action, entity, entity_id, old_data, new_data)
    VALUES (TG_OP, TG_TABLE_NAME, OLD::TEXT, to_jsonb(OLD), to_jsonb(NEW));
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO audit_logs (action, entity, entity_id, old_data)
    VALUES (TG_OP, TG_TABLE_NAME, OLD::TEXT, to_jsonb(OLD));
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Aplicar a segmentos y data_sources
CREATE OR REPLACE TRIGGER audit_segmentos
  AFTER INSERT OR UPDATE OR DELETE ON segmentos
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

CREATE OR REPLACE TRIGGER audit_data_sources
  AFTER INSERT OR UPDATE OR DELETE ON data_sources
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
