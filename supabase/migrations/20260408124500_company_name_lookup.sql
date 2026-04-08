CREATE TABLE IF NOT EXISTS public.company_name_lookup (
  rutid varchar(20) PRIMARY KEY,
  razon_social_empresa varchar(255) NOT NULL,
  match_key text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_company_name_lookup_match_key
  ON public.company_name_lookup (match_key);

CREATE OR REPLACE FUNCTION public.refresh_company_name_lookup()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  TRUNCATE TABLE public.company_name_lookup;

  INSERT INTO public.company_name_lookup (rutid, razon_social_empresa, match_key)
  SELECT
    pm.rutid,
    pm.razon_social_empresa,
    public.normalize_company_name(pm.razon_social_empresa) AS match_key
  FROM public.personas_master pm
  WHERE pm.razon_social_empresa IS NOT NULL
    AND public.normalize_company_name(pm.razon_social_empresa) IS NOT NULL;
END;
$$;

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
    lookup.rutid,
    lookup.razon_social_empresa
  FROM keys
  JOIN public.company_name_lookup lookup
    ON lookup.match_key = keys.match_key;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_company_name_lookup() TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.match_company_names(text[]) TO authenticated, anon, service_role;
