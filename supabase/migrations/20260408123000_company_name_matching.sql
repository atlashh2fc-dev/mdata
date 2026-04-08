CREATE OR REPLACE FUNCTION public.normalize_company_name(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(
    trim(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(
                    upper(
                      translate(
                        COALESCE(input, ''),
                        'ÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑáàäâãéèëêíìïîóòöôõúùüûñ',
                        'AAAAAEEEEIIIIOOOOOUUUUNaaaaaeeeeiiiiooooouuuun'
                      )
                    ),
                    '\mSOCIEDAD POR ACCIONES\M',
                    ' ',
                    'g'
                  ),
                  '\mSOCIEDAD ANONIMA\M',
                  ' ',
                  'g'
                ),
                '\mRESPONSABILIDAD LIMITADA\M',
                ' ',
                'g'
              ),
              '\mE\s*I\s*R\s*L\M',
              ' ',
              'g'
            ),
            '&',
            ' Y ',
            'g'
          ),
          '[^A-Z0-9]+',
          ' ',
          'g'
        ),
        '(\s+(SPA|LTDA|LIMITADA|SA|SAS))+$',
        '',
        'g'
      )
    ),
    ''
  );
$$;

CREATE INDEX IF NOT EXISTS idx_personas_master_company_match_key
  ON public.personas_master (public.normalize_company_name(razon_social_empresa))
  WHERE razon_social_empresa IS NOT NULL;

CREATE OR REPLACE FUNCTION public.match_company_names(input_names text[])
RETURNS TABLE (
  match_key text,
  rutid varchar(20),
  razon_social_empresa varchar(255)
)
LANGUAGE sql
STABLE
AS $$
  WITH keys AS (
    SELECT DISTINCT public.normalize_company_name(value) AS match_key
    FROM unnest(COALESCE(input_names, ARRAY[]::text[])) AS value
    WHERE public.normalize_company_name(value) IS NOT NULL
  )
  SELECT
    keys.match_key,
    pm.rutid,
    pm.razon_social_empresa
  FROM keys
  JOIN public.personas_master pm
    ON public.normalize_company_name(pm.razon_social_empresa) = keys.match_key;
$$;

GRANT EXECUTE ON FUNCTION public.normalize_company_name(text) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.match_company_names(text[]) TO authenticated, anon, service_role;
