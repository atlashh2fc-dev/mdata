#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.local}"
CSV_FILE="${1:-${WOM_LATEST_CSV:-/tmp/wom_latest_per_rut.csv}}"
LOAD_CHUNK_ROWS="${LOAD_CHUNK_ROWS:-100000}"
CHUNK_DIR="${CHUNK_DIR:-${TMPDIR:-/tmp}/wom-latest-chunks}"
SOURCE_NAME="${SOURCE_NAME:-wom_customer_base}"
SKIP_LOAD="${SKIP_LOAD:-0}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "No existe ENV_FILE: $ENV_FILE" >&2
  exit 1
fi

if [[ ! -f "$CSV_FILE" ]]; then
  echo "No existe CSV_FILE: $CSV_FILE" >&2
  exit 1
fi

if ! [[ "$LOAD_CHUNK_ROWS" =~ ^[0-9]+$ ]] || [[ "$LOAD_CHUNK_ROWS" -lt 1000 ]]; then
  echo "LOAD_CHUNK_ROWS invalido: $LOAD_CHUNK_ROWS" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

export PGOPTIONS='-c statement_timeout=0'

if [[ "$SKIP_LOAD" != "1" ]]; then
  mkdir -p "$CHUNK_DIR"
  rm -f "$CHUNK_DIR"/chunk_*.csv

  HEADER_LINE="$(head -n 1 "$CSV_FILE")"
  tail -n +2 "$CSV_FILE" | split -l "$LOAD_CHUNK_ROWS" - "$CHUNK_DIR/chunk_"

  for RAW_CHUNK in "$CHUNK_DIR"/chunk_*; do
    [[ -f "$RAW_CHUNK" ]] || continue
    HEADER_CHUNK="${RAW_CHUNK}.csv"
    {
      printf '%s\n' "$HEADER_LINE"
      cat "$RAW_CHUNK"
    } > "$HEADER_CHUNK"
    rm -f "$RAW_CHUNK"
  done
fi

psql "$POSTGRES_URL_NON_POOLING" <<SQL
\set ON_ERROR_STOP on
SET statement_timeout = 0;
CREATE TABLE IF NOT EXISTS public.wom_customer_signals (
  rutid VARCHAR(20) PRIMARY KEY,
  nombre TEXT,
  telefono TEXT,
  email TEXT,
  email_normalized TEXT,
  direccion TEXT,
  comuna TEXT,
  ciclo_raw TEXT,
  ciclo_date DATE,
  lineas INTEGER,
  valor INTEGER,
  source_name TEXT NOT NULL DEFAULT '${SOURCE_NAME}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wom_customer_signals_email
  ON public.wom_customer_signals (email_normalized);
CREATE INDEX IF NOT EXISTS idx_wom_customer_signals_comuna
  ON public.wom_customer_signals (comuna);
CREATE INDEX IF NOT EXISTS idx_wom_customer_signals_ciclo
  ON public.wom_customer_signals (ciclo_date DESC);
CREATE INDEX IF NOT EXISTS idx_wom_customer_signals_prefix
  ON public.wom_customer_signals ((LEFT(rutid, 2)));
SQL

if [[ "$SKIP_LOAD" != "1" ]]; then
  LOAD_CHUNK_COUNT=0
  for CHUNK_FILE in "$CHUNK_DIR"/chunk_*.csv; do
    [[ -f "$CHUNK_FILE" ]] || continue
    LOAD_CHUNK_COUNT=$((LOAD_CHUNK_COUNT + 1))
  done

  echo "Fase 1/2: cargando WOM a public.wom_customer_signals"
  echo "Procesando $LOAD_CHUNK_COUNT chunks desde $CSV_FILE con bloques de $LOAD_CHUNK_ROWS filas"

  for CHUNK_FILE in "$CHUNK_DIR"/chunk_*.csv; do
    [[ -f "$CHUNK_FILE" ]] || continue
    echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) :: load start $(basename "$CHUNK_FILE") ====="

    psql "$POSTGRES_URL_NON_POOLING" <<SQL
