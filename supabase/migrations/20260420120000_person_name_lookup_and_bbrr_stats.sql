CREATE OR REPLACE FUNCTION public.normalize_person_name(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(
    trim(
      regexp_replace(
        upper(
          translate(
            COALESCE(input, ''),
            'ÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑáàäâãéèëêíìïîóòöôõúùüûñ',
            'AAAAAEEEEIIIIOOOOOUUUUNaaaaaeeeeiiiiooooouuuun'
          )
        ),
        '[^A-Z0-9]+',
        ' ',
        'g'
      )
    ),
    ''
  );
$$;

CREATE INDEX IF NOT EXISTS idx_personas_master_person_name_match_key
  ON public.personas_master (
    public.normalize_person_name(
      COALESCE(
        nombre_completo,
        NULLIF(TRIM(CONCAT(COALESCE(nombres, ''), ' ', COALESCE(paterno, ''), ' ', COALESCE(materno, ''))), '')
      )
    )
  )
  WHERE COALESCE(
    nombre_completo,
    NULLIF(TRIM(CONCAT(COALESCE(nombres, ''), ' ', COALESCE(paterno, ''), ' ', COALESCE(materno, ''))), '')
  ) IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_personas_master_person_last_first_match_key
  ON public.personas_master (
    public.normalize_person_name(
      NULLIF(TRIM(CONCAT(COALESCE(paterno, ''), ' ', COALESCE(materno, ''), ' ', COALESCE(nombres, ''))), '')
    )
  )
  WHERE NULLIF(TRIM(CONCAT(COALESCE(paterno, ''), ' ', COALESCE(materno, ''), ' ', COALESCE(nombres, ''))), '') IS NOT NULL;

CREATE OR REPLACE FUNCTION public.match_person_names(input_names text[])
RETURNS TABLE (
  match_key text,
  rutid varchar(20),
  nombre_completo varchar(500)
)
LANGUAGE sql
STABLE
AS $$
  WITH keys AS (
    SELECT DISTINCT public.normalize_person_name(value) AS match_key
    FROM unnest(COALESCE(input_names, ARRAY[]::text[])) AS value
    WHERE public.normalize_person_name(value) IS NOT NULL
  ),
  full_name_matches AS (
    SELECT
      keys.match_key,
      pm.rutid,
      COALESCE(
        pm.nombre_completo,
        NULLIF(TRIM(CONCAT(COALESCE(pm.nombres, ''), ' ', COALESCE(pm.paterno, ''), ' ', COALESCE(pm.materno, ''))), '')
      )::varchar(500) AS nombre_completo
    FROM keys
    JOIN public.personas_master pm
      ON public.normalize_person_name(
        COALESCE(
          pm.nombre_completo,
          NULLIF(TRIM(CONCAT(COALESCE(pm.nombres, ''), ' ', COALESCE(pm.paterno, ''), ' ', COALESCE(pm.materno, ''))), '')
        )
      ) = keys.match_key
  ),
  last_first_matches AS (
    SELECT
      keys.match_key,
      pm.rutid,
      COALESCE(
        pm.nombre_completo,
        NULLIF(TRIM(CONCAT(COALESCE(pm.nombres, ''), ' ', COALESCE(pm.paterno, ''), ' ', COALESCE(pm.materno, ''))), '')
      )::varchar(500) AS nombre_completo
    FROM keys
    JOIN public.personas_master pm
      ON public.normalize_person_name(
        NULLIF(TRIM(CONCAT(COALESCE(pm.paterno, ''), ' ', COALESCE(pm.materno, ''), ' ', COALESCE(pm.nombres, ''))), '')
      ) = keys.match_key
  )
  SELECT DISTINCT match_key, rutid, nombre_completo
  FROM full_name_matches
  UNION
  SELECT DISTINCT match_key, rutid, nombre_completo
  FROM last_first_matches;
$$;

GRANT EXECUTE ON FUNCTION public.normalize_person_name(text) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.match_person_names(text[]) TO authenticated, anon, service_role;

DROP MATERIALIZED VIEW IF EXISTS public.dashboard_stats;
CREATE MATERIALIZED VIEW public.dashboard_stats AS
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
  COALESCE((SELECT COUNT(*) FROM public.bbrr_propiedades), 0)::BIGINT AS total_propiedades_cargadas,
  (SELECT COUNT(*) FROM ingestion_jobs WHERE status = 'completed') AS jobs_completados,
  (SELECT COUNT(*) FROM ingestion_jobs WHERE status = 'failed') AS jobs_fallidos,
  (SELECT COUNT(*) FROM segmentos WHERE is_active = TRUE) AS total_segmentos,
  NOW() AS last_refreshed
FROM public.master_personas_view;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_stats ON public.dashboard_stats ((1));

CREATE OR REPLACE FUNCTION public.refresh_dashboard_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW public.dashboard_stats;
  REFRESH MATERIALIZED VIEW public.stats_por_region;
  REFRESH MATERIALIZED VIEW public.stats_score_dist;

  BEGIN
    REFRESH MATERIALIZED VIEW public.stats_universos;
  EXCEPTION WHEN undefined_table THEN
    NULL;
  END;
END;
$$;

GRANT SELECT ON public.dashboard_stats TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_dashboard_stats() TO authenticated, anon, service_role;
