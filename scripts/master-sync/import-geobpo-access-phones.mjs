#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { pipeline } from 'node:stream/promises'

import Papa from 'papaparse'
import { Client } from 'pg'
import { from as copyFrom } from 'pg-copy-streams'

const DEFAULT_ACCESS_FILE = '/Users/hh/Downloads/Telefonos_Geobpo (1).accdb'
const DEFAULT_TEMP_CSV = path.join(os.tmpdir(), 'geobpo_access_phones.slim.csv')
const TABLE_NAME = '2018_pymes_fono_actualizados'
const SOURCE_NAME = 'geobpo_access_phones'
const SOURCE_PRIORITY = 72

const ACCESS_COLUMNS = [
  'RUTID',
  'RUT',
  'DV',
  'NOMBRE_IDE',
  'CALLE_COMER',
  'COMER_NORM',
  'NUMERO_COMER',
  'TIPO_PROPIEDAD_COMER',
  'NUMERO_PROPIEDAD_COMER',
  'RESTO_DIRECCION_COMER',
  'COMUNA_COMER',
  'CIUDAD_COMER',
  'REGION_COMER',
  'TIPO_DIR_COMER',
  'DIRECC_VERIFICADA_COMER',
  'FECHA_DIRECC_COMER',
  'FONO_AREA_PART',
  'FONO_NUMERO_PART',
  'TIPO_FONO_PART',
  'VERIFICADO_FONO_PART',
  'FECHA_FONO_PART',
  'FONO_AREA_COMER',
  'FONO_NUMERO_COMER',
  'TIPO_FONO_COMER',
  'VERIFICADO_FONO_COMER',
  'FECHA_FONO_COMER',
  'FONO_AREA_CEL',
  'FONO_NUMERO_CEL',
  'TIPO_FONO_CEL',
  'VERIFICADO_FONO_CEL',
  'FECHA_FONO_CEL',
  'DICOM',
  'ANO_ULTIMO_TIMBRAJE',
  'telefono',
  'fecha_max',
]

const STAGE_COLUMNS = [
  'rutid',
  'nombre_ide',
  'telefono_raw',
  'telefono_e164',
  'is_verified',
  'quality_score',
  'last_seen_at',
  'fecha_max',
  'fono_numero_cel',
  'verificado_fono_cel',
  'fecha_fono_cel',
  'fono_numero_part',
  'verificado_fono_part',
  'fecha_fono_part',
  'calle_comer',
  'numero_comer',
  'comuna_comer',
  'ciudad_comer',
  'region_comer',
  'dicom',
  'ano_ultimo_timbraje',
]

