import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Papa from 'papaparse'
import { createClient } from '@supabase/supabase-js'

import {
  SOURCE_TABLES,
  INTEGER_COLUMNS,
  NUMERIC_COLUMNS,
} from './config.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DEFAULT_EXPORT_DIR = path.resolve(__dirname, '../../tmp/master-sync')

function parseArgs(argv) {
  const args = {
    table: '',
    file: '',
    workers: Number(process.env.SUPABASE_API_WORKERS ?? 6),
    batchSize: Number(process.env.SUPABASE_API_BATCH_SIZE ?? 250),
    minBatchSize: Number(process.env.SUPABASE_API_MIN_BATCH_SIZE ?? 25),
    skipRows: Number(process.env.SUPABASE_API_SKIP_ROWS ?? 0),
  }

  for (const rawArg of argv) {
    if (rawArg.startsWith('--table=')) {
      args.table = rawArg.split('=')[1]
    } else if (rawArg.startsWith('--file=')) {
      args.file = path.resolve(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--workers=')) {
      args.workers = Number(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--batch-size=')) {
      args.batchSize = Number(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--min-batch-size=')) {
      args.minBatchSize = Number(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--skip-rows=')) {
      args.skipRows = Number(rawArg.split('=')[1])
    }
  }

  if (!args.table) {
    throw new Error('Falta --table=<slug>.')
  }

  if (!args.file) {
    args.file = path.join(DEFAULT_EXPORT_DIR, `${args.table}.csv`)
  }

  if (!Number.isFinite(args.workers) || args.workers < 1) {
    throw new Error(`workers invalido: ${args.workers}`)
  }

  if (!Number.isFinite(args.batchSize) || args.batchSize < 1) {
    throw new Error(`batch-size invalido: ${args.batchSize}`)
  }

  if (!Number.isFinite(args.minBatchSize) || args.minBatchSize < 1) {
    throw new Error(`min-batch-size invalido: ${args.minBatchSize}`)
  }

  if (!Number.isFinite(args.skipRows) || args.skipRows < 0) {
    throw new Error(`skip-rows invalido: ${args.skipRows}`)
  }

  return args
}

function normalizeRut(value) {
  if (value === null || value === undefined) return ''
  const clean = String(value).replace(/[.\-\s]/g, '').trim().toUpperCase()
  if (clean.length < 2) return ''
  return `${clean.slice(0, -1)}-${clean.slice(-1)}`
}

function normalizeInteger(value) {
  if (value === null || value === undefined || value === '') return null
  const normalized = String(value).replace(/[^\d-]/g, '')
  return normalized ? Number(normalized) : null
}

function normalizeNumeric(value) {
  if (value === null || value === undefined || value === '') return null
  const str = String(value).trim()
  const sanitized = str.replace(/[^0-9,.\-]/g, '')
  if (!sanitized) return null

  if (sanitized.includes(',') && sanitized.includes('.')) {
    return Number(sanitized.replace(/\./g, '').replace(',', '.'))
  }

  if (sanitized.includes(',')) {
    return Number(sanitized.replace(/\./g, '').replace(',', '.'))
  }

  return Number(sanitized)
}

function normalizeText(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

function normalizeCell(column, value) {
  if (column === 'rutid') return normalizeRut(value)
  if (INTEGER_COLUMNS.has(column)) return normalizeInteger(value)
  if (NUMERIC_COLUMNS.has(column)) return normalizeNumeric(value)
  return normalizeText(value)
}

function isStatementTimeoutError(error) {
  const message = String(error?.message ?? '').toLowerCase()
  return message.includes('statement timeout') || message.includes('canceling statement due to statement timeout')
}

async function upsertRowsViaSupabaseApi(supabase, config, rows, minBatchSize) {
  if (rows.length === 0) return

  const query = config.targetTable === 'master_personas'
    ? supabase.from(config.targetTable).upsert(rows, { onConflict: 'rutid', ignoreDuplicates: true })
    : supabase.from(config.targetTable).upsert(rows, { onConflict: 'rutid' })

  const { error } = await query
  if (!error) return

  if (rows.length <= minBatchSize || !isStatementTimeoutError(error)) {
    throw new Error(`[${config.slug}] upsert API fallo: ${error.message}`)
  }

  const midpoint = Math.ceil(rows.length / 2)
  const left = rows.slice(0, midpoint)
  const right = rows.slice(midpoint)

  console.warn(
    `[${config.slug}] timeout en batch de ${rows.length}. Reintentando en bloques de ${left.length} y ${right.length}...`
  )

  await upsertRowsViaSupabaseApi(supabase, config, left, minBatchSize)
  await upsertRowsViaSupabaseApi(supabase, config, right, minBatchSize)
}

async function refreshStatsViaApi(supabase) {
  const candidates = ['refresh_all_stats', 'refresh_dashboard_stats']

  for (const fn of candidates) {
    try {
      const { error } = await supabase.rpc(fn)
      if (!error) return
    } catch {
      // try next
    }
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2))
  const config = SOURCE_TABLES.find(table => table.slug === args.table)

  if (!config) {
    throw new Error(`Tabla no soportada: ${args.table}`)
  }

  if (!fs.existsSync(args.file)) {
    throw new Error(`CSV no encontrado: ${args.file}`)
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.')
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )

  const parser = fs
    .createReadStream(args.file)
    .pipe(Papa.parse(Papa.NODE_STREAM_INPUT, { header: true, skipEmptyLines: true }))

  let seenRows = 0
  let loadedRows = 0
  let currentBatch = []
  const inFlight = new Set()

  const scheduleBatch = async rows => {
    const task = (async () => {
      await upsertRowsViaSupabaseApi(supabase, config, rows, args.minBatchSize)
      loadedRows += rows.length

      if (loadedRows % Math.max(args.batchSize * 10, 1000) === 0) {
        console.log(`[${config.slug}] CSV import ${loadedRows} filas...`)
      }
    })()

    inFlight.add(task)

    task.finally(() => {
      inFlight.delete(task)
    })

    if (inFlight.size >= args.workers) {
      await Promise.race(inFlight)
    }
  }

  console.log(
    `[${config.slug}] Importando CSV ${args.file} con workers=${args.workers}, batch=${args.batchSize}, min_batch=${args.minBatchSize}, skip_rows=${args.skipRows}`
  )

  for await (const row of parser) {
    seenRows += 1

    if (seenRows <= args.skipRows) {
      continue
    }

    const normalized = Object.fromEntries(
      config.targetColumns.map(column => [column, normalizeCell(column, row[column])])
    )

    if (!normalized.rutid) continue

    currentBatch.push(normalized)

    if (currentBatch.length >= args.batchSize) {
      const rows = currentBatch
      currentBatch = []
      await scheduleBatch(rows)
    }
  }

  if (currentBatch.length > 0) {
    await scheduleBatch(currentBatch)
  }

  await Promise.all(inFlight)
  await refreshStatsViaApi(supabase)

  console.log(
    `[${config.slug}] CSV import completado. processed=${Math.max(seenRows - args.skipRows, 0)} loaded=${loadedRows}`
  )
}

run().catch(error => {
  console.error(`\nFallo en import-csv-to-supabase: ${error.message}`)
  process.exitCode = 1
})