\set ON_ERROR_STOP on
\timing on
BEGIN;
CREATE TEMP TABLE wom_stage_raw (
  rutid TEXT,
  nombre TEXT,
  telefono TEXT,
  email TEXT,
  direccion TEXT,
  comuna TEXT,
  ciclo TEXT,
  lineas TEXT,
  valor TEXT
);
CREATE TEMP TABLE wom_stage (
  rutid TEXT,
  nombre TEXT,
  telefono TEXT,
  email TEXT,
  email_normalized TEXT,
  direccion TEXT,
  comuna TEXT,
  ciclo_raw TEXT,
  ciclo_date DATE,
  lineas INTEGER,
  valor INTEGER
);
\copy wom_stage_raw FROM '$CHUNK_FILE' WITH (FORMAT csv, HEADER true)
INSERT INTO wom_stage (
  rutid,
  nombre,
  telefono,
  email,
  email_normalized,
  direccion,
  comuna,
  ciclo_raw,
  ciclo_date,
  lineas,
  valor
)
SELECT
  NULLIF(BTRIM(rutid), ''),
  NULLIF(BTRIM(nombre), ''),
  NULLIF(BTRIM(telefono), ''),
  NULLIF(BTRIM(email), ''),
  CASE
    WHEN POSITION('@' IN LOWER(BTRIM(COALESCE(email, '')))) > 1 THEN LOWER(BTRIM(email))
    ELSE NULL
  END,
  NULLIF(BTRIM(direccion), ''),
  NULLIF(BTRIM(comuna), ''),
  NULLIF(BTRIM(ciclo), ''),
  CASE
    WHEN BTRIM(COALESCE(ciclo, '')) ~ '^[0-3][0-9]-[0-1][0-9]-[1-2][0-9]{3}$' THEN TO_DATE(BTRIM(ciclo), 'DD-MM-YYYY')
    ELSE NULL
  END,
  CASE
    WHEN BTRIM(COALESCE(lineas, '')) ~ '^[0-9]+$' THEN BTRIM(lineas)::INTEGER
    ELSE NULL
  END,
  CASE
    WHEN REPLACE(BTRIM(COALESCE(valor, '')), '.', '') ~ '^[0-9]+$' THEN REPLACE(BTRIM(valor), '.', '')::INTEGER
    ELSE NULL
  END
FROM wom_stage_raw
WHERE NULLIF(BTRIM(rutid), '') IS NOT NULL;
INSERT INTO public.wom_customer_signals (
  rutid,
  nombre,
  telefono,
  email,
  email_normalized,
  direccion,
  comuna,
  ciclo_raw,
  ciclo_date,
  lineas,
  valor,
  source_name,
  metadata,
  loaded_at,
  updated_at
)
SELECT
  s.rutid,
  s.nombre,
  s.telefono,
  s.email,
  s.email_normalized,
  s.direccion,
  s.comuna,
  s.ciclo_raw,
  s.ciclo_date,
  s.lineas,
  s.valor,
  '${SOURCE_NAME}',
  jsonb_strip_nulls(
    jsonb_build_object(
      'source_name', '${SOURCE_NAME}',
      'nombre', s.nombre,
      'direccion', s.direccion,
      'comuna', s.comuna,
      'ciclo_raw', s.ciclo_raw,
      'lineas', s.lineas,
      'valor', s.valor
    )
  ),
  NOW(),
  NOW()
FROM wom_stage s
ON CONFLICT (rutid) DO UPDATE
SET
  nombre = EXCLUDED.nombre,
  telefono = EXCLUDED.telefono,
  email = EXCLUDED.email,
  email_normalized = EXCLUDED.email_normalized,
  direccion = EXCLUDED.direccion,
  comuna = EXCLUDED.comuna,
  ciclo_raw = EXCLUDED.ciclo_raw,
  ciclo_date = EXCLUDED.ciclo_date,
  lineas = EXCLUDED.lineas,
  valor = EXCLUDED.valor,
  source_name = EXCLUDED.source_name,
  metadata = public.wom_customer_signals.metadata || EXCLUDED.metadata,
  updated_at = NOW();
