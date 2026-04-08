CREATE TABLE IF NOT EXISTS public.company_contact_enrichment_cache (
  match_key text PRIMARY KEY,
  rutid varchar(20),
  company_name text NOT NULL,
  website text,
  emails text[] NOT NULL DEFAULT '{}'::text[],
  phones text[] NOT NULL DEFAULT '{}'::text[],
  source_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  enrichment_status text NOT NULL DEFAULT 'none',
  searched_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS public.company_contact_enrichment_cache
  ADD COLUMN IF NOT EXISTS rutid varchar(20);

CREATE INDEX IF NOT EXISTS idx_company_contact_enrichment_cache_searched_at
  ON public.company_contact_enrichment_cache (searched_at DESC);
