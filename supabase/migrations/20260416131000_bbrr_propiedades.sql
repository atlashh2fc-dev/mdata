CREATE TABLE IF NOT EXISTS bbrr_propiedades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rol VARCHAR(32) NOT NULL,
  manzana VARCHAR(16),
  predio VARCHAR(16),
  direccion VARCHAR(255),
  comuna VARCHAR(120),
  tipo_propiedad VARCHAR(120),
  destino VARCHAR(120),
  avaluo_fiscal NUMERIC(18,2),
  rutid VARCHAR(20),
  nombre_razon_social VARCHAR(255),
  fono_area_comer VARCHAR(8),
  fono_numero_comer VARCHAR(32),
  fono_area_part VARCHAR(8),
  fono_numero_part VARCHAR(32),
  fono_area_cel VARCHAR(8),
  fono_numero_cel VARCHAR(32),
  email VARCHAR(255),
  source_file TEXT,
  source_loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bbrr_propiedades_rol_key UNIQUE (rol)
);

CREATE INDEX IF NOT EXISTS idx_bbrr_propiedades_rutid
  ON bbrr_propiedades (rutid);

CREATE INDEX IF NOT EXISTS idx_bbrr_propiedades_comuna
  ON bbrr_propiedades (comuna);

CREATE INDEX IF NOT EXISTS idx_bbrr_propiedades_destino
  ON bbrr_propiedades (destino);

CREATE INDEX IF NOT EXISTS idx_bbrr_propiedades_tipo_propiedad
  ON bbrr_propiedades (tipo_propiedad);

CREATE INDEX IF NOT EXISTS idx_bbrr_propiedades_avaluo
  ON bbrr_propiedades (avaluo_fiscal DESC);

INSERT INTO data_sources (
  name,
  slug,
  description,
  source_type,
  canonical_table,
  source_table_name,
  primary_key_column,
  supports_incremental,
  is_active
)
VALUES (
  'BBRR propiedades',
  'bbrr_propiedades',
  'Detalle granular de bienes raices por rol y rutid.',
  'csv',
  'bbrr_propiedades',
  'BD_BBRR_MKT4102',
  'rol',
  TRUE,
  TRUE
)
ON CONFLICT (slug) DO UPDATE
SET
  description = EXCLUDED.description,
  canonical_table = EXCLUDED.canonical_table,
  source_table_name = EXCLUDED.source_table_name,
  primary_key_column = EXCLUDED.primary_key_column,
  supports_incremental = EXCLUDED.supports_incremental,
  is_active = TRUE,
  updated_at = NOW();
