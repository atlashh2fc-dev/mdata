#!/usr/bin/env node

import { Client } from 'pg'

const STAGE_TABLE = 'public._padron2024_fix_stage'

function parseArgs(argv) {
  const args = {
    chunkRows: Number(process.env.PADRON2024_FIX_CHUNK_ROWS ?? 50000),
    keepStage: argv.includes('--keep-stage'),
    rebuildStage: argv.includes('--rebuild-stage'),
    skipPrechecks: argv.includes('--skip-prechecks'),
  }

  for (const rawArg of argv) {
    if (rawArg.startsWith('--chunk-rows=')) {
      args.chunkRows = Number(rawArg.split('=')[1])
    }
  }

  if (!Number.isFinite(args.chunkRows) || args.chunkRows < 1000) {
    throw new Error(`chunk-rows invalido: ${args.chunkRows}`)
  }

  return args
}

function sanitizeConnectionString(rawValue) {
  const url = new URL(rawValue)
  for (const key of [
    'ssl',
    'sslmode',
    'sslcert',
    'sslkey',
    'sslrootcert',
    'sslaccept',
    'sslacceptmode',
    'uselibpqcompat',
    'pgbouncer',
    'supa',
  ]) {
    url.searchParams.delete(key)
  }
  return url.toString()
}