SELECT
  (SELECT COUNT(*) FROM wom_stage) AS chunk_rows,
  (SELECT COUNT(*) FROM wom_stage WHERE email_normalized IS NOT NULL) AS chunk_emails,
  (SELECT COUNT(*) FROM wom_stage WHERE telefono IS NOT NULL) AS chunk_phones,
  (SELECT COUNT(*) FROM wom_stage WHERE comuna IS NOT NULL) AS chunk_comunas;
COMMIT;
SQL

    rm -f "$CHUNK_FILE"
    echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) :: load done $(basename "$CHUNK_FILE") ====="
  done

  echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) :: analyze wom_customer_signals ====="
  psql "$POSTGRES_URL_NON_POOLING" -c "ANALYZE public.wom_customer_signals;"
else
  echo "Fase 1/2 omitida: usando public.wom_customer_signals ya cargada"
fi

echo "Fase 2/2: aplicando WOM sobre personas_master y persona_contact_points por prefijo de RUT"
PREFIXES=()
while IFS= read -r PREFIX; do
  [[ -n "$PREFIX" ]] && PREFIXES+=("$PREFIX")
done < <(
  psql "$POSTGRES_URL_NON_POOLING" -Atc "
    SELECT DISTINCT LEFT(rutid, 2)
    FROM public.wom_customer_signals
    WHERE NULLIF(BTRIM(rutid), '') IS NOT NULL
    ORDER BY 1;
  "
)

for PREFIX in "${PREFIXES[@]}"; do
  [[ -n "$PREFIX" ]] || continue
  echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) :: enrich start prefix=$PREFIX ====="

  psql "$POSTGRES_URL_NON_POOLING" <<SQL
\set ON_ERROR_STOP on
\timing on
BEGIN;
CREATE TEMP TABLE wom_scope AS
SELECT
  w.rutid,
  w.telefono,
  w.email,
  w.email_normalized,
  w.comuna,
  w.nombre,
  w.direccion,
  w.ciclo_raw,
  w.ciclo_date,
  w.lineas,
  w.valor,
  pm.email AS current_email,
  pm.fono_cel AS current_fono,
  pm.comuna_part AS current_comuna
FROM public.wom_customer_signals w
JOIN public.personas_master pm
  ON pm.rutid = w.rutid
WHERE LEFT(w.rutid, 2) = '${PREFIX}';
CREATE TEMP TABLE wom_scope_master AS
SELECT ws.*
FROM wom_scope ws
JOIN public.master_personas mp
  ON mp.rutid = ws.rutid;