function parseArgs(argv) {
  const args = {
    file: DEFAULT_ACCESS_FILE,
    tempCsv: DEFAULT_TEMP_CSV,
    dryRun: false,
    limit: 0,
    refreshStats: true,
    chunkRows: Number(process.env.GEOBPO_CHUNK_ROWS ?? 50000),
  }

  for (const rawArg of argv) {
    if (rawArg === '--dry-run') {
      args.dryRun = true
    } else if (rawArg.startsWith('--file=')) {
      args.file = path.resolve(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--temp-csv=')) {
      args.tempCsv = path.resolve(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--limit=')) {
      args.limit = Number(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--chunk-rows=')) {
      args.chunkRows = Number(rawArg.split('=')[1])
    } else if (rawArg === '--no-refresh-stats') {
      args.refreshStats = false
    }
  }

  if (!Number.isFinite(args.limit) || args.limit < 0) {
    throw new Error(`limit invalido: ${args.limit}`)
  }

  if (!Number.isFinite(args.chunkRows) || args.chunkRows < 1000) {
    throw new Error(`chunk-rows invalido: ${args.chunkRows}`)
  }

  return args
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

function isPresent(value) {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '')
}

function normalizeRutid(rutidValue, rutValue, dvValue) {
  const direct = String(rutidValue ?? '').replace(/[.\-\s]/g, '').trim().toUpperCase()
  if (direct.length >= 2) return direct.padStart(10, '0')

  const rut = digitsOnly(rutValue)
  const dv = String(dvValue ?? '').replace(/[^0-9kK]/g, '').trim().toUpperCase()
  if (!rut || !dv) return null
  return `${rut.padStart(9, '0')}${dv}`
}

function normalizeBestPhone(rawValue) {
  const digits = digitsOnly(rawValue)
  if (digits.length === 9 && digits.startsWith('9')) return `+56${digits}`
  if (digits.length === 11 && digits.startsWith('569')) return `+${digits}`
  return null
}

function normalizeAccessDate(value) {
  const digits = digitsOnly(value)
  if (digits.length !== 8) return null

  const year = Number(digits.slice(0, 4))
  const month = Number(digits.slice(4, 6))
  const day = Number(digits.slice(6, 8))
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return null

  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T00:00:00Z`
}

function isVerifiedFlag(value) {
  return String(value ?? '').trim().toUpperCase() === 'VERIFICADO'
}

function calculateQualityScore(record) {
  let score = 68

  if (isVerifiedFlag(record.VERIFICADO_FONO_CEL)) score = 92
  else if (isVerifiedFlag(record.VERIFICADO_FONO_PART)) score = 86
  else if (isPresent(record.FONO_NUMERO_CEL)) score = 78
  else if (isPresent(record.FONO_NUMERO_PART)) score = 73

  const fechaMax = digitsOnly(record.fecha_max)
  if (fechaMax >= '20220101') score += 4
  else if (fechaMax >= '20200101') score += 2

  if (String(record.DICOM ?? '').trim().toUpperCase() === 'SI') score += 1
  return Math.min(score, 96)
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
    }
  }

  if (process.env.POSTGRES_HOST && process.env.POSTGRES_USER && process.env.POSTGRES_DATABASE) {
    return {
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      database: process.env.POSTGRES_DATABASE,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      ssl: { rejectUnauthorized: false },
      statement_timeout: 0,
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
    }
  }

  throw new Error('Faltan credenciales Postgres/Supabase para ejecutar el import.')
}

function buildMetadataJson() {
  return `
    jsonb_strip_nulls(
      jsonb_build_object(
        'source_name', '${SOURCE_NAME}',
        'source_table', '${TABLE_NAME}',
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
  `
}

async function exportAccessToSlimCsv(args) {
  await fs.promises.mkdir(path.dirname(args.tempCsv), { recursive: true })

  const writer = fs.createWriteStream(args.tempCsv, { encoding: 'utf8' })
  writer.write(`${STAGE_COLUMNS.join(',')}\n`)

  const child = spawn('mdb-export', ['-H', '-q', '"', '-d', ',', args.file, TABLE_NAME], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const stderr = []
  child.stderr.on('data', chunk => stderr.push(String(chunk)))

  const parser = child.stdout.pipe(Papa.parse(Papa.NODE_STREAM_INPUT, {
    header: false,
    skipEmptyLines: 'greedy',
  }))

  const stats = {
    totalRows: 0,
    validPhones: 0,
    verifiedRows: 0,
  }

  for await (const rawRow of parser) {
    if (args.limit > 0 && stats.totalRows >= args.limit) {
      child.kill('SIGTERM')
      break
    }

    const row = Array.isArray(rawRow) ? rawRow : []
    const paddedRow = row.length >= ACCESS_COLUMNS.length
      ? row.slice(0, ACCESS_COLUMNS.length)
      : row.concat(Array(ACCESS_COLUMNS.length - row.length).fill(''))
    const record = Object.fromEntries(
      ACCESS_COLUMNS.map((column, index) => [column, paddedRow[index]])
    )

    const rutid = normalizeRutid(record.RUTID, record.RUT, record.DV)
    const telefonoRaw = digitsOnly(record.telefono)
    const telefonoE164 = normalizeBestPhone(telefonoRaw)
    const verified = isVerifiedFlag(record.VERIFICADO_FONO_CEL) || isVerifiedFlag(record.VERIFICADO_FONO_PART)
    const qualityScore = calculateQualityScore(record)
    const lastSeenAt = normalizeAccessDate(record.fecha_max)

    stats.totalRows += 1
    if (telefonoE164) stats.validPhones += 1
    if (verified) stats.verifiedRows += 1

    const csvRow = [
      rutid ?? '',
      String(record.NOMBRE_IDE ?? '').trim(),
      telefonoRaw,
      telefonoE164 ?? '',
      verified ? 'true' : 'false',
      String(qualityScore),
      lastSeenAt ?? '',
      digitsOnly(record.fecha_max),
      digitsOnly(record.FONO_NUMERO_CEL),
      String(record.VERIFICADO_FONO_CEL ?? '').trim(),
      digitsOnly(record.FECHA_FONO_CEL),
      digitsOnly(record.FONO_NUMERO_PART),
      String(record.VERIFICADO_FONO_PART ?? '').trim(),
      digitsOnly(record.FECHA_FONO_PART),
      String(record.CALLE_COMER ?? '').trim(),
      String(record.NUMERO_COMER ?? '').trim(),
      String(record.COMUNA_COMER ?? '').trim(),
      String(record.CIUDAD_COMER ?? '').trim(),
      String(record.REGION_COMER ?? '').trim(),
      String(record.DICOM ?? '').trim(),
      digitsOnly(record.ANO_ULTIMO_TIMBRAJE),
    ].map(value => {
      const text = String(value ?? '')
      if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
      return text
    })

    if (!writer.write(`${csvRow.join(',')}\n`)) {
      await new Promise(resolve => writer.once('drain', resolve))
    }
  }

  writer.end()
  await new Promise(resolve => writer.once('finish', resolve))

  const exitCode = await new Promise(resolve => child.once('close', resolve))
  if (exitCode !== 0 && !(args.limit > 0 && exitCode === null)) {
    throw new Error(`mdb-export fallo (${exitCode}): ${stderr.join('').trim()}`)
  }

  return stats
}

async function prepareStage(client, tempCsv) {
  await client.query(`
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
    )
  `)

  const copySql = `
    COPY geobpo_phone_stage (${STAGE_COLUMNS.join(', ')})
    FROM STDIN WITH (FORMAT csv, HEADER true)
  `
  const copyStream = client.query(copyFrom(copySql))
  await pipeline(fs.createReadStream(tempCsv), copyStream)

  await client.query('CREATE INDEX geobpo_phone_stage_rutid_idx ON geobpo_phone_stage (rutid)')
  await client.query('ANALYZE geobpo_phone_stage')
  await client.query(`
    DELETE FROM geobpo_phone_stage
    WHERE NULLIF(BTRIM(rutid), '') IS NULL
      OR NULLIF(BTRIM(telefono_e164), '') IS NULL
  `)
}

async function collectImpactMetrics(client) {
  const result = await client.query(`
    SELECT
      COUNT(*)::BIGINT AS total_geobpo,
      COUNT(pm.rutid)::BIGINT AS match_personas_master,
      COUNT(*) FILTER (WHERE pm.rutid IS NULL)::BIGINT AS no_match_personas_master,
      COUNT(*) FILTER (
        WHERE pm.rutid IS NOT NULL AND NULLIF(BTRIM(pm.fono_cel), '') IS NULL
      )::BIGINT AS match_sin_fono_actual,
      COUNT(*) FILTER (
        WHERE pm.rutid IS NOT NULL AND NULLIF(BTRIM(pm.fono_cel), '') IS NOT NULL
      )::BIGINT AS match_con_fono_actual,
      COUNT(*) FILTER (
        WHERE pm.rutid IS NOT NULL
          AND NULLIF(BTRIM(pm.fono_cel), '') IS NOT NULL
          AND regexp_replace(pm.fono_cel, '[^0-9]', '', 'g') <> regexp_replace(g.telefono_e164, '[^0-9]', '', 'g')
      )::BIGINT AS fono_distinto_al_actual
    FROM geobpo_phone_stage g
    LEFT JOIN public.personas_master pm ON pm.rutid = g.rutid
  `)

  return result.rows[0]
}

async function applyLoadedStage(client) {
  await client.query(`
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
    INNER JOIN public.personas_master pm
      ON pm.rutid = g.rutid
    WHERE NULLIF(BTRIM(pm.fono_cel), '') IS NULL
  `)

  const backfillUpdate = await client.query(`
    UPDATE public.personas_master pm
    SET
      fono_cel = g.telefono_e164,
      loaded_at = NOW()
    FROM geobpo_backfill_candidates g
    WHERE pm.rutid = g.rutid
      AND NULLIF(BTRIM(pm.fono_cel), '') IS NULL
  `)

  const metadataJson = buildMetadataJson()
  const contactPointInsert = await client.query(`
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
      '${SOURCE_NAME}',
      ${SOURCE_PRIORITY},
      g.quality_score,
      TRUE,
      COALESCE(g.is_verified, FALSE),
      COALESCE(g.last_seen_at, NOW()),
      COALESCE(g.last_seen_at, NOW()),
      ${metadataJson}
    FROM geobpo_backfill_candidates g
    INNER JOIN public.master_personas mp
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
      updated_at = NOW()
  `)

  const candidateCount = await client.query('SELECT COUNT(*)::BIGINT AS count FROM geobpo_backfill_candidates')

  return {
    candidateBackfills: Number(candidateCount.rows[0]?.count ?? 0),
    backfilledPhones: backfillUpdate.rowCount ?? 0,
    upsertedContactPoints: contactPointInsert.rowCount ?? 0,
  }
}

async function refreshStats(client) {
  for (const sql of ['SELECT refresh_dashboard_stats()', 'SELECT refresh_all_stats()']) {
    try {
      await client.query(sql)
      return sql
    } catch {
      // ignore
    }
  }

  return null
}

function csvEscape(value) {
  const text = String(value ?? '')
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

async function appendChunkRow(writer, line) {
  if (!writer.write(`${line}\n`)) {
    await new Promise(resolve => writer.once('drain', resolve))
  }
}

async function processChunk(client, chunkFile, chunkNumber) {
  await client.query('BEGIN')

  try {
    await prepareStage(client, chunkFile)
    const impact = await collectImpactMetrics(client)
    const applied = await applyLoadedStage(client)
    await client.query('COMMIT')

    log(
      `chunk ${chunkNumber}: filas=${impact.total_geobpo} match=${impact.match_personas_master} ` +
      `sin_fono=${impact.match_sin_fono_actual} backfill=${applied.backfilledPhones}`
    )

    return { impact, applied }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function applyImportInChunks(client, tempCsv, chunkRows) {
  const input = fs.createReadStream(tempCsv, { encoding: 'utf8' })
  const rl = readline.createInterface({ input, crlfDelay: Infinity })

  const chunkDir = path.join(os.tmpdir(), 'geobpo-import-chunks')
  await fs.promises.mkdir(chunkDir, { recursive: true })

  let headerSeen = false
  let chunkWriter = null
  let chunkFile = ''
  let rowsInChunk = 0
  let chunkNumber = 0

  const totals = {
    sourceRows: 0,
    matchedRows: 0,
    unmatchedRows: 0,
    matchWithoutPhone: 0,
    matchWithPhone: 0,
    conflictingPhones: 0,
    candidateBackfills: 0,
    backfilledPhones: 0,
    upsertedContactPoints: 0,
    chunks: 0,
  }

  const openChunk = async () => {
    chunkNumber += 1
    chunkFile = path.join(chunkDir, `geobpo_chunk_${String(chunkNumber).padStart(4, '0')}.csv`)
    chunkWriter = fs.createWriteStream(chunkFile, { encoding: 'utf8' })
    chunkWriter.write(`${STAGE_COLUMNS.join(',')}\n`)
    rowsInChunk = 0
  }

  const flushChunk = async () => {
    if (!chunkWriter || rowsInChunk === 0) return

    chunkWriter.end()
    await new Promise(resolve => chunkWriter.once('finish', resolve))

    const { impact, applied } = await processChunk(client, chunkFile, chunkNumber)

    totals.sourceRows += Number(impact.total_geobpo ?? 0)
    totals.matchedRows += Number(impact.match_personas_master ?? 0)
    totals.unmatchedRows += Number(impact.no_match_personas_master ?? 0)
    totals.matchWithoutPhone += Number(impact.match_sin_fono_actual ?? 0)
    totals.matchWithPhone += Number(impact.match_con_fono_actual ?? 0)
    totals.conflictingPhones += Number(impact.fono_distinto_al_actual ?? 0)
    totals.candidateBackfills += applied.candidateBackfills
    totals.backfilledPhones += applied.backfilledPhones
    totals.upsertedContactPoints += applied.upsertedContactPoints
    totals.chunks += 1

    await fs.promises.unlink(chunkFile).catch(() => {})
    chunkWriter = null
    rowsInChunk = 0
  }

  for await (const line of rl) {
    if (!headerSeen) {
      headerSeen = true
      continue
    }

    if (!chunkWriter) await openChunk()

    await appendChunkRow(chunkWriter, line)
    rowsInChunk += 1

    if (rowsInChunk >= chunkRows) {
      await flushChunk()
    }
  }

  await flushChunk()
  return totals
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!fs.existsSync(args.file)) {
    throw new Error(`Archivo Access no encontrado: ${args.file}`)
  }

  log(`exportando ${TABLE_NAME} desde ${args.file}`)
  const exportStats = await exportAccessToSlimCsv(args)
  log(`csv slim generado en ${args.tempCsv}`)
  log(`filas procesadas=${exportStats.totalRows} telefonos_validos=${exportStats.validPhones} verificados=${exportStats.verifiedRows}`)

  const client = new Client(getPgConfig())
  await client.connect()

  try {
    if (args.dryRun) {
      await prepareStage(client, args.tempCsv)
      const impact = await collectImpactMetrics(client)

      console.log(JSON.stringify({
        source_rows: exportStats.totalRows,
        valid_phones: exportStats.validPhones,
        verified_rows: exportStats.verifiedRows,
        impact,
        dry_run: true,
      }, null, 2))
      log('dry-run completado; no se aplicaron cambios en Supabase')
      return
    }

    console.log(JSON.stringify({
      source_rows: exportStats.totalRows,
      valid_phones: exportStats.validPhones,
      verified_rows: exportStats.verifiedRows,
      dry_run: false,
      chunk_rows: args.chunkRows,
    }, null, 2))

    const applied = await applyImportInChunks(client, args.tempCsv, args.chunkRows)

    let refreshed = null
    if (args.refreshStats) {
      refreshed = await refreshStats(client)
    }

    console.log(JSON.stringify({
      applied,
      source: SOURCE_NAME,
      refreshed_stats_with: refreshed,
    }, null, 2))
    log('import finalizado')
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