function resolvePgConfig() {
  const connectionString =
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.POSTGRES_URL ??
    process.env.POSTGRES_PRISMA_URL ??
    process.env.DATABASE_URL ??
    process.env.SUPABASE_DB_URL ??
    null

  if (!connectionString) {
    throw new Error('Faltan credenciales Postgres.')
  }

  return {
    connectionString: sanitizeConnectionString(connectionString),
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  }
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

async function ensureStage(pgClient, { rebuildStage }) {
  if (rebuildStage) {
    log(`[stage] eliminando staging previo ${STAGE_TABLE}...`)
    await pgClient.query(`DROP TABLE IF EXISTS ${STAGE_TABLE}`)
  }

  await pgClient.query(`
    CREATE UNLOGGED TABLE IF NOT EXISTS ${STAGE_TABLE} (
      bad_rutid varchar(20) PRIMARY KEY,
      canonical_rutid varchar(20) NOT NULL,
      nombres varchar,
      paterno varchar,
      materno varchar,
      email varchar,
      fono_cel varchar,
      comuna_part varchar,
      region_part varchar,
      n_autos integer,
      razon_social_empresa varchar,
      domicilio_comuna varchar,
      domicilio_region varchar,
      n_bienes_raices integer,
      totalavaluos numeric,
      loaded_at timestamptz NOT NULL,
      upserted_at timestamptz,
      deleted_at timestamptz,
      delete_skipped boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  await pgClient.query(`
    CREATE INDEX IF NOT EXISTS _padron2024_fix_stage_pending_upsert_idx
      ON ${STAGE_TABLE} (bad_rutid)
      WHERE upserted_at IS NULL
  `)
  await pgClient.query(`
    CREATE INDEX IF NOT EXISTS _padron2024_fix_stage_pending_delete_idx
      ON ${STAGE_TABLE} (bad_rutid)
      WHERE upserted_at IS NOT NULL AND deleted_at IS NULL
  `)
  await pgClient.query(`
    CREATE INDEX IF NOT EXISTS _padron2024_fix_stage_canonical_idx
      ON ${STAGE_TABLE} (canonical_rutid)
  `)

  const stageHasRows = await pgClient.query(`SELECT EXISTS (SELECT 1 FROM ${STAGE_TABLE} LIMIT 1) AS has_rows`)
  if (stageHasRows.rows[0]?.has_rows) {
    const estimate = await pgClient.query(`
      SELECT reltuples::bigint AS estimated_rows,
             pg_size_pretty(pg_total_relation_size('${STAGE_TABLE}'::regclass)) AS size
      FROM pg_class
      WHERE oid = '${STAGE_TABLE}'::regclass
    `)
    log(`[stage] reutilizando staging existente estimated_rows=${estimate.rows[0]?.estimated_rows ?? 'unknown'} size=${estimate.rows[0]?.size ?? 'unknown'}.`)
    return
  }

  log('[stage] construyendo staging desde padron_personas_raw...')
  await pgClient.query(`
    INSERT INTO ${STAGE_TABLE} (
      bad_rutid,
      canonical_rutid,
      nombres,
      paterno,
      materno,
      email,
      fono_cel,
      comuna_part,
      region_part,
      n_autos,
      razon_social_empresa,
      domicilio_comuna,
      domicilio_region,
      n_bienes_raices,
      totalavaluos,
      loaded_at
    )
    SELECT
      pr.rutid AS bad_rutid,
      lpad(
        COALESCE(NULLIF(regexp_replace(pr.rutid, '^0+', ''), ''), '0') || upper(pr.dv),
        10,
        '0'
      ) AS canonical_rutid,
      NULLIF(TRIM(split_part(pr.nombre, ' ', 1)), '') AS nombres,
      NULL AS paterno,
      NULL AS materno,
      NULL AS email,
      NULL AS fono_cel,
      NULLIF(TRIM(pr.comuna), '') AS comuna_part,
      NULLIF(TRIM(pr.region), '') AS region_part,
      0 AS n_autos,
      NULL AS razon_social_empresa,
      NULLIF(TRIM(pr.comuna), '') AS domicilio_comuna,
      NULLIF(TRIM(pr.region), '') AS domicilio_region,
      0 AS n_bienes_raices,
      0 AS totalavaluos,
      now() AS loaded_at
    FROM public.padron_personas_raw pr
    WHERE pr.dv IS NOT NULL
      AND lpad(
        COALESCE(NULLIF(regexp_replace(pr.rutid, '^0+', ''), ''), '0') || upper(pr.dv),
        10,
        '0'
      ) IS DISTINCT FROM pr.rutid
    ON CONFLICT (bad_rutid) DO NOTHING
  `)
}

async function logPlan(pgClient) {
  const estimate = await pgClient.query(`
    SELECT reltuples::bigint AS estimated_rows,
           pg_size_pretty(pg_total_relation_size('${STAGE_TABLE}'::regclass)) AS size
    FROM pg_class
    WHERE oid = '${STAGE_TABLE}'::regclass
  `)
  log(`[plan] stage_estimated_rows=${estimate.rows[0]?.estimated_rows ?? 'unknown'} stage_size=${estimate.rows[0]?.size ?? 'unknown'}`)
}

async function runPrechecks(pgClient) {
  const blockers = [
    ['persona_contact_points', `
      SELECT COUNT(*)::bigint AS total
      FROM public.persona_contact_points p
      JOIN public.padron_personas_raw pr
        ON pr.rutid = p.rutid
    `],
    ['persona_scores', `
      SELECT COUNT(*)::bigint AS total
      FROM public.persona_scores s
      JOIN public.padron_personas_raw pr
        ON pr.rutid = s.rutid
    `],
    ['contact_center_feedback.rutid', `
      SELECT COUNT(*)::bigint AS total
      FROM public.contact_center_feedback f
      JOIN public.padron_personas_raw pr
        ON pr.rutid = f.rutid
    `],
    ['contact_center_feedback.matched_rutid', `
      SELECT COUNT(*)::bigint AS total
      FROM public.contact_center_feedback f
      JOIN public.padron_personas_raw pr
        ON pr.rutid = f.matched_rutid
    `],
  ]

  for (const [label, sql] of blockers) {
    const result = await pgClient.query(sql)
    const total = Number(result.rows[0]?.total ?? 0)
    log(`[precheck] ${label} afectados=${total}`)
    if (total > 0) {
      throw new Error(`Hay filas dependientes en ${label}; se requiere migracion asistida antes de borrar bad_rutid.`)
    }
  }
}

function fillExpression(column) {
  return `
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM ${STAGE_TABLE} target_bad
        WHERE target_bad.bad_rutid = public.personas_master.rutid
      )
        THEN COALESCE(EXCLUDED.${column}, public.personas_master.${column})
      ELSE COALESCE(NULLIF(public.personas_master.${column}, ''), EXCLUDED.${column}, public.personas_master.${column})
    END
  `
}

async function upsertCanonicalChunks(pgClient, chunkRows) {
  let processed = 0

  while (true) {
    const result = await pgClient.query(`
      WITH batch AS (
        SELECT *
        FROM ${STAGE_TABLE}
        WHERE upserted_at IS NULL
        ORDER BY bad_rutid
        LIMIT $1
      ),
      upserted AS (
        INSERT INTO public.personas_master (
          rutid,
          nombres,
          paterno,
          materno,
          email,
          fono_cel,
          comuna_part,
          region_part,
          n_autos,
          razon_social_empresa,
          domicilio_comuna,
          domicilio_region,
          n_bienes_raices,
          totalavaluos,
          loaded_at
        )
        SELECT
          canonical_rutid,
          nombres,
          paterno,
          materno,
          email,
          fono_cel,
          comuna_part,
          region_part,
          n_autos,
          razon_social_empresa,
          domicilio_comuna,
          domicilio_region,
          n_bienes_raices,
          totalavaluos,
          loaded_at
        FROM batch
        ON CONFLICT (rutid) DO UPDATE
        SET
          nombres = ${fillExpression('nombres')},
          paterno = ${fillExpression('paterno')},
          materno = ${fillExpression('materno')},
          email = ${fillExpression('email')},
          fono_cel = ${fillExpression('fono_cel')},
          comuna_part = ${fillExpression('comuna_part')},
          region_part = ${fillExpression('region_part')},
          n_autos = GREATEST(COALESCE(public.personas_master.n_autos, 0), COALESCE(EXCLUDED.n_autos, 0)),
          razon_social_empresa = ${fillExpression('razon_social_empresa')},
          domicilio_comuna = ${fillExpression('domicilio_comuna')},
          domicilio_region = ${fillExpression('domicilio_region')},
          n_bienes_raices = GREATEST(COALESCE(public.personas_master.n_bienes_raices, 0), COALESCE(EXCLUDED.n_bienes_raices, 0)),
          totalavaluos = GREATEST(COALESCE(public.personas_master.totalavaluos, 0), COALESCE(EXCLUDED.totalavaluos, 0)),
          loaded_at = GREATEST(public.personas_master.loaded_at, EXCLUDED.loaded_at)
        RETURNING 1
      ),
      marked AS (
        UPDATE ${STAGE_TABLE} stage
        SET upserted_at = now()
        FROM batch
        WHERE stage.bad_rutid = batch.bad_rutid
        RETURNING stage.bad_rutid
      )
      SELECT
        (SELECT COUNT(*)::integer FROM batch) AS source,
        (SELECT COUNT(*)::integer FROM upserted) AS affected,
        (SELECT MAX(bad_rutid) FROM marked) AS last_bad_rutid
    `, [chunkRows])

    const source = Number(result.rows[0]?.source ?? 0)
    if (source === 0) {
      log('[upsert] fase lista.')
      return
    }

    processed += source
    log(`[upsert] chunk source=${source} affected=${result.rows[0]?.affected ?? 0} processed=${processed} last_bad_rutid=${result.rows[0]?.last_bad_rutid ?? ''}`)
  }
}

async function deleteBadKeyChunks(pgClient, chunkRows) {
  let processed = 0

  while (true) {
    const result = await pgClient.query(`
      WITH batch AS (
        SELECT source.bad_rutid
        FROM ${STAGE_TABLE} source
        WHERE source.upserted_at IS NOT NULL
          AND source.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM ${STAGE_TABLE} target
            WHERE target.canonical_rutid = source.bad_rutid
          )
        ORDER BY source.bad_rutid
        LIMIT $1
      ),
      deleted AS (
        DELETE FROM public.personas_master pm
        USING batch
        WHERE pm.rutid = batch.bad_rutid
        RETURNING pm.rutid
      ),
      marked AS (
        UPDATE ${STAGE_TABLE} stage
        SET
          deleted_at = now(),
          delete_skipped = false
        FROM batch
        WHERE stage.bad_rutid = batch.bad_rutid
        RETURNING stage.bad_rutid
      )
      SELECT
        (SELECT COUNT(*)::integer FROM batch) AS source,
        (SELECT COUNT(*)::integer FROM deleted) AS affected,
        (SELECT MAX(bad_rutid) FROM marked) AS last_bad_rutid
    `, [chunkRows])

    const source = Number(result.rows[0]?.source ?? 0)
    if (source === 0) {
      await pgClient.query(`
        UPDATE ${STAGE_TABLE} source
        SET
          deleted_at = now(),
          delete_skipped = true
        WHERE source.upserted_at IS NOT NULL
          AND source.deleted_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM ${STAGE_TABLE} target
            WHERE target.canonical_rutid = source.bad_rutid
          )
      `)
      log('[delete] fase lista.')
      return
    }

    processed += source
    log(`[delete] chunk source=${source} affected=${result.rows[0]?.affected ?? 0} processed=${processed} last_bad_rutid=${result.rows[0]?.last_bad_rutid ?? ''}`)
  }
}

async function refreshDerivedData(pgClient) {
  for (const sql of [
    'SELECT refresh_dashboard_stats()',
    'SELECT refresh_company_name_lookup()',
  ]) {
    try {
      await pgClient.query(sql)
    } catch (error) {
      log(`[warn] no se pudo ejecutar ${sql}: ${error.message}`)
    }
  }

  await pgClient.query(`
    UPDATE public.data_sources
    SET
      record_count = (SELECT COUNT(*) FROM public.personas_master),
      last_loaded_at = NOW(),
      last_job_status = 'completed',
      updated_at = NOW()
    WHERE slug = 'master_personas'
  `)
}

async function logFinalChecks(pgClient) {
  const checks = [
    ['personas_master_final', 'SELECT COUNT(*)::bigint AS total FROM public.personas_master'],
    ['personas_master_distinct', 'SELECT COUNT(DISTINCT rutid)::bigint AS total FROM public.personas_master'],
    ['stage_total', `SELECT COUNT(*)::bigint AS total FROM ${STAGE_TABLE}`],
    ['stage_pending_upsert', `SELECT COUNT(*)::bigint AS total FROM ${STAGE_TABLE} WHERE upserted_at IS NULL`],
    ['stage_pending_delete', `SELECT COUNT(*)::bigint AS total FROM ${STAGE_TABLE} WHERE deleted_at IS NULL`],
    ['stage_delete_skipped', `SELECT COUNT(*)::bigint AS total FROM ${STAGE_TABLE} WHERE delete_skipped IS TRUE`],
    [
      'bad_padron_keys_remaining',
      `
        SELECT COUNT(*)::bigint AS total
        FROM public.personas_master pm
        JOIN ${STAGE_TABLE} stage
          ON stage.bad_rutid = pm.rutid
        WHERE stage.delete_skipped IS FALSE
      `,
    ],
  ]

  for (const [label, sql] of checks) {
    const result = await pgClient.query(sql)
    log(`[final] ${label}=${result.rows[0]?.total ?? 0}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const pgClient = new Client(resolvePgConfig())

  await pgClient.connect()
  await pgClient.query('SET statement_timeout = 0')
  await pgClient.query('SET lock_timeout = 0')

  try {
    await ensureStage(pgClient, args)
    await logPlan(pgClient)
    if (args.skipPrechecks) {
      log('[precheck] omitidos por --skip-prechecks.')
    } else {
      await runPrechecks(pgClient)
    }
    await upsertCanonicalChunks(pgClient, args.chunkRows)
    await deleteBadKeyChunks(pgClient, args.chunkRows)
    await refreshDerivedData(pgClient)
    await logFinalChecks(pgClient)

    if (!args.keepStage) {
      log(`[stage] eliminando staging ${STAGE_TABLE}...`)
      await pgClient.query(`DROP TABLE IF EXISTS ${STAGE_TABLE}`)
    }
  } finally {
    await pgClient.end()
  }
}

main().catch(error => {
  console.error(`\nFallo en fix-padron2024-canonical: ${error.message}`)
  process.exitCode = 1
})
