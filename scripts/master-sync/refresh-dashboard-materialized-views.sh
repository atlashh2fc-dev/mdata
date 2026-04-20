#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.local}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "No existe ENV_FILE: $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

export PGOPTIONS='-c statement_timeout=0'

psql "$POSTGRES_URL_NON_POOLING" <<'SQL'
\set ON_ERROR_STOP on
\timing on
REFRESH MATERIALIZED VIEW public.dashboard_stats;
REFRESH MATERIALIZED VIEW public.stats_por_region;
REFRESH MATERIALIZED VIEW public.stats_score_dist;
REFRESH MATERIALIZED VIEW public.stats_universos;
SELECT NOW() AS refreshed_at;
SQL
