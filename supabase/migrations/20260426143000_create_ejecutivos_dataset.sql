CREATE TABLE IF NOT EXISTS public.ejecutivos (
  id BIGSERIAL PRIMARY KEY,
  rutid VARCHAR(20),
  razon_social TEXT,
  rutid_ejecutivo VARCHAR(20),
  nombre_ejecutivo TEXT,
  area TEXT,
  cargo TEXT,
  fono_area_cel TEXT,
  fono_numero_cel TEXT,
  fecha_fono_cel TEXT,
  fono_area_comer TEXT,
  fono_numero_comer TEXT,
  fecha_fono_comer TEXT,
  email TEXT,
  fecha_email TEXT,
  rut_num1 BIGINT,
  source_loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ejecutivos_source_unique
  ON public.ejecutivos (
    COALESCE(rutid, ''),
    COALESCE(rutid_ejecutivo, ''),
    COALESCE(nombre_ejecutivo, ''),
    COALESCE(cargo, ''),
    COALESCE(email, '')
  );

CREATE INDEX IF NOT EXISTS idx_ejecutivos_rutid
  ON public.ejecutivos (rutid);

CREATE INDEX IF NOT EXISTS idx_ejecutivos_rutid_ejecutivo
  ON public.ejecutivos (rutid_ejecutivo);

CREATE INDEX IF NOT EXISTS idx_ejecutivos_cargo
  ON public.ejecutivos (cargo);

CREATE INDEX IF NOT EXISTS idx_ejecutivos_razon_social_trgm
  ON public.ejecutivos USING gin (razon_social gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_ejecutivos_nombre_trgm
  ON public.ejecutivos USING gin (nombre_ejecutivo gin_trgm_ops);

INSERT INTO public.data_sources (
  name,
  slug,
  description,
  source_type,
  canonical_table,
  source_table_name,
  primary_key_column,
  supports_incremental,
  is_active,
  last_job_status
)
VALUES (
  'Ejecutivos empresas',
  'ejecutivos',
  'Representantes legales, socios, administradores y contactos ejecutivos asociados a empresas.',
  'mysql',
  'ejecutivos',
  'ejecutivos',
  'id',
  TRUE,
  TRUE,
  'pending'
)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  source_type = EXCLUDED.source_type,
  canonical_table = EXCLUDED.canonical_table,
  source_table_name = EXCLUDED.source_table_name,
  primary_key_column = EXCLUDED.primary_key_column,
  supports_incremental = EXCLUDED.supports_incremental,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();
