#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.local}"
CSV_FILE="${1:-${GEOBPO_SLIM_CSV:-/var/folders/k6/5gx7ncw96cs2twc_yxzx2x7r0000gn/T/geobpo_access_phones.slim.csv}}"
CHUNK_ROWS="${CHUNK_ROWS:-20000}"
CHUNK_DIR="${CHUNK_DIR:-${TMPDIR:-/tmp}/geobpo-slim-chunks}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "No existe ENV_FILE: $ENV_FILE" >&2
  exit 1
fi

if [[ ! -f "$CSV_FILE" ]]; then
  echo "No existe CSV_FILE: $CSV_FILE" >&2
  exit 1
fi

if ! [[ "$CHUNK_ROWS" =~ ^[0-9]+$ ]] || [[ "$CHUNK_ROWS" -lt 1000 ]]; then
  echo "CHUNK_ROWS invalido: $CHUNK_ROWS" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

export PGOPTIONS='-c statement_timeout=0'

mkdir -p "$CHUNK_DIR"
rm -f "$CHUNK_DIR"/chunk_*.csv

HEADER_LINE="$(head -n 1 "$CSV_FILE")"
tail -n +2 "$CSV_FILE" | split -l "$CHUNK_ROWS" - "$CHUNK_DIR/chunk_"

for RAW_CHUNK in "$CHUNK_DIR"/chunk_*; do
  [[ -f "$RAW_CHUNK" ]] || continue
  HEADER_CHUNK="${RAW_CHUNK}.csv"
  {
    printf '%s\n' "$HEADER_LINE"
    cat "$RAW_CHUNK"
  } > "$HEADER_CHUNK"
  rm -f "$RAW_CHUNK"
done

CHUNK_COUNT=0
for CHUNK_FILE in "$CHUNK_DIR"/chunk_*.csv; do
  [[ -f "$CHUNK_FILE" ]] || continue
  CHUNK_COUNT=$((CHUNK_COUNT + 1))
done

echo "Procesando $CHUNK_COUNT chunks desde $CSV_FILE con bloques de $CHUNK_ROWS filas"

for CHUNK_FILE in "$CHUNK_DIR"/chunk_*.csv; do
  [[ -f "$CHUNK_FILE" ]] || continue
  echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) :: start $(basename "$CHUNK_FILE") ====="

  psql "$POSTGRES_URL_NON_POOLING" <<SQL
\set ON_ERROR_STOP on
\timing on
BEGIN;
CREATE TEMP TABLE geobpo_phone_stage (
  rutid TEXT,
  nombre_ide TEXT,
  telefono_raw TEXT,
  telefono_e164 TEXT,
  is_verified BOOLEAN,
  quality_score INTEGER,
  last_seen_at TIMESTAMPTZ,
  fecha_max TEXT,
  fono_numero_cel TEXT,
  verificado_fono_cel TEXT,
  fecha_fono_cel TEXT,
  fono_numero_part TEXT,
  verificado_fono_part TEXT,
  fecha_fono_part TEXT,
  calle_comer TEXT,
  numero_comer TEXT,
  comuna_comer TEXT,
  ciudad_comer TEXT,
  region_comer TEXT,
  dicom TEXT,
  ano_ultimo_timbraje TEXT
);
\copy geobpo_phone_stage FROM '$CHUNK_FILE' WITH (FORMAT csv, HEADER true)
DELETE FROM geobpo_phone_stage
WHERE NULLIF(BTRIM(rutid), '') IS NULL
   OR NULLIF(BTRIM(telefono_e164), '') IS NULL;
CREATE TEMP TABLE geobpo_backfill_candidates AS
SELECT
  g.rutid,
  g.telefono_e164,
  g.is_verified,
  g.quality_score,
  g.last_seen_at,
  g.nombre_ide,
  g.fecha_max,
  g.fono_numero_cel,
  g.verificado_fono_cel,
  g.fecha_fono_cel,
  g.fono_numero_part,
  g.verificado_fono_part,
  g.fecha_fono_part,
  g.calle_comer,
  g.numero_comer,
  g.comuna_comer,
  g.ciudad_comer,
  g.region_comer,
  g.dicom,
  g.ano_ultimo_timbraje
