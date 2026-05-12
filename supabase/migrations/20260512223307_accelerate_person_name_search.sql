SET statement_timeout = 0;
SET lock_timeout = 0;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION public.person_name_tokens(input text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET statement_timeout = 0
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

CREATE INDEX IF NOT EXISTS idx_pm_nombre_trgm
  ON public.personas_master USING gin (
    ((coalesce(nombres, '') || ' ' || coalesce(paterno, '') || ' ' || coalesce(materno, '')) gin_trgm_ops)
  );

ANALYZE public.personas_master;

NOTIFY pgrst, 'reload schema';