WITH updated AS (
  UPDATE public.personas_master pm
  SET
    email = ws.email_normalized,
    loaded_at = NOW()
  FROM wom_scope ws
  WHERE pm.rutid = ws.rutid
    AND ws.email_normalized IS NOT NULL
    AND NULLIF(BTRIM(pm.email), '') IS NULL
  RETURNING pm.rutid
)
SELECT COUNT(*) AS email_backfills FROM updated;
WITH updated AS (
  UPDATE public.personas_master pm
  SET
    fono_cel = ws.telefono,
    loaded_at = NOW()
  FROM wom_scope ws
  WHERE pm.rutid = ws.rutid
    AND ws.telefono IS NOT NULL
    AND NULLIF(BTRIM(pm.fono_cel), '') IS NULL
  RETURNING pm.rutid
)
SELECT COUNT(*) AS phone_backfills FROM updated;
WITH updated AS (
  UPDATE public.personas_master pm
  SET
    comuna_part = ws.comuna,
    loaded_at = NOW()
  FROM wom_scope ws
  WHERE pm.rutid = ws.rutid
    AND ws.comuna IS NOT NULL
    AND NULLIF(BTRIM(pm.comuna_part), '') IS NULL
  RETURNING pm.rutid
)
SELECT COUNT(*) AS comuna_backfills FROM updated;
WITH upserted AS (
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
  SELECT
    ws.rutid,
    'phone',
    ws.telefono,
    ws.telefono,
    '${SOURCE_NAME}',
    64,
    74,
    FALSE,
    FALSE,
    NULL,
    COALESCE(ws.ciclo_date::timestamptz, NOW()),
    COALESCE(ws.ciclo_date::timestamptz, NOW()),
    jsonb_strip_nulls(
      jsonb_build_object(
        'source_name', '${SOURCE_NAME}',
        'nombre', ws.nombre,
        'direccion', ws.direccion,
        'comuna', ws.comuna,
        'ciclo_raw', ws.ciclo_raw,
        'lineas', ws.lineas,
        'valor', ws.valor
      )
    )
  FROM wom_scope_master ws
  WHERE ws.telefono IS NOT NULL
  ON CONFLICT (rutid, contact_type, normalized_value) DO UPDATE
  SET
    source_priority = GREATEST(persona_contact_points.source_priority, EXCLUDED.source_priority),
    quality_score = GREATEST(persona_contact_points.quality_score, EXCLUDED.quality_score),
    last_seen_at = GREATEST(persona_contact_points.last_seen_at, EXCLUDED.last_seen_at),
    metadata = persona_contact_points.metadata || EXCLUDED.metadata,
    updated_at = NOW()
  RETURNING rutid
)
SELECT COUNT(*) AS phone_contact_upserts FROM upserted;
WITH upserted AS (
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
  SELECT
    ws.rutid,
    'email',
    ws.email_normalized,
    ws.email_normalized,
    '${SOURCE_NAME}',
    62,
    72,
    FALSE,
    FALSE,
    NULL,
    COALESCE(ws.ciclo_date::timestamptz, NOW()),
    COALESCE(ws.ciclo_date::timestamptz, NOW()),
    jsonb_strip_nulls(
      jsonb_build_object(
        'source_name', '${SOURCE_NAME}',
        'nombre', ws.nombre,
        'direccion', ws.direccion,
        'comuna', ws.comuna,
        'ciclo_raw', ws.ciclo_raw,
        'lineas', ws.lineas,
        'valor', ws.valor
      )
    )
  FROM wom_scope_master ws
  WHERE ws.email_normalized IS NOT NULL
  ON CONFLICT (rutid, contact_type, normalized_value) DO UPDATE
  SET
    source_priority = GREATEST(persona_contact_points.source_priority, EXCLUDED.source_priority),
    quality_score = GREATEST(persona_contact_points.quality_score, EXCLUDED.quality_score),
    is_deliverable = COALESCE(persona_contact_points.is_deliverable, EXCLUDED.is_deliverable),
    last_seen_at = GREATEST(persona_contact_points.last_seen_at, EXCLUDED.last_seen_at),
    metadata = persona_contact_points.metadata || EXCLUDED.metadata,
    updated_at = NOW()
  RETURNING rutid
)
SELECT COUNT(*) AS email_contact_upserts FROM upserted;
SELECT
  (SELECT COUNT(*) FROM wom_scope) AS matched_ruts,
  (SELECT COUNT(*) FROM wom_scope WHERE email_normalized IS NOT NULL AND NULLIF(BTRIM(current_email), '') IS NULL) AS pending_email_backfills_before,
  (SELECT COUNT(*) FROM wom_scope WHERE telefono IS NOT NULL AND NULLIF(BTRIM(current_fono), '') IS NULL) AS pending_phone_backfills_before,
  (SELECT COUNT(*) FROM wom_scope WHERE comuna IS NOT NULL AND NULLIF(BTRIM(current_comuna), '') IS NULL) AS pending_comuna_backfills_before;
COMMIT;
SQL

  echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) :: enrich done prefix=$PREFIX ====="
done

echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) :: resumen final ====="
psql "$POSTGRES_URL_NON_POOLING" -Atc "
  SELECT 'wom_customer_signals=' || COUNT(*) FROM public.wom_customer_signals;
  SELECT 'wom_matches_personas_master=' || COUNT(*) FROM public.wom_customer_signals w JOIN public.personas_master pm ON pm.rutid = w.rutid;
  SELECT 'personas_master_con_email=' || COUNT(*) FROM public.personas_master WHERE NULLIF(BTRIM(email), '') IS NOT NULL;
  SELECT 'personas_master_con_fono=' || COUNT(*) FROM public.personas_master WHERE NULLIF(BTRIM(fono_cel), '') IS NOT NULL;
  SELECT 'personas_master_con_comuna=' || COUNT(*) FROM public.personas_master WHERE NULLIF(BTRIM(comuna_part), '') IS NOT NULL;
"
