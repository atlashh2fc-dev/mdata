CREATE TABLE IF NOT EXISTS padron_personas_raw (
  rutid VARCHAR(10) PRIMARY KEY,
  dv VARCHAR(1),
  nombre VARCHAR(255),
  sexo VARCHAR(30),
  direccion TEXT,
  circunscripcion VARCHAR(150),
  comuna VARCHAR(100),
  region VARCHAR(100),
  source_file VARCHAR(255),
  source_dataset VARCHAR(100),
  loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_padron_personas_raw_region
  ON padron_personas_raw (region);

CREATE INDEX IF NOT EXISTS idx_padron_personas_raw_comuna
  ON padron_personas_raw (comuna);
