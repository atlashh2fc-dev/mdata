#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import { Client } from 'pg'
import { from as copyFrom } from 'pg-copy-streams'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEFAULT_INPUT = path.resolve(__dirname, '../../tmp/master-sync/padron2024/padron_personas_raw.csv')
const KEY_TABLE = 'public._padron2024_fix_keys'
const TEMP_CHUNK_TABLE = 'tmp_padron2024_fix_chunk'

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    chunkRows: Number(process.env.PADRON2024_FIX_CHUNK_ROWS ?? 25000),
    rebuildKeys: argv.includes('--rebuild-keys'),
    phase: 'all',
  }

  for (const rawArg of argv) {
    if (rawArg.startsWith('--input=')) args.input = path.resolve(rawArg.split('=')[1])
    if (rawArg.startsWith('--chunk-rows=')) args.chunkRows = Number(rawArg.split('=')[1])
    if (rawArg.startsWith('--phase=')) args.phase = rawArg.split('=')[1]
  }

  if (!Number.isFinite(args.chunkRows) || args.chunkRows < 1000) {
    throw new Error(`chunk-rows invalido: ${args.chunkRows}`)
  }

  if (!['all', 'keys', 'upsert', 'delete', 'refresh'].includes(args.phase)) {
    throw new Error(`phase invalida: ${args.phase}`)
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

  if (!connectionString) throw new Error('Faltan credenciales Postgres.')

  return {
    connectionString: sanitizeConnectionString(connectionString),
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  }
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

function csvField(value) {
  const str = String(value ?? '')
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

function parseCsvLine(line) {
  const values = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current)
      current = ''
    } else {
      current += char
    }
  }

  values.push(current)
  return values
}

async function* readPadronCsv(input) {
  const inputStream = fs.createReadStream(input, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: inputStream, crlfDelay: Infinity })

  let headers = null
  try {
    for await (const line of rl) {
      if (!headers) {
        headers = parseCsvLine(line)
        continue
      }
      if (!line.trim()) continue

      const values = parseCsvLine(line)
      yield Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
    }
  } finally {
    rl.close()
    inputStream.destroy()
  }
}

