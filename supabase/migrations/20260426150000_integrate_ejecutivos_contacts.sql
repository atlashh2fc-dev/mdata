CREATE OR REPLACE FUNCTION public.normalize_ejecutivo_phone(area_value text, number_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  area_digits text := regexp_replace(coalesce(area_value, ''), '\D', '', 'g');
  number_digits text := regexp_replace(coalesce(number_value, ''), '\D', '', 'g');
  digits text;
BEGIN
  IF number_digits = '' THEN
    RETURN NULL;
  END IF;

  digits := area_digits || number_digits;

  IF left(digits, 2) = '56' AND length(digits) >= 10 THEN
    RETURN '+' || digits;
  END IF;

  IF area_digits = '9' AND length(number_digits) = 8 THEN
    RETURN '+56' || area_digits || number_digits;
  END IF;

  IF area_digits = '' AND left(number_digits, 1) = '9' AND length(number_digits) = 9 THEN
    RETURN '+56' || number_digits;
  END IF;

  IF area_digits <> '' AND length(number_digits) >= 6 THEN
    RETURN '+56' || area_digits || number_digits;
  END IF;

  IF area_digits = '' AND length(number_digits) = 8 THEN
    RETURN '+562' || number_digits;
  END IF;

  IF area_digits = '' AND length(number_digits) >= 9 THEN
    RETURN number_digits;
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.ejecutivo_contact_priority(cargo_value text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN upper(coalesce(cargo_value, '')) LIKE '%REPRESENTANTE%LEGAL%' THEN 100
    WHEN upper(coalesce(cargo_value, '')) LIKE '%ADMINISTRADOR%' THEN 96
    WHEN upper(coalesce(cargo_value, '')) LIKE '%SOCIO%' THEN 94
    WHEN upper(coalesce(cargo_value, '')) LIKE '%DUEÑO%' THEN 92
    WHEN upper(coalesce(cargo_value, '')) LIKE '%DUENO%' THEN 92
    WHEN upper(coalesce(cargo_value, '')) LIKE '%PROPIETARIO%' THEN 92
    WHEN upper(coalesce(cargo_value, '')) LIKE '%GERENTE GENERAL%' THEN 90
    WHEN upper(coalesce(cargo_value, '')) LIKE '%DIRECTOR%' THEN 88
    WHEN upper(coalesce(cargo_value, '')) LIKE '%GERENTE%' THEN 84
    WHEN upper(coalesce(cargo_value, '')) LIKE '%CONTACTO%' THEN 76
    ELSE 70
  END
$$;

CREATE OR REPLACE VIEW public.company_best_executive_contact AS
WITH normalized AS (
  SELECT
    e.id,
    e.rutid,
    e.razon_social,
    e.rutid_ejecutivo,
    e.nombre_ejecutivo,
    e.area,
    e.cargo,
    lower(nullif(trim(e.email), '')) AS email,
    public.normalize_ejecutivo_phone(e.fono_area_cel, e.fono_numero_cel) AS celular,
    public.normalize_ejecutivo_phone(e.fono_area_comer, e.fono_numero_comer) AS telefono_comercial,
    public.ejecutivo_contact_priority(e.cargo) AS contact_priority,
    e.source_loaded_at
  FROM public.ejecutivos e
  WHERE nullif(trim(e.rutid), '') IS NOT NULL
    AND nullif(trim(e.nombre_ejecutivo), '') IS NOT NULL
)
SELECT DISTINCT ON (rutid)
  rutid,
  razon_social,
  rutid_ejecutivo,
  nombre_ejecutivo,
  area,
  cargo,
  email,
  celular,
  telefono_comercial,
  COALESCE(celular, telefono_comercial) AS mejor_telefono,
  contact_priority,
  source_loaded_at
FROM normalized
ORDER BY
  rutid,
  contact_priority DESC,
  (celular IS NOT NULL) DESC,
  (email IS NOT NULL) DESC,
  id ASC;

CREATE OR REPLACE FUNCTION public.sync_ejecutivos_contact_points()
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  phone_rows integer := 0;
  email_rows integer := 0;
  refreshed_rows integer := 0;
BEGIN
  WITH phone_points AS (
    SELECT
      e.rutid,
      'phone'::text AS contact_type,
      phone.contact_value,
      phone.contact_value AS normalized_value,
      'ejecutivos'::text AS source_name,
      95 AS source_priority,
      public.ejecutivo_contact_priority(e.cargo) AS quality_score,
      public.ejecutivo_contact_priority(e.cargo) >= 90 AS is_primary,
      TRUE AS is_verified,
      jsonb_build_object(
        'razon_social', e.razon_social,
        'rutid_ejecutivo', e.rutid_ejecutivo,
        'nombre_ejecutivo', e.nombre_ejecutivo,
        'cargo', e.cargo,
        'area', e.area,
        'source_table', 'ejecutivos'
      ) AS metadata
    FROM public.ejecutivos e
    JOIN public.personas_master pm ON pm.rutid = e.rutid
    CROSS JOIN LATERAL (
      SELECT public.normalize_ejecutivo_phone(e.fono_area_cel, e.fono_numero_cel) AS contact_value
      UNION ALL
      SELECT public.normalize_ejecutivo_phone(e.fono_area_comer, e.fono_numero_comer)
    ) phone
    WHERE phone.contact_value IS NOT NULL
  ),
  upserted AS (
    INSERT INTO public.persona_contact_points (
      rutid,
      contact_type,
      contact_value,
      normalized_value,
      source_name,
      source_priority,
      quality_score,
      is_primary,
      is_verified,
      is_deliverable,
      first_seen_at,
      last_seen_at,
      metadata
    )
    SELECT DISTINCT ON (rutid, contact_type, normalized_value)
      rutid,
      contact_type,
      contact_value,
      normalized_value,
      source_name,
      source_priority,
      quality_score,
      is_primary,
      is_verified,
      NULL::boolean,
      NOW(),
      NOW(),
      metadata
    FROM phone_points
    ORDER BY rutid, contact_type, normalized_value, quality_score DESC
    ON CONFLICT (rutid, contact_type, normalized_value) DO UPDATE SET
      source_name = EXCLUDED.source_name,
      source_priority = GREATEST(persona_contact_points.source_priority, EXCLUDED.source_priority),
      quality_score = GREATEST(persona_contact_points.quality_score, EXCLUDED.quality_score),
      is_primary = persona_contact_points.is_primary OR EXCLUDED.is_primary,
      is_verified = persona_contact_points.is_verified OR EXCLUDED.is_verified,
      last_seen_at = NOW(),
      metadata = persona_contact_points.metadata || EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING 1
  )
  SELECT COUNT(*) INTO phone_rows FROM upserted;

  WITH email_points AS (
    SELECT
      e.rutid,
      'email'::text AS contact_type,
      lower(trim(e.email)) AS contact_value,
      lower(trim(e.email)) AS normalized_value,
      'ejecutivos'::text AS source_name,
      92 AS source_priority,
      public.ejecutivo_contact_priority(e.cargo) AS quality_score,
      public.ejecutivo_contact_priority(e.cargo) >= 90 AS is_primary,
      TRUE AS is_verified,
      jsonb_build_object(
        'razon_social', e.razon_social,
        'rutid_ejecutivo', e.rutid_ejecutivo,
        'nombre_ejecutivo', e.nombre_ejecutivo,
        'cargo', e.cargo,
        'area', e.area,
        'source_table', 'ejecutivos'
      ) AS metadata
    FROM public.ejecutivos e
    JOIN public.personas_master pm ON pm.rutid = e.rutid
    WHERE nullif(trim(e.email), '') IS NOT NULL
  ),
  upserted AS (
    INSERT INTO public.persona_contact_points (
      rutid,
      contact_type,
      contact_value,
      normalized_value,
      source_name,
      source_priority,
      quality_score,
      is_primary,
      is_verified,
      is_deliverable,
      first_seen_at,
      last_seen_at,
      metadata
    )
    SELECT DISTINCT ON (rutid, contact_type, normalized_value)
      rutid,
      contact_type,
      contact_value,
      normalized_value,
      source_name,
      source_priority,
      quality_score,
      is_primary,
      is_verified,
      NULL::boolean,
      NOW(),
      NOW(),
      metadata
    FROM email_points
    ORDER BY rutid, contact_type, normalized_value, quality_score DESC
    ON CONFLICT (rutid, contact_type, normalized_value) DO UPDATE SET
      source_name = EXCLUDED.source_name,
      source_priority = GREATEST(persona_contact_points.source_priority, EXCLUDED.source_priority),
      quality_score = GREATEST(persona_contact_points.quality_score, EXCLUDED.quality_score),
      is_primary = persona_contact_points.is_primary OR EXCLUDED.is_primary,
      is_verified = persona_contact_points.is_verified OR EXCLUDED.is_verified,
      last_seen_at = NOW(),
      metadata = persona_contact_points.metadata || EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING 1
  )
  SELECT COUNT(*) INTO email_rows FROM upserted;

  SELECT public.refresh_persona_scores(
    ARRAY(
      SELECT DISTINCT rutid
      FROM public.ejecutivos
      WHERE nullif(trim(rutid), '') IS NOT NULL
    )
  ) INTO refreshed_rows;

  RETURN jsonb_build_object(
    'phone_points_upserted', phone_rows,
    'email_points_upserted', email_rows,
    'persona_scores_refreshed', refreshed_rows
  );
END;
$$;
