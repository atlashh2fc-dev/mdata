SET statement_timeout = 0;
SET lock_timeout = 0;

CREATE OR REPLACE FUNCTION public.person_name_tokens(input text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    ARRAY(
      SELECT token
      FROM (
        SELECT DISTINCT token
        FROM unnest(string_to_array(public.normalize_person_name(input), ' ')) AS item(token)
        WHERE char_length(token) >= 2
      ) deduped
      ORDER BY token
    ),
    ARRAY[]::text[]
  );
$$;

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
    SELECT DISTINCT
      public.normalize_person_name(value) AS match_key,
      public.person_name_tokens(value) AS tokens
    FROM unnest(COALESCE(input_names, ARRAY[]::text[])) AS value
    WHERE public.normalize_person_name(value) IS NOT NULL
  )
  SELECT DISTINCT
    keys.match_key,
    pm.rutid,
    btrim(coalesce(pm.nombres, '') || ' ' || coalesce(pm.paterno, '') || ' ' || coalesce(pm.materno, ''))::varchar(500) AS nombre_completo
  FROM keys
  JOIN public.personas_master pm
    ON cardinality(keys.tokens) > 0
   AND public.person_name_tokens(
     btrim(coalesce(pm.nombres, '') || ' ' || coalesce(pm.paterno, '') || ' ' || coalesce(pm.materno, ''))
   ) @> keys.tokens;
$$;

GRANT EXECUTE ON FUNCTION public.person_name_tokens(text) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.match_person_names(text[]) TO authenticated, anon, service_role;

NOTIFY pgrst, 'reload schema';