function rowsToCsv(columns, rows) {
  return `${columns.join(',')}\n${rows
    .map(row => columns.map(column => csvField(row[column])).join(','))
    .join('\n')}\n`
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function splitName(fullName) {
  const normalized = clean(fullName).replace(/^[\s.\-_,;:/'"`]+/g, '').trim()
  if (!normalized) return { nombres: '', paterno: '', materno: '' }
  const tokens = normalized.split(' ').filter(Boolean)
  if (tokens.length === 1) return { nombres: tokens[0], paterno: '', materno: '' }
  if (tokens.length === 2) return { nombres: tokens[0], paterno: tokens[1], materno: '' }
  return {
    nombres: tokens.slice(0, -2).join(' '),
    paterno: tokens[tokens.length - 2],
    materno: tokens[tokens.length - 1],
  }
}

function canonicalRutid(badRutid, dv) {
  const digits = String(badRutid ?? '').replace(/\D/g, '').replace(/^0+/, '') || '0'
  const cleanDv = clean(dv).replace(/[^0-9kK]/g, '').toUpperCase()
  if (!cleanDv) return ''
  return `${digits}${cleanDv}`.padStart(10, '0')
}

function mapPadronRow(row) {
  const badRutid = clean(row.rutid)
  const canonical = canonicalRutid(badRutid, row.dv)
  const names = splitName(row.nombre)
  const comuna = clean(row.comuna).toUpperCase()
  const region = clean(row.region).toUpperCase()

  if (!badRutid || !canonical || badRutid === canonical) return null

  return {
    bad_rutid: badRutid,
    canonical_rutid: canonical,
    nombres: names.nombres,
    paterno: names.paterno,
    materno: names.materno,
    comuna_part: comuna,
    region_part: region,
    domicilio_comuna: comuna,
    domicilio_region: region,
  }
}

async function copyRows(pgClient, tableName, columns, rows) {
  if (rows.length === 0) return
  const csv = rowsToCsv(columns, rows)
  const copySql = `COPY ${tableName} (${columns.join(',')}) FROM STDIN WITH (FORMAT csv, HEADER true, NULL '')`
  const copyStream = pgClient.query(copyFrom(copySql))
  await pipeline(Readable.from([csv]), copyStream)
}

async function ensureKeyTable(pgClient, { rebuildKeys }) {
  if (rebuildKeys) {
    await pgClient.query(`DROP TABLE IF EXISTS ${KEY_TABLE}`)
    await pgClient.query('DROP TABLE IF EXISTS public._padron2024_fix_stage')
  }

  await pgClient.query(`
    CREATE UNLOGGED TABLE IF NOT EXISTS ${KEY_TABLE} (
      bad_rutid varchar(20) NOT NULL,
      canonical_rutid varchar(20) NOT NULL,
      upserted_at timestamptz,
      deleted_at timestamptz,
      delete_skipped boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
}

async function ensureKeyIndexes(pgClient) {
  const existingUniqueIndex = await pgClient.query(`
    SELECT ix.indisvalid AS valid, ix.indisready AS ready
    FROM pg_class index_class
    JOIN pg_index ix ON ix.indexrelid = index_class.oid
    JOIN pg_class table_class ON table_class.oid = ix.indrelid
    JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
    WHERE namespace.nspname = 'public'
      AND table_class.relname = '_padron2024_fix_keys'
      AND index_class.relname = '_padron2024_fix_keys_bad_idx'
      AND ix.indisunique
    LIMIT 1
  `)

  if (existingUniqueIndex.rows[0]?.valid && existingUniqueIndex.rows[0]?.ready) {
    log('[keys] indices ya existen; se reutilizan.')
    return
  }

  log('[keys] validando duplicados de llaves...')
  const conflicts = await pgClient.query(`
    SELECT COUNT(*)::integer AS conflicts
    FROM (
      SELECT bad_rutid
      FROM ${KEY_TABLE}
      GROUP BY bad_rutid
      HAVING COUNT(DISTINCT canonical_rutid) > 1
    ) duplicated
  `)

  if (Number(conflicts.rows[0]?.conflicts ?? 0) > 0) {
    throw new Error('Hay bad_rutid repetidos apuntando a canonical_rutid distintos; revisar antes de continuar.')
  }

  const deduped = await pgClient.query(`
    WITH ranked AS (
      SELECT
        ctid,
        ROW_NUMBER() OVER (
          PARTITION BY bad_rutid
          ORDER BY canonical_rutid, ctid
        ) AS rn
      FROM ${KEY_TABLE}
    ),
    deleted AS (
      DELETE FROM ${KEY_TABLE} keys
      USING ranked
      WHERE keys.ctid = ranked.ctid
        AND ranked.rn > 1
      RETURNING keys.bad_rutid
    )
    SELECT COUNT(*)::integer AS deleted_rows
    FROM deleted
  `)

  log(`[keys] duplicados exactos eliminados=${deduped.rows[0]?.deleted_rows ?? 0}`)
  log('[keys] creando indices de llaves...')
  await pgClient.query(`CREATE UNIQUE INDEX IF NOT EXISTS _padron2024_fix_keys_bad_idx ON ${KEY_TABLE} (bad_rutid)`)
  await pgClient.query(`CREATE INDEX IF NOT EXISTS _padron2024_fix_keys_canonical_idx ON ${KEY_TABLE} (canonical_rutid)`)
  await pgClient.query(`CREATE INDEX IF NOT EXISTS _padron2024_fix_keys_upsert_pending_idx ON ${KEY_TABLE} (bad_rutid) WHERE upserted_at IS NULL`)
  await pgClient.query(`CREATE INDEX IF NOT EXISTS _padron2024_fix_keys_delete_pending_idx ON ${KEY_TABLE} (bad_rutid) WHERE upserted_at IS NOT NULL AND deleted_at IS NULL`)
  log('[keys] indices listos.')
}

async function buildKeysFromLocalFile(pgClient, input, chunkRows) {
  const hasRows = await pgClient.query(`SELECT EXISTS (SELECT 1 FROM ${KEY_TABLE} LIMIT 1) AS has_rows`)
  if (hasRows.rows[0]?.has_rows) {
    log('[keys] tabla de llaves ya tiene datos; no se reconstruye.')
    await ensureKeyIndexes(pgClient)
    return
  }

  log(`[keys] cargando llaves desde ${input}...`)
  const columns = ['bad_rutid', 'canonical_rutid']
  let rows = []
  let processed = 0
  let copied = 0
  let chunk = 0

  const flush = async () => {
    if (rows.length === 0) return
    chunk += 1
    await copyRows(pgClient, KEY_TABLE, columns, rows)
    copied += rows.length
    log(`[keys] chunk=${chunk} copied=${rows.length} total=${copied} processed=${processed}`)
    rows = []
  }

  for await (const rawRow of readPadronCsv(input)) {
    processed += 1
    const mapped = mapPadronRow(rawRow)
    if (mapped) {
      rows.push({
        bad_rutid: mapped.bad_rutid,
        canonical_rutid: mapped.canonical_rutid,
      })
    }

    if (rows.length >= chunkRows) await flush()
  }

  await flush()
  log(`[keys] listo. processed=${processed} copied=${copied}`)
  await ensureKeyIndexes(pgClient)
}

async function ensureTempChunkTable(pgClient) {
  await pgClient.query(`
    CREATE TEMP TABLE IF NOT EXISTS ${TEMP_CHUNK_TABLE} (
      bad_rutid text,
      canonical_rutid text,
      nombres text,
      paterno text,
      materno text,
      comuna_part text,
      region_part text,
      domicilio_comuna text,
      domicilio_region text
    ) ON COMMIT PRESERVE ROWS
  `)
}

function fillTextColumn(column) {
  return `
    CASE
      WHEN EXISTS (
        SELECT 1 FROM ${KEY_TABLE} target_bad
        WHERE target_bad.bad_rutid = public.personas_master.rutid
      )
        THEN COALESCE(EXCLUDED.${column}, public.personas_master.${column})
      ELSE COALESCE(NULLIF(public.personas_master.${column}, ''), EXCLUDED.${column}, public.personas_master.${column})
    END
  `
}

function hasMissingValueCondition(column) {
  return `(public.personas_master.${column} IS NULL OR public.personas_master.${column} = '') AND EXCLUDED.${column} IS NOT NULL`
}

async function upsertCurrentChunk(pgClient) {
  const result = await pgClient.query(`
    WITH source AS (
      SELECT DISTINCT ON (chunk.canonical_rutid)
        chunk.canonical_rutid AS rutid,
        NULLIF(chunk.nombres, '') AS nombres,
        NULLIF(chunk.paterno, '') AS paterno,
        NULLIF(chunk.materno, '') AS materno,
        NULLIF(chunk.comuna_part, '') AS comuna_part,
        NULLIF(chunk.region_part, '') AS region_part,
        NULLIF(chunk.domicilio_comuna, '') AS domicilio_comuna,
        NULLIF(chunk.domicilio_region, '') AS domicilio_region
      FROM ${TEMP_CHUNK_TABLE} chunk
      JOIN ${KEY_TABLE} keys
        ON keys.bad_rutid = chunk.bad_rutid
      WHERE keys.upserted_at IS NULL
      ORDER BY chunk.canonical_rutid, chunk.bad_rutid
    ),
    upserted AS (
      INSERT INTO public.personas_master (
        rutid,
        nombres,
        paterno,
        materno,
        comuna_part,
        region_part,
        domicilio_comuna,
        domicilio_region,
        n_autos,
        n_bienes_raices,
        totalavaluos,
        loaded_at
      )
      SELECT
        rutid,
        nombres,
        paterno,
        materno,
        comuna_part,
        region_part,
        domicilio_comuna,
        domicilio_region,
        0,
        0,
        0,
        now()
      FROM source
      ON CONFLICT (rutid) DO UPDATE
      SET
        nombres = ${fillTextColumn('nombres')},
        paterno = ${fillTextColumn('paterno')},
        materno = ${fillTextColumn('materno')},
        comuna_part = ${fillTextColumn('comuna_part')},
        region_part = ${fillTextColumn('region_part')},
        domicilio_comuna = ${fillTextColumn('domicilio_comuna')},
        domicilio_region = ${fillTextColumn('domicilio_region')},
        loaded_at = GREATEST(public.personas_master.loaded_at, EXCLUDED.loaded_at)
      WHERE
        EXISTS (
          SELECT 1 FROM ${KEY_TABLE} target_bad
          WHERE target_bad.bad_rutid = public.personas_master.rutid
        )
        OR ${hasMissingValueCondition('nombres')}
        OR ${hasMissingValueCondition('paterno')}
        OR ${hasMissingValueCondition('materno')}
        OR ${hasMissingValueCondition('comuna_part')}
        OR ${hasMissingValueCondition('region_part')}
        OR ${hasMissingValueCondition('domicilio_comuna')}
        OR ${hasMissingValueCondition('domicilio_region')}
      RETURNING rutid
    ),
    marked AS (
      UPDATE ${KEY_TABLE} keys
      SET upserted_at = now()
      FROM ${TEMP_CHUNK_TABLE} chunk
      WHERE keys.bad_rutid = chunk.bad_rutid
        AND keys.upserted_at IS NULL
      RETURNING keys.bad_rutid
    )
    SELECT
      (SELECT COUNT(*)::integer FROM ${TEMP_CHUNK_TABLE}) AS source_rows,
      (SELECT COUNT(*)::integer FROM source) AS canonical_rows,
      (SELECT COUNT(*)::integer FROM upserted) AS affected_rows,
      (SELECT COUNT(*)::integer FROM marked) AS marked_rows
  `)

  return result.rows[0]
}

async function upsertFromLocalFile(pgClient, input, chunkRows) {
  log(`[upsert] procesando ${input} por chunks de ${chunkRows}...`)
  await ensureTempChunkTable(pgClient)

  const columns = [
    'bad_rutid',
    'canonical_rutid',
    'nombres',
    'paterno',
    'materno',
    'comuna_part',
    'region_part',
    'domicilio_comuna',
    'domicilio_region',
  ]
  let rows = []
  let processed = 0
  let chunk = 0
  let affectedTotal = 0

  const flush = async () => {
    if (rows.length === 0) return
    chunk += 1
    await pgClient.query(`TRUNCATE TABLE ${TEMP_CHUNK_TABLE}`)
    await copyRows(pgClient, TEMP_CHUNK_TABLE, columns, rows)
    const metrics = await upsertCurrentChunk(pgClient)
    affectedTotal += Number(metrics?.affected_rows ?? 0)
    log(`[upsert] chunk=${chunk} source=${metrics.source_rows} canonical=${metrics.canonical_rows} affected=${metrics.affected_rows} marked=${metrics.marked_rows} processed=${processed} affected_total=${affectedTotal}`)
    rows = []
  }

  for await (const rawRow of readPadronCsv(input)) {
    processed += 1
    const mapped = mapPadronRow(rawRow)
    if (mapped) rows.push(mapped)
    if (rows.length >= chunkRows) await flush()
  }

  await flush()
  log(`[upsert] listo. processed=${processed} affected_total=${affectedTotal}`)
}

async function deleteBadKeys(pgClient, chunkRows) {
  log(`[delete] borrando bad_rutid por chunks de ${chunkRows}...`)
  let chunk = 0
  let processed = 0
  let deletedTotal = 0
  let skippedTotal = 0

  for (;;) {
    const result = await pgClient.query(`
      WITH batch AS (
        SELECT keys.bad_rutid
        FROM ${KEY_TABLE} keys
        WHERE keys.upserted_at IS NOT NULL
          AND keys.deleted_at IS NULL
        ORDER BY keys.bad_rutid
        LIMIT $1
      ),
      safe AS (
        SELECT batch.bad_rutid
        FROM batch
        WHERE NOT EXISTS (
          SELECT 1
          FROM ${KEY_TABLE} canonical_target
          WHERE canonical_target.canonical_rutid = batch.bad_rutid
        )
      ),
      skipped AS (
        UPDATE ${KEY_TABLE} keys
        SET deleted_at = now(), delete_skipped = true
        FROM batch
        WHERE keys.bad_rutid = batch.bad_rutid
          AND NOT EXISTS (SELECT 1 FROM safe WHERE safe.bad_rutid = batch.bad_rutid)
        RETURNING keys.bad_rutid
      ),
      deleted AS (
        DELETE FROM public.personas_master pm
        USING safe
        WHERE pm.rutid = safe.bad_rutid
        RETURNING pm.rutid
      ),
      marked AS (
        UPDATE ${KEY_TABLE} keys
        SET deleted_at = now(), delete_skipped = false
        FROM safe
        WHERE keys.bad_rutid = safe.bad_rutid
        RETURNING keys.bad_rutid
      )
      SELECT
        (SELECT COUNT(*)::integer FROM batch) AS batch_rows,
        (SELECT COUNT(*)::integer FROM safe) AS safe_rows,
        (SELECT COUNT(*)::integer FROM skipped) AS skipped_rows,
        (SELECT COUNT(*)::integer FROM deleted) AS deleted_rows,
        (SELECT COUNT(*)::integer FROM marked) AS marked_rows
    `, [chunkRows])

    const metrics = result.rows[0]
    const batchRows = Number(metrics?.batch_rows ?? 0)
    if (batchRows === 0) break

    chunk += 1
    processed += batchRows
    deletedTotal += Number(metrics?.deleted_rows ?? 0)
    skippedTotal += Number(metrics?.skipped_rows ?? 0)
    log(`[delete] chunk=${chunk} batch=${batchRows} safe=${metrics.safe_rows} deleted=${metrics.deleted_rows} skipped=${metrics.skipped_rows} processed=${processed} deleted_total=${deletedTotal} skipped_total=${skippedTotal}`)
  }

  log(`[delete] listo. processed=${processed} deleted_total=${deletedTotal} skipped_total=${skippedTotal}`)
}

async function refreshDerivedData(pgClient) {
  log('[refresh] refrescando stats/catalogo...')
  for (const sql of [
    'SELECT refresh_dashboard_stats()',
    'SELECT refresh_company_name_lookup()',
  ]) {
    try {
      await pgClient.query(sql)
    } catch (error) {
      log(`[warn] ${sql}: ${error.message}`)
    }
  }

  await pgClient.query(`
    UPDATE public.data_sources
    SET
      record_count = (SELECT COUNT(*) FROM public.personas_master),
      last_loaded_at = now(),
      last_job_status = 'completed',
      updated_at = now()
    WHERE slug = 'master_personas'
  `)
}

async function logEstimates(pgClient) {
  const result = await pgClient.query(`
    SELECT reltuples::bigint AS estimated_rows,
           pg_size_pretty(pg_total_relation_size('${KEY_TABLE}'::regclass)) AS size
    FROM pg_class
    WHERE oid = '${KEY_TABLE}'::regclass
  `)
  log(`[status] key_table estimated_rows=${result.rows[0]?.estimated_rows ?? 'unknown'} size=${result.rows[0]?.size ?? 'unknown'}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(args.input)) throw new Error(`No existe input: ${args.input}`)

  const pgClient = new Client(resolvePgConfig())
  await pgClient.connect()
  await pgClient.query('SET statement_timeout = 0')
  await pgClient.query('SET lock_timeout = 0')

  try {
    await ensureKeyTable(pgClient, args)
    if (['all', 'keys'].includes(args.phase)) {
      await buildKeysFromLocalFile(pgClient, args.input, args.chunkRows)
      await logEstimates(pgClient)
    }
    if (['all', 'upsert'].includes(args.phase)) {
      await upsertFromLocalFile(pgClient, args.input, args.chunkRows)
      await logEstimates(pgClient)
    }
    if (['all', 'delete'].includes(args.phase)) {
      await deleteBadKeys(pgClient, args.chunkRows)
    }
    if (['all', 'refresh'].includes(args.phase)) {
      await refreshDerivedData(pgClient)
    }
  } finally {
    await pgClient.end()
  }
}

main().catch(error => {
  console.error(`\nFallo en fix-padron2024-local-chunks: ${error.message}`)
  process.exitCode = 1
})