FROM geobpo_phone_stage g
JOIN public.personas_master pm
  ON pm.rutid = g.rutid
WHERE NULLIF(BTRIM(pm.fono_cel), '') IS NULL;
UPDATE public.personas_master pm
SET
  fono_cel = g.telefono_e164,
  loaded_at = NOW()
FROM geobpo_backfill_candidates g
WHERE pm.rutid = g.rutid
  AND NULLIF(BTRIM(pm.fono_cel), '') IS NULL;
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
  first_seen_at,
  last_seen_at,
  metadata
)
SELECT
  g.rutid,
  'phone',
  g.telefono_e164,
  g.telefono_e164,
  'geobpo_access_phones',
  72,
  g.quality_score,
  TRUE,
  COALESCE(g.is_verified, FALSE),
  COALESCE(g.last_seen_at, NOW()),
  COALESCE(g.last_seen_at, NOW()),
  jsonb_strip_nulls(
    jsonb_build_object(
      'source_name', 'geobpo_access_phones',
      'source_table', '2018_pymes_fono_actualizados',
      'nombre_ide', NULLIF(g.nombre_ide, ''),
      'fecha_max', NULLIF(g.fecha_max, ''),
      'fono_numero_cel', NULLIF(g.fono_numero_cel, ''),
      'verificado_fono_cel', NULLIF(g.verificado_fono_cel, ''),
      'fecha_fono_cel', NULLIF(g.fecha_fono_cel, ''),
      'fono_numero_part', NULLIF(g.fono_numero_part, ''),
      'verificado_fono_part', NULLIF(g.verificado_fono_part, ''),
      'fecha_fono_part', NULLIF(g.fecha_fono_part, ''),
      'calle_comer', NULLIF(g.calle_comer, ''),
      'numero_comer', NULLIF(g.numero_comer, ''),
      'comuna_comer', NULLIF(g.comuna_comer, ''),
      'ciudad_comer', NULLIF(g.ciudad_comer, ''),
      'region_comer', NULLIF(g.region_comer, ''),
      'dicom', NULLIF(g.dicom, ''),
      'ano_ultimo_timbraje', NULLIF(g.ano_ultimo_timbraje, '')
    )
  )
FROM geobpo_backfill_candidates g
JOIN public.master_personas mp
  ON mp.rutid = g.rutid
ON CONFLICT (rutid, contact_type, normalized_value) DO UPDATE
SET
  source_priority = GREATEST(persona_contact_points.source_priority, EXCLUDED.source_priority),
  quality_score = GREATEST(persona_contact_points.quality_score, EXCLUDED.quality_score),
  is_primary = persona_contact_points.is_primary OR EXCLUDED.is_primary,
  is_verified = persona_contact_points.is_verified OR EXCLUDED.is_verified,
  first_seen_at = LEAST(persona_contact_points.first_seen_at, EXCLUDED.first_seen_at),
  last_seen_at = GREATEST(persona_contact_points.last_seen_at, EXCLUDED.last_seen_at),
  metadata = persona_contact_points.metadata || EXCLUDED.metadata,
  updated_at = NOW();
SELECT
  COUNT(*) AS source_rows,
  (SELECT COUNT(*) FROM geobpo_backfill_candidates) AS candidate_backfills
FROM geobpo_phone_stage;
COMMIT;
SQL

  rm -f "$CHUNK_FILE"
  echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) :: done $(basename "$CHUNK_FILE") ====="
done

echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) :: resumen final ====="
psql "$POSTGRES_URL_NON_POOLING" -Atc "
  SELECT COUNT(*) FROM public.persona_contact_points WHERE source_name = 'geobpo_access_phones';
  SELECT COUNT(DISTINCT rutid) FROM public.persona_contact_points WHERE source_name = 'geobpo_access_phones';
  SELECT COUNT(*) FROM public.personas_master WHERE NULLIF(BTRIM(fono_cel), '') IS NOT NULL;
"
