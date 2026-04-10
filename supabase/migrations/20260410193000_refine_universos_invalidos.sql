CREATE OR REPLACE FUNCTION public.classify_personas_master_entity(
  p_rutid VARCHAR,
  p_nombres VARCHAR,
  p_paterno VARCHAR,
  p_materno VARCHAR,
  p_razon_social_empresa VARCHAR
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  WITH normalized AS (
    SELECT regexp_replace(upper(COALESCE(p_rutid, '')), '[^0-9K]', '', 'g') AS rut_clean
  )
  SELECT CASE
    WHEN rut_clean IN ('', '0000000000')
      THEN 'basura'
    WHEN rut_clean ~ '^[0-9]{9}[0-9K]$'
      THEN CASE
        WHEN COALESCE(
          NULLIF(BTRIM(p_nombres), ''),
          NULLIF(BTRIM(p_paterno), ''),
          NULLIF(BTRIM(p_materno), '')
        ) IS NOT NULL
          THEN 'persona_natural'
        WHEN NULLIF(BTRIM(p_razon_social_empresa), '') IS NOT NULL
          THEN 'persona_juridica'
        ELSE 'indeterminado'
      END
    WHEN length(rut_clean) BETWEEN 2 AND 9
      AND rut_clean ~ '^[0-9]+[0-9K]$'
      THEN 'rut_recuperable'
    ELSE 'basura'
  END
  FROM normalized
$$;

CREATE OR REPLACE VIEW public.personas_master_clasificada AS
SELECT
  pm.*,
  public.classify_personas_master_entity(
    pm.rutid,
    pm.nombres,
    pm.paterno,
    pm.materno,
    pm.razon_social_empresa
  ) AS entidad_tipo,
  (
    COALESCE(
      NULLIF(BTRIM(pm.nombres), ''),
      NULLIF(BTRIM(pm.paterno), ''),
      NULLIF(BTRIM(pm.materno), '')
    ) IS NOT NULL
  ) AS con_nombre_real
FROM public.personas_master pm;

DROP MATERIALIZED VIEW IF EXISTS public.stats_universos;

CREATE MATERIALIZED VIEW public.stats_universos AS
WITH flags AS (
  SELECT
    entidad_tipo,
    con_nombre_real AS con_nombre,
    (NULLIF(BTRIM(email), '') IS NOT NULL) AS con_email,
    (NULLIF(BTRIM(fono_cel), '') IS NOT NULL) AS con_fono,
    (n_autos > 0) AS con_autos,
    (NULLIF(BTRIM(razon_social_empresa), '') IS NOT NULL) AS con_empresa,
    (
      COALESCE(
        NULLIF(BTRIM(region_part), ''),
        NULLIF(BTRIM(comuna_part), ''),
        NULLIF(BTRIM(domicilio_region), ''),
        NULLIF(BTRIM(domicilio_comuna), '')
      ) IS NOT NULL
    ) AS con_domicilio,
    (COALESCE(n_bienes_raices, 0) > 0 OR COALESCE(totalavaluos, 0) > 0) AS con_bienes_raices
  FROM public.personas_master_clasificada
)
SELECT
  entidad_tipo,
  con_nombre,
  con_email,
  con_fono,
  con_autos,
  con_empresa,
  con_domicilio,
  con_bienes_raices,
  COUNT(*)::BIGINT AS total
FROM flags
GROUP BY
  entidad_tipo,
  con_nombre,
  con_email,
  con_fono,
  con_autos,
  con_empresa,
  con_domicilio,
  con_bienes_raices;

CREATE UNIQUE INDEX idx_stats_universos ON public.stats_universos (
  entidad_tipo,
  con_nombre,
  con_email,
  con_fono,
  con_autos,
  con_empresa,
  con_domicilio,
  con_bienes_raices
);
