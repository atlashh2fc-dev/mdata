#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'

import { Client } from 'pg'
import { from as copyFrom } from 'pg-copy-streams'

const DEFAULT_FILE = '/Volumes/matheus/Base de datos/BD_BBRR_MKT4102.zip'
const STAGE_COLUMNS = [
  'rol',
  'manzana',
  'predio',
  'direccion',
  'comuna',
  'tipo_propiedad',
  'destino',
  'avaluo_fiscal',
  'rutid',
  'nombre_razon_social',
  'fono_area_comer',
  'fono_numero_comer',
  'fono_area_part',
  'fono_numero_part',
  'fono_area_cel',
  'fono_numero_cel',
  'email',
  'source_file',
]
const DEFAULT_AGG_BATCH_SIZE = Number(process.env.BBRR_AGG_BATCH_SIZE ?? 2000)
const DEFAULT_CONNECT_RETRIES = Number(process.env.BBRR_CONNECT_RETRIES ?? 8)
const PROGRESS_DIR = path.resolve(process.cwd(), 'tmp/master-sync-progress')

function getProgressPath(file) {
  const base = path.basename(file).replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(PROGRESS_DIR, `${base}.bbrr-progress.json`)
}

function parseArgs(argv) {
  const args = {
    file: DEFAULT_FILE,
    chunkRows: Number(process.env.BBRR_CHUNK_ROWS ?? 50000),
    aggBatchSize: DEFAULT_AGG_BATCH_SIZE,
    connectRetries: DEFAULT_CONNECT_RETRIES,
    resume: true,
    limit: 0,
    dryRun: false,
    refreshStats: true,
    skipRollups: false,
  }

  for (const rawArg of argv) {
    if (rawArg === '--dry-run') {
      args.dryRun = true
    } else if (rawArg === '--restart') {
      args.resume = false
    } else if (rawArg === '--no-refresh-stats') {
      args.refreshStats = false
    } else if (rawArg === '--skip-rollups') {
      args.skipRollups = true
    } else if (rawArg.startsWith('--file=')) {
      args.file = path.resolve(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--chunk-rows=')) {
      args.chunkRows = Number(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--agg-batch-size=')) {
      args.aggBatchSize = Number(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--connect-retries=')) {
      args.connectRetries = Number(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--limit=')) {
      args.limit = Number(rawArg.split('=')[1])
    }
  }

  if (!Number.isFinite(args.chunkRows) || args.chunkRows < 1000) {
    throw new Error(`chunk-rows invalido: ${args.chunkRows}`)
  }

  if (!Number.isFinite(args.limit) || args.limit < 0) {
    throw new Error(`limit invalido: ${args.limit}`)
  }

  if (!Number.isFinite(args.aggBatchSize) || args.aggBatchSize < 100) {
    throw new Error(`agg-batch-size invalido: ${args.aggBatchSize}`)
  }

  if (!Number.isFinite(args.connectRetries) || args.connectRetries < 1) {
    throw new Error(`connect-retries invalido: ${args.connectRetries}`)
  }

  if (!fs.existsSync(args.file)) {
    throw new Error(`Archivo no encontrado: ${args.file}`)
  }

  return args
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

function quoteIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`
}

function csvEscape(value) {
  const text = String(value ?? '')
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '')
}

function normalizeRutid(value) {
  const clean = String(value ?? '').replace(/[.\-\s]/g, '').trim().toUpperCase()
  if (!clean) return null
  return clean.padStart(10, '0')
}

function normalizeMoney(value) {
  const clean = String(value ?? '').replace(/[^0-9,.\-]/g, '').trim()
  if (!clean) return ''
  if (clean.includes(',') && clean.includes('.')) {
    return clean.replace(/\./g, '').replace(',', '.')
  }
  if (clean.includes(',')) {
    return clean.replace(/\./g, '').replace(',', '.')
  }
  return clean
}

function normalizeText(value) {
  const text = String(value ?? '').trim()
  return text
}

function buildCsvRow(record, sourceFile) {
  return [
    normalizeText(record.ROL),
    normalizeText(record.MANZANA),
    normalizeText(record.PREDIO),
    normalizeText(record.DIRECCION),
    normalizeText(record.COMUNA),
    normalizeText(record.TIPO_PROPIEDAD),
    normalizeText(record.DESTINO),
    normalizeMoney(record.AVALUO_FISCAL),
    normalizeRutid(record.RUTID) ?? '',
    normalizeText(record.NOMBRE_RAZONSOCIAL),
    digitsOnly(record.FONO_AREA_COMER),
    digitsOnly(record.FONO_NUMERO_COMER),
    digitsOnly(record.FONO_AREA_PART),
    digitsOnly(record.FONO_NUMERO_PART),
    digitsOnly(record.FONO_AREA_CEL),
    digitsOnly(record.FONO_NUMERO_CEL),
    normalizeText(record.EMAIL).toLowerCase(),
    sourceFile,
  ]
}

function createInputStream(file, startLine = 1) {
  const useTail = startLine > 1 && !file.toLowerCase().endsWith('.zip')

  if (useTail) {
    const child = spawn('tail', ['-n', `+${startLine}`, file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const stderr = []
    let stopped = false
    child.stderr.on('data', chunk => stderr.push(String(chunk)))

    const closePromise = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => {
        if (code === 0 || code === null || code === 15 || stopped) resolve()
        else reject(new Error(`tail fallo (${code}): ${stderr.join('').trim()}`))
      })
    })

    return {
      stream: child.stdout,
      closePromise,
      stop() {
        stopped = true
        child.stdout.destroy()
        child.kill('SIGTERM')
      },
    }
  }

  if (file.toLowerCase().endsWith('.zip')) {
    const child = spawn('unzip', ['-p', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const stderr = []
    let stopped = false
    child.stderr.on('data', chunk => stderr.push(String(chunk)))

    const closePromise = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => {
        if (code === 0 || code === null || code === 15 || (stopped && code === 80)) resolve()
        else reject(new Error(`unzip -p fallo (${code}): ${stderr.join('').trim()}`))
      })
    })

    return {
      stream: child.stdout,
      closePromise,
      stop() {
        stopped = true
        child.stdout.destroy()
        child.kill('SIGTERM')
      },
    }
  }

  return {
    stream: fs.createReadStream(file),
    closePromise: Promise.resolve(),
    stop() {
      this.stream.destroy()
    },
  }
}

function getPgConfig() {
  if (process.env.POSTGRES_URL_NON_POOLING) {
    const url = new URL(process.env.POSTGRES_URL_NON_POOLING)
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      database: url.pathname.replace(/^\//, ''),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      ssl: { rejectUnauthorized: false },
      statement_timeout: 0,
      query_timeout: 0,
      connectionTimeoutMillis: 30000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      application_name: 'import-bbrr-propiedades',
    }
  }

  if (process.env.POSTGRES_URL) {
    const url = new URL(process.env.POSTGRES_URL)
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      database: url.pathname.replace(/^\//, ''),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      ssl: { rejectUnauthorized: false },
      statement_timeout: 0,
      query_timeout: 0,
      connectionTimeoutMillis: 30000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      application_name: 'import-bbrr-propiedades',
    }
  }

  if (process.env.SUPABASE_DB_HOST) {
    return {
      host: process.env.SUPABASE_DB_HOST,
      port: Number(process.env.SUPABASE_DB_PORT ?? 5432),
      database: process.env.SUPABASE_DB_NAME,
      user: process.env.SUPABASE_DB_USER,
      password: process.env.SUPABASE_DB_PASSWORD,
      ssl: { rejectUnauthorized: false },
      statement_timeout: 0,
      query_timeout: 0,
      connectionTimeoutMillis: 30000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      application_name: 'import-bbrr-propiedades',
    }
  }

  throw new Error('Faltan credenciales Postgres/Supabase para ejecutar el import.')
}

function readProgress(file) {
  const progressPath = getProgressPath(file)
  if (!fs.existsSync(progressPath)) return null

  try {
    return JSON.parse(fs.readFileSync(progressPath, 'utf8'))
  } catch {
    return null
  }
}

function writeProgress(file, payload) {
  fs.mkdirSync(PROGRESS_DIR, { recursive: true })
  fs.writeFileSync(
    getProgressPath(file),
    JSON.stringify(
      {
        ...payload,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    )
  )
}

function clearProgress(file) {
  const progressPath = getProgressPath(file)
  if (fs.existsSync(progressPath)) fs.unlinkSync(progressPath)
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function connectClientWithRetry(config, retries) {
  let attempt = 0
  let lastError = null

  while (attempt < retries) {
    attempt += 1
    const client = new Client(config)
    try {
      await client.connect()
      return client
    } catch (error) {
      lastError = error
      await client.end().catch(() => {})
      if (attempt >= retries) break
      const delayMs = Math.min(5000 * attempt, 30000)
      console.warn(`[pg] conexion fallo (${error.message}). Reintentando ${attempt}/${retries} en ${delayMs}ms...`)
      await wait(delayMs)
    }
  }

  throw lastError ?? new Error('No se pudo establecer conexion Postgres.')
}

async function ensureChunkFile(chunkFile) {
  await fs.promises.mkdir(path.dirname(chunkFile), { recursive: true })
  const writer = fs.createWriteStream(chunkFile, { encoding: 'utf8' })
  writer.write(`${STAGE_COLUMNS.join(',')}\n`)
  return writer
}

async function appendCsvLine(writer, values) {
  const line = `${values.map(value => csvEscape(value)).join(',')}\n`
  if (!writer.write(line)) {
    await once(writer, 'drain')
  }
}

async function closeWriter(writer) {
  writer.end()
  await once(writer, 'finish')
}

async function prepareStage(client) {
  await client.query(`
    DROP TABLE IF EXISTS bbrr_stage
  `)

  await client.query(`
    CREATE TEMP TABLE bbrr_stage (
      rol TEXT,
      manzana TEXT,
      predio TEXT,
      direccion TEXT,
      comuna TEXT,
      tipo_propiedad TEXT,
      destino TEXT,
      avaluo_fiscal NUMERIC(18,2),
      rutid TEXT,
      nombre_razon_social TEXT,
      fono_area_comer TEXT,
      fono_numero_comer TEXT,
      fono_area_part TEXT,
      fono_numero_part TEXT,
      fono_area_cel TEXT,
      fono_numero_cel TEXT,
      email TEXT,
      source_file TEXT
    )
  `)
}

async function configureSession(client) {
  await client.query('SET statement_timeout TO 0')
  await client.query('SET lock_timeout TO 0')
  await client.query('SET idle_in_transaction_session_timeout TO 0')
  for (const sql of [
    "SET synchronous_commit TO OFF",
    "SET work_mem TO '64MB'",
    "SET maintenance_work_mem TO '128MB'",
  ]) {
    try {
      await client.query(sql)
    } catch {
      // ignore settings not allowed by the upstream Postgres plan
    }
  }
}

async function inspectSchema(client) {
  const columnsRes = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('personas_master', 'acumulado_resumen')
  `)

  const schema = {
    personasMasterColumns: new Set(),
    hasAcumuladoResumen: false,
  }

  for (const row of columnsRes.rows) {
    if (row.table_name === 'personas_master') {
      schema.personasMasterColumns.add(row.column_name)
    }
    if (row.table_name === 'acumulado_resumen') {
      schema.hasAcumuladoResumen = true
    }
  }

  return schema
}

async function copyChunkToStage(client, chunkFile) {
  await client.query('TRUNCATE TABLE bbrr_stage')
  const copySql = `
    COPY bbrr_stage (${STAGE_COLUMNS.join(', ')})
    FROM STDIN WITH (FORMAT csv, HEADER true)
  `
  const copyStream = client.query(copyFrom(copySql))
  await pipeline(fs.createReadStream(chunkFile), copyStream)

  await client.query(`
    DELETE FROM bbrr_stage
    WHERE NULLIF(BTRIM(rol), '') IS NULL
  `)
}

async function applyChunk(client, schema, aggBatchSize, options = {}) {
  const skipRollups = options.skipRollups === true

  await client.query(`
    INSERT INTO public.bbrr_propiedades (
      rol,
      manzana,
      predio,
      direccion,
      comuna,
      tipo_propiedad,
      destino,
      avaluo_fiscal,
      rutid,
      nombre_razon_social,
      fono_area_comer,
      fono_numero_comer,
      fono_area_part,
      fono_numero_part,
      fono_area_cel,
      fono_numero_cel,
      email,
      source_file,
      source_loaded_at
    )
    SELECT
      NULLIF(BTRIM(rol), ''),
      NULLIF(BTRIM(manzana), ''),
      NULLIF(BTRIM(predio), ''),
      NULLIF(BTRIM(direccion), ''),
      NULLIF(BTRIM(comuna), ''),
      NULLIF(BTRIM(tipo_propiedad), ''),
      NULLIF(BTRIM(destino), ''),
      avaluo_fiscal,
      NULLIF(BTRIM(rutid), ''),
      NULLIF(BTRIM(nombre_razon_social), ''),
      NULLIF(BTRIM(fono_area_comer), ''),
      NULLIF(BTRIM(fono_numero_comer), ''),
      NULLIF(BTRIM(fono_area_part), ''),
      NULLIF(BTRIM(fono_numero_part), ''),
      NULLIF(BTRIM(fono_area_cel), ''),
      NULLIF(BTRIM(fono_numero_cel), ''),
      NULLIF(BTRIM(email), ''),
      NULLIF(BTRIM(source_file), ''),
      NOW()
    FROM bbrr_stage
    ON CONFLICT (rol) DO UPDATE
    SET
      manzana = EXCLUDED.manzana,
      predio = EXCLUDED.predio,
      direccion = EXCLUDED.direccion,
      comuna = EXCLUDED.comuna,
      tipo_propiedad = EXCLUDED.tipo_propiedad,
      destino = EXCLUDED.destino,
      avaluo_fiscal = EXCLUDED.avaluo_fiscal,
      rutid = EXCLUDED.rutid,
      nombre_razon_social = EXCLUDED.nombre_razon_social,
      fono_area_comer = EXCLUDED.fono_area_comer,
      fono_numero_comer = EXCLUDED.fono_numero_comer,
      fono_area_part = EXCLUDED.fono_area_part,
      fono_numero_part = EXCLUDED.fono_numero_part,
      fono_area_cel = EXCLUDED.fono_area_cel,
      fono_numero_cel = EXCLUDED.fono_numero_cel,
      email = EXCLUDED.email,
      source_file = EXCLUDED.source_file,
      source_loaded_at = NOW(),
      updated_at = NOW()
  `)

  await client.query(`
    INSERT INTO public.master_personas (rutid)
    SELECT DISTINCT s.rutid
    FROM bbrr_stage s
    WHERE NULLIF(BTRIM(s.rutid), '') IS NOT NULL
    ON CONFLICT (rutid) DO NOTHING
  `)

  await client.query(`
    INSERT INTO public.personas_master (rutid)
    SELECT DISTINCT s.rutid
    FROM bbrr_stage s
    WHERE NULLIF(BTRIM(s.rutid), '') IS NOT NULL
    ON CONFLICT (rutid) DO NOTHING
  `)

  if (skipRollups) {
    const metrics = await client.query(`
      SELECT
        (SELECT COUNT(*)::BIGINT FROM bbrr_stage) AS chunk_rows,
        (SELECT COUNT(*)::BIGINT FROM bbrr_stage WHERE NULLIF(BTRIM(rutid), '') IS NOT NULL) AS chunk_with_rutid,
        (
          SELECT COUNT(DISTINCT NULLIF(BTRIM(rutid), ''))::BIGINT
          FROM bbrr_stage
          WHERE NULLIF(BTRIM(rutid), '') IS NOT NULL
        ) AS affected_rutids,
        (
          SELECT COALESCE(SUM(COALESCE(avaluo_fiscal, 0)), 0)::NUMERIC(18,2)
          FROM bbrr_stage
        ) AS chunk_avaluo_total
    `)

    return metrics.rows[0]
  }

  await client.query(`
    DROP TABLE IF EXISTS bbrr_stage_rutids
  `)

  await client.query(`
    CREATE TEMP TABLE bbrr_stage_rutids AS
    SELECT DISTINCT NULLIF(BTRIM(rutid), '') AS rutid
    FROM bbrr_stage
    WHERE NULLIF(BTRIM(rutid), '') IS NOT NULL
  `)

  await client.query(`
    DROP TABLE IF EXISTS bbrr_stage_agg
  `)

  await client.query(`
    CREATE TEMP TABLE bbrr_stage_agg AS
    SELECT
      p.rutid,
      COUNT(*)::INTEGER AS n_bienes_raices,
      COALESCE(SUM(COALESCE(p.avaluo_fiscal, 0)), 0)::NUMERIC(18,2) AS totalavaluos,
      ROW_NUMBER() OVER (ORDER BY p.rutid) AS rn
    FROM public.bbrr_propiedades p
    INNER JOIN bbrr_stage_rutids r
      ON r.rutid = p.rutid
    GROUP BY p.rutid
  `)

  await client.query(`
    CREATE INDEX bbrr_stage_agg_rn_idx ON bbrr_stage_agg (rn)
  `)

  if (schema.hasAcumuladoResumen) {
    const countRes = await client.query('SELECT COUNT(*)::INTEGER AS count FROM bbrr_stage_agg')
    const totalAggRows = Number(countRes.rows[0]?.count ?? 0)
    for (let start = 1; start <= totalAggRows; start += aggBatchSize) {
      const end = start + aggBatchSize - 1
      await client.query(`
        INSERT INTO public.acumulado_resumen (rutid, n_bienes_raices, totalavaluos)
        SELECT
          rutid,
          n_bienes_raices,
          totalavaluos
        FROM bbrr_stage_agg
        WHERE rn BETWEEN $1 AND $2
        ON CONFLICT (rutid) DO UPDATE
        SET
          n_bienes_raices = EXCLUDED.n_bienes_raices,
          totalavaluos = EXCLUDED.totalavaluos,
          updated_at = NOW()
      `, [start, end])
    }
  }

  const personasMasterUpdates = []
  if (schema.personasMasterColumns.has('n_bienes_raices')) {
    personasMasterUpdates.push('n_bienes_raices = agg.n_bienes_raices')
  }
  if (schema.personasMasterColumns.has('totalavaluos')) {
    personasMasterUpdates.push('totalavaluos = agg.totalavaluos')
  }
  if (schema.personasMasterColumns.has('tiene_bienes_raices')) {
    personasMasterUpdates.push('tiene_bienes_raices = agg.n_bienes_raices > 0')
  }
  if (schema.personasMasterColumns.has('loaded_at')) {
    personasMasterUpdates.push('loaded_at = NOW()')
  }
  if (schema.personasMasterColumns.has('updated_at')) {
    personasMasterUpdates.push('updated_at = NOW()')
  }

  if (personasMasterUpdates.length > 0) {
    const countRes = await client.query('SELECT COUNT(*)::INTEGER AS count FROM bbrr_stage_agg')
    const totalAggRows = Number(countRes.rows[0]?.count ?? 0)
    for (let start = 1; start <= totalAggRows; start += aggBatchSize) {
      const end = start + aggBatchSize - 1
      await client.query(`
        UPDATE public.personas_master pm
        SET
          ${personasMasterUpdates.join(', ')}
        FROM (
          SELECT rutid, n_bienes_raices, totalavaluos
          FROM bbrr_stage_agg
          WHERE rn BETWEEN $1 AND $2
        ) agg
        WHERE pm.rutid = agg.rutid
      `, [start, end])
    }
  }

  const metrics = await client.query(`
    SELECT
      (SELECT COUNT(*)::BIGINT FROM bbrr_stage) AS chunk_rows,
      (SELECT COUNT(*)::BIGINT FROM bbrr_stage WHERE NULLIF(BTRIM(rutid), '') IS NOT NULL) AS chunk_with_rutid,
      (SELECT COUNT(*)::BIGINT FROM bbrr_stage_rutids) AS affected_rutids,
      (
        SELECT COALESCE(SUM(COALESCE(avaluo_fiscal, 0)), 0)::NUMERIC(18,2)
        FROM bbrr_stage
      ) AS chunk_avaluo_total
  `)

  return metrics.rows[0]
}

async function refreshStats(client) {
  for (const sql of [
    'REFRESH MATERIALIZED VIEW public.dashboard_stats',
    'REFRESH MATERIALIZED VIEW public.stats_por_region',
    'REFRESH MATERIALIZED VIEW public.stats_score_dist',
    'REFRESH MATERIALIZED VIEW public.stats_universos',
  ]) {
    try {
      await client.query(sql)
    } catch {
      // ignore views not present
    }
  }
}

async function syncSourceMetadata(client) {
  await client.query(`
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
      last_loaded_at,
      last_job_status
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
      TRUE,
      NOW(),
      'completed'
    )
    ON CONFLICT (slug) DO UPDATE
    SET
      description = EXCLUDED.description,
      canonical_table = EXCLUDED.canonical_table,
      source_table_name = EXCLUDED.source_table_name,
      primary_key_column = EXCLUDED.primary_key_column,
      supports_incremental = EXCLUDED.supports_incremental,
      is_active = TRUE,
      last_loaded_at = NOW(),
      last_job_status = 'completed',
      updated_at = NOW()
  `)
}

function isRetryableRuntimeError(error) {
  const message = String(error?.message ?? '').toLowerCase()
  return [
    'connection terminated unexpectedly',
    'read econnreset',
    'write epipe',
    'socket hang up',
    'terminating connection due to administrator command',
    'server closed the connection unexpectedly',
    'connection ended unexpectedly',
    'client network socket disconnected',
    'timeout expired',
    'etl_conn_reset_marker',
  ].some(fragment => message.includes(fragment))
}

async function runOnce(args) {
  const chunkDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbrr-propiedades-'))
  const sourceFileName = path.basename(args.file)

  let client = null
  let schema = null
  let fatalClientError = null
  if (!args.dryRun) {
    client = await connectClientWithRetry(getPgConfig(), args.connectRetries)
    client.on('error', error => {
      fatalClientError = error
      console.error(`[pg] ${error.message}`)
    })
    await configureSession(client)
    await prepareStage(client)
    if (!args.skipRollups) {
      schema = await inspectSchema(client)
    }
    await syncSourceMetadata(client)
  }

  const storedProgress = args.resume ? readProgress(args.file) : null
  const dbLoadedRows = args.dryRun
    ? 0
    : Number((await client.query('SELECT COUNT(*)::BIGINT AS count FROM public.bbrr_propiedades')).rows[0]?.count ?? 0)
  const resumeRows = Math.max(storedProgress?.processedRows ?? 0, storedProgress ? 0 : dbLoadedRows)

  if (!args.resume) {
    clearProgress(args.file)
  } else if (resumeRows > 0) {
    log(
      storedProgress
        ? `retomando desde checkpoint: ${resumeRows.toLocaleString()} filas procesadas`
        : `retomando por conteo existente: ${resumeRows.toLocaleString()} filas ya cargadas`
    )
  }

  const startLine = args.file.toLowerCase().endsWith('.zip')
    ? 1
    : Math.max(resumeRows + 2, 1)
  const input = createInputStream(args.file, startLine)
  const rl = readline.createInterface({
    input: input.stream,
    crlfDelay: Infinity,
  })

  let chunkRows = 0
  let chunkNumber = 0
  let totalRows = 0
  let skippedRows = 0
  let headerSeen = false
  let chunkFile = ''
  let writer = null
  let reachedLimit = false

  const totals = {
    chunks: 0,
    rows: 0,
    withRutid: 0,
    affectedRutids: 0,
    avaluoTotal: 0,
  }

  const openChunk = async () => {
    chunkNumber += 1
    chunkRows = 0
    chunkFile = path.join(chunkDir, `bbrr_chunk_${String(chunkNumber).padStart(4, '0')}.csv`)
    writer = await ensureChunkFile(chunkFile)
  }

  const flushChunk = async () => {
    if (!writer || chunkRows === 0) return
    await closeWriter(writer)

    if (args.dryRun) {
      log(`dry-run chunk=${chunkNumber} rows=${chunkRows} file=${chunkFile}`)
    } else {
      if (fatalClientError) throw fatalClientError
      await copyChunkToStage(client, chunkFile)
      const metrics = await applyChunk(client, schema, args.aggBatchSize, {
        skipRollups: args.skipRollups,
      })
      totals.withRutid += Number(metrics.chunk_with_rutid ?? 0)
      totals.affectedRutids += Number(metrics.affected_rutids ?? 0)
      totals.avaluoTotal += Number(metrics.chunk_avaluo_total ?? 0)
      log(
        `chunk=${chunkNumber} rows=${metrics.chunk_rows} rutid=${metrics.chunk_with_rutid} ` +
        `rutids_afectados=${metrics.affected_rutids} avaluo=${metrics.chunk_avaluo_total}` +
        (args.skipRollups ? ' rollups=deferred' : '')
      )
    }

    totals.chunks += 1
    writeProgress(args.file, {
      processedRows: resumeRows + totals.rows,
      chunksCompleted: totals.chunks,
      chunkRowsSetting: args.chunkRows,
      aggBatchSize: args.aggBatchSize,
    })
    await fs.promises.unlink(chunkFile).catch(() => {})
    writer = null
  }

  try {
    for await (const rawLine of rl) {
      const line = String(rawLine ?? '').replace(/\r$/, '')
      if (!line) continue

      if (!headerSeen) {
        headerSeen = true
        if (startLine === 1) continue
      }

      if (startLine === 1 && skippedRows < resumeRows) {
        skippedRows += 1
        continue
      }

      if (args.limit > 0 && totalRows >= args.limit) {
        reachedLimit = true
        break
      }
      if (!writer) await openChunk()

      const values = line.split('|')
      const record = {
        ROL: values[0],
        MANZANA: values[1],
        PREDIO: values[2],
        DIRECCION: values[3],
        COMUNA: values[4],
        TIPO_PROPIEDAD: values[5],
        DESTINO: values[6],
        AVALUO_FISCAL: values[7],
        RUTID: values[8],
        NOMBRE_RAZONSOCIAL: values[9],
        FONO_AREA_COMER: values[10],
        FONO_NUMERO_COMER: values[11],
        FONO_AREA_PART: values[12],
        FONO_NUMERO_PART: values[13],
        FONO_AREA_CEL: values[14],
        FONO_NUMERO_CEL: values[15],
        EMAIL: values[16],
      }

      await appendCsvLine(writer, buildCsvRow(record, sourceFileName))

      chunkRows += 1
      totalRows += 1
      totals.rows += 1

      if (chunkRows >= args.chunkRows) {
        await flushChunk()
      }
    }

    await flushChunk()
    if (reachedLimit) {
      input.stop()
    }
    await input.closePromise

    if (client && args.refreshStats) {
      await refreshStats(client)
    }

    if (!reachedLimit) {
      clearProgress(args.file)
    }

    log(
      `completado chunks=${totals.chunks} rows=${totals.rows} ` +
      `rutid_rows=${totals.withRutid} rutids_afectados=${totals.affectedRutids} ` +
      `avaluo_total=${totals.avaluoTotal.toFixed(2)}`
    )
    if (args.skipRollups) {
      log('rollups diferidos: ejecuta scripts/master-sync/refresh-bbrr-rollups.mjs al finalizar la carga')
    }
  } finally {
    rl.close()
    if (writer) {
      writer.destroy()
    }
    if (client) {
      await client.end().catch(() => {})
    }
    await fs.promises.rm(chunkDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let attempt = 0

  while (true) {
    attempt += 1
    try {
      await runOnce(args)
      return
    } catch (error) {
      if (!isRetryableRuntimeError(error) || attempt >= args.connectRetries) {
        console.error(`\nFallo en import-bbrr-propiedades: ${error.message}`)
        process.exit(1)
      }

      const delayMs = Math.min(15000 * attempt, 120000)
      console.warn(
        `\n[retry] intento ${attempt}/${args.connectRetries} por error transitorio: ${error.message}. ` +
        `Retomando desde checkpoint en ${Math.round(delayMs / 1000)}s...`
      )
      await wait(delayMs)
    }
  }
}

main().catch(error => {
  console.error(`\nFallo en import-bbrr-propiedades: ${error.message}`)
  process.exit(1)
})
