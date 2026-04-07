import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import { Client } from 'pg'
import { from as copyFrom } from 'pg-copy-streams'

import {
  SOURCE_TABLES,
  INTEGER_COLUMNS,
  NUMERIC_COLUMNS,
} from './config.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DEFAULT_EXPORT_DIR = path.resolve(__dirname, '../../tmp/master-sync')
const DEFAULT_PROGRESS_DIR = path.resolve(__dirname, '../../tmp/master-sync-progress')

function parseArgs(argv) {
  const args = {
    table: '',
    file: '',
    chunkRows: Number(process.env.CSV_COPY_CHUNK_ROWS ?? 50000),
    skipRows: 0,
    mode: 'upsert',
    restart: false,
  }

  for (const rawArg of argv) {
    if (rawArg.startsWith('--table=')) {
      args.table = rawArg.split('=')[1]
    } else if (rawArg.startsWith('--file=')) {
      args.file = path.resolve(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--chunk-rows=')) {
      args.chunkRows = Number(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--skip-rows=')) {
      args.skipRows = Number(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--mode=')) {
      args.mode = rawArg.split('=')[1]
    } else if (rawArg === '--restart') {
      args.restart = true
    }
  }

  if (!args.table) {
    throw new Error('Falta --table=<slug>.')
  }

  if (!Number.isFinite(args.chunkRows) || args.chunkRows < 1000) {
    throw new Error(`chunk-rows invalido: ${args.chunkRows}`)
  }

  if (!Number.isFinite(args.skipRows) || args.skipRows < 0) {
    throw new Error(`skip-rows invalido: ${args.skipRows}`)
  }

  if (!new Set(['upsert', 'replace-direct']).has(args.mode)) {
    throw new Error(`mode invalido: ${args.mode}`)
  }

  return args
}

function quoteIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`
}

function buildStageTableName(slug) {
  return `import_${slug.replace(/[^a-z0-9_]/g, '_')}_stage`
}

function getProgressPath(slug) {
  return path.join(DEFAULT_PROGRESS_DIR, `${slug}.json`)
}

function logWithTs(message) {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

function readProgress(slug) {
  const progressPath = getProgressPath(slug)
  if (!fs.existsSync(progressPath)) return null
  return JSON.parse(fs.readFileSync(progressPath, 'utf8'))
}

function writeProgress(slug, payload) {
  fs.mkdirSync(DEFAULT_PROGRESS_DIR, { recursive: true })
  fs.writeFileSync(getProgressPath(slug), JSON.stringify(payload, null, 2))
}

function clearProgress(slug) {
  const progressPath = getProgressPath(slug)
  if (fs.existsSync(progressPath)) fs.unlinkSync(progressPath)
}

function scalarValue(result, key) {
  const value = result.rows[0]?.[key]
  return value === undefined || value === null ? 0 : Number(value)
}

function getCopyColumnsSql(columns) {
  return columns.map(column => quoteIdentifier(column)).join(', ')
}

function getSelectExpressions(stageTable, columns) {
  return columns.map(column => {
    const qualified = `${quoteIdentifier(stageTable)}.${quoteIdentifier(column)}`

    if (column === 'rutid') {
      return `NULLIF(TRIM(${qualified}), '')`
    }

    if (INTEGER_COLUMNS.has(column)) {
      return `NULLIF(${qualified}, '')::INTEGER`
    }

    if (NUMERIC_COLUMNS.has(column)) {
      return `NULLIF(${qualified}, '')::NUMERIC`
    }

    return `NULLIF(${qualified}, '')`
  })
}

async function ensureStageTable(pgClient, stageTable, columns) {
  const columnsSql = columns
    .map(column => `${quoteIdentifier(column)} TEXT`)
    .join(', ')

  await pgClient.query(`DROP TABLE IF EXISTS ${quoteIdentifier(stageTable)}`)
  await pgClient.query(`CREATE UNLOGGED TABLE ${quoteIdentifier(stageTable)} (${columnsSql})`)
}

async function copyChunkIntoStage(pgClient, stageTable, columns, chunkFile) {
  await pgClient.query(`TRUNCATE TABLE ${quoteIdentifier(stageTable)}`)
  const copySql = `COPY ${quoteIdentifier(stageTable)} (${getCopyColumnsSql(columns)}) FROM STDIN WITH (FORMAT csv, HEADER true)`
  const copyStream = pgClient.query(copyFrom(copySql))
  await pipeline(fs.createReadStream(chunkFile), copyStream)
}

async function copyCsvDirectlyToTarget(pgClient, config, csvPath) {
  await pgClient.query(`TRUNCATE TABLE ${quoteIdentifier(config.targetTable)}`)
  const copySql = `COPY ${quoteIdentifier(config.targetTable)} (${getCopyColumnsSql(config.targetColumns)}) FROM STDIN WITH (FORMAT csv, HEADER true)`
  const copyStream = pgClient.query(copyFrom(copySql))
  await pipeline(fs.createReadStream(csvPath), copyStream)

  const countRes = await pgClient.query(
    `SELECT COUNT(*)::BIGINT AS count FROM ${quoteIdentifier(config.targetTable)}`
  )
  const loadedRowCount = scalarValue(countRes, 'count')

  return {
    sourceRowCount: loadedRowCount,
    loadedRowCount,
    newRows: loadedRowCount,
    updatedRows: 0,
    failedRows: 0,
    filePath: csvPath,
  }
}

async function upsertStageIntoTarget(pgClient, config, stageTable) {
  const sourceCountRes = await pgClient.query(
    `SELECT COUNT(*)::BIGINT AS count FROM ${quoteIdentifier(stageTable)}`
  )
  const sourceRowCount = scalarValue(sourceCountRes, 'count')

  const selectExpressions = getSelectExpressions(stageTable, config.targetColumns)
  const insertColumnsSql = getCopyColumnsSql(config.targetColumns)
  const selectSql = `
    SELECT ${selectExpressions.join(', ')}
    FROM ${quoteIdentifier(stageTable)}
    WHERE NULLIF(TRIM(${quoteIdentifier(stageTable)}.rutid), '') IS NOT NULL
  `

  const updateAssignments = config.targetColumns
    .filter(column => column !== 'rutid')
    .map(column => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)

  const insertRes = await pgClient.query(`
    INSERT INTO ${quoteIdentifier(config.targetTable)} (${insertColumnsSql})
    ${selectSql}
    ON CONFLICT (rutid) DO UPDATE
    SET ${updateAssignments.join(', ')}, updated_at = NOW()
  `)

  return {
    sourceRowCount,
    affectedRows: insertRes.rowCount ?? 0,
  }
}

async function syncMetadata(pgClient, config, metrics, csvPath) {
  try {
    await pgClient.query(
      `
        INSERT INTO data_sources (
          name,
          slug,
          source_type,
          canonical_table,
          source_table_name,
          primary_key_column,
          supports_incremental,
          record_count,
          last_loaded_at,
          last_job_status
        )
        VALUES ($1, $2, 'mysql', $3, $4, 'rutid', true, $5, NOW(), 'completed')
        ON CONFLICT (slug) DO UPDATE
        SET
          record_count = EXCLUDED.record_count,
          last_loaded_at = NOW(),
          last_job_status = 'completed',
          canonical_table = EXCLUDED.canonical_table,
          source_table_name = EXCLUDED.source_table_name,
          updated_at = NOW()
      `,
      [
        config.slug.replace(/_/g, ' '),
        config.slug,
        config.targetTable,
        config.mysqlTable,
        metrics.loadedRowCount,
      ]
    )

    await pgClient.query(
      `
        SELECT finalize_source_version(
          $1, $2, 'csv_copy_chunked', $3, $4, $5, $6, $7, 'completed', NULL,
          jsonb_build_object('csv_file', $8, 'target_table', $9, 'transport', 'pg_copy_chunked')
        )
      `,
      [
        config.slug,
        `${config.slug}-${new Date().toISOString()}`,
        metrics.sourceRowCount,
        metrics.loadedRowCount,
        metrics.newRows,
        metrics.updatedRows,
        metrics.failedRows,
        csvPath,
        config.targetTable,
      ]
    )
  } catch (error) {
    console.warn(`[metadata] No se pudo registrar metadata para ${config.slug}: ${error.message}`)
  }
}

async function refreshStats(pgClient) {
  for (const sql of ['SELECT refresh_all_stats()', 'SELECT refresh_dashboard_stats()']) {
    try {
      await pgClient.query(sql)
      return
    } catch {
      // try next
    }
  }
}

async function appendChunkRow(writer, line) {
  if (!writer.write(`${line}\n`)) {
    await new Promise(resolve => writer.once('drain', resolve))
  }
}

async function loadCsvInChunks(pgClient, config, csvPath, chunkRows, restart, skipRows) {
  const progress = restart ? null : readProgress(config.slug)
  const processedRowsStart = Math.max(progress?.processedRows ?? 0, skipRows)
  const stageTable = buildStageTableName(config.slug)
  const chunkDir = path.join(DEFAULT_PROGRESS_DIR, 'chunks')
  const chunkFile = path.join(chunkDir, `${config.slug}.chunk.csv`)

  fs.mkdirSync(chunkDir, { recursive: true })
  await ensureStageTable(pgClient, stageTable, config.targetColumns)

  const input = fs.createReadStream(csvPath)
  const rl = readline.createInterface({ input, crlfDelay: Infinity })

  let processedRows = 0
  let chunkRowsWritten = 0
  let totalLoadedRows = processedRowsStart
  let totalSourceRows = processedRowsStart
  let currentWriter = null
  let headerSeen = false
  let chunkNumber = Math.floor(processedRowsStart / chunkRows)

  writeProgress(config.slug, {
    slug: config.slug,
    csvPath,
    chunkRows,
    processedRows: processedRowsStart,
    status: 'starting',
    updatedAt: new Date().toISOString(),
  })

  const beginChunk = () => {
    currentWriter = fs.createWriteStream(chunkFile, { encoding: 'utf8' })
    currentWriter.write(`${config.targetColumns.join(',')}\n`)
    chunkRowsWritten = 0
    chunkNumber += 1
    writeProgress(config.slug, {
      slug: config.slug,
      csvPath,
      chunkRows,
      processedRows,
      chunkNumber,
      chunkRowsWritten,
      status: 'building_chunk',
      updatedAt: new Date().toISOString(),
    })
  }

  const finalizeChunk = async () => {
    if (!currentWriter || chunkRowsWritten === 0) return

    currentWriter.end()
    await new Promise(resolve => currentWriter.once('finish', resolve))

    logWithTs(
      `[${config.slug}] chunk ${chunkNumber}: COPY+UPSERT ${chunkRowsWritten} filas (procesadas=${processedRows})`
    )

    writeProgress(config.slug, {
      slug: config.slug,
      csvPath,
      chunkRows,
      processedRows,
      chunkNumber,
      chunkRowsWritten,
      status: 'loading_chunk',
      updatedAt: new Date().toISOString(),
    })

    const metrics = await copyChunkIntoStage(pgClient, stageTable, config.targetColumns, chunkFile)
      .then(() => upsertStageIntoTarget(pgClient, config, stageTable))

    totalLoadedRows += metrics.sourceRowCount
    totalSourceRows += metrics.sourceRowCount

    writeProgress(config.slug, {
      slug: config.slug,
      csvPath,
      chunkRows,
      processedRows,
      chunkNumber,
      loadedRows: totalLoadedRows,
      sourceRows: totalSourceRows,
      status: 'chunk_completed',
      updatedAt: new Date().toISOString(),
    })

    currentWriter = null
    chunkRowsWritten = 0
  }

  try {
    for await (const line of rl) {
      if (!headerSeen) {
        headerSeen = true
        continue
      }

      processedRows += 1

      if (processedRows <= processedRowsStart) {
        continue
      }

      if (!currentWriter) {
        beginChunk()
      }

      await appendChunkRow(currentWriter, line)
      chunkRowsWritten += 1

      if (chunkRowsWritten >= chunkRows) {
        await finalizeChunk()
      }
    }

    await finalizeChunk()

    writeProgress(config.slug, {
      slug: config.slug,
      csvPath,
      chunkRows,
      processedRows,
      chunkNumber,
      loadedRows: totalLoadedRows,
      sourceRows: totalSourceRows,
      status: 'completed',
      updatedAt: new Date().toISOString(),
    })

    clearProgress(config.slug)
    fs.rmSync(chunkFile, { force: true })
    await pgClient.query(`DROP TABLE IF EXISTS ${quoteIdentifier(stageTable)}`)

    return {
      sourceRowCount: totalSourceRows,
      loadedRowCount: totalLoadedRows,
      newRows: 0,
      updatedRows: 0,
      failedRows: 0,
      filePath: csvPath,
    }
  } catch (error) {
    writeProgress(config.slug, {
      slug: config.slug,
      csvPath,
      chunkRows,
      processedRows,
      chunkNumber,
      chunkRowsWritten,
      loadedRows: totalLoadedRows,
      sourceRows: totalSourceRows,
      status: 'failed',
      error: error.message,
      updatedAt: new Date().toISOString(),
    })
    console.error(
      `[${config.slug}] progreso guardado en ${getProgressPath(config.slug)} con processedRows=${processedRows}: ${error.message}`
    )
    throw error
  } finally {
    if (currentWriter) {
      currentWriter.destroy()
    }
    rl.close()
    input.destroy()
    await pgClient.query(`DROP TABLE IF EXISTS ${quoteIdentifier(stageTable)}`).catch(() => {})
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const config = SOURCE_TABLES.find(table => table.slug === args.table)

  if (!config) {
    throw new Error(`Tabla no soportada: ${args.table}`)
  }

  const csvPath = args.file || path.join(DEFAULT_EXPORT_DIR, `${config.slug}.csv`)
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV no encontrado: ${csvPath}`)
  }

  if (!process.env.DATABASE_URL && !process.env.SUPABASE_DB_URL) {
    throw new Error('Falta DATABASE_URL o SUPABASE_DB_URL.')
  }

  const pgClient = new Client({
    connectionString: process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  })

  await pgClient.connect()
  await pgClient.query('SET statement_timeout = 0')
  await pgClient.query('SET lock_timeout = 0')

  try {
    let metrics
    if (args.mode === 'replace-direct') {
      logWithTs(`[${config.slug}] Reemplazando tabla completa via TRUNCATE + COPY desde ${csvPath}...`)
      metrics = await copyCsvDirectlyToTarget(pgClient, config, csvPath)
    } else {
      logWithTs(
        `[${config.slug}] Cargando CSV ${csvPath} a Postgres por chunks de ${args.chunkRows} filas...`
      )
      if (args.skipRows > 0) {
        logWithTs(`[${config.slug}] Retomando desde skipRows=${args.skipRows}`)
      }
      metrics = await loadCsvInChunks(
        pgClient,
        config,
        csvPath,
        args.chunkRows,
        args.restart,
        args.skipRows
      )
    }
    logWithTs(
      `[${config.slug}] OK source=${metrics.sourceRowCount} loaded=${metrics.loadedRowCount}`
    )
    await syncMetadata(pgClient, config, metrics, csvPath)
    await refreshStats(pgClient)
    logWithTs(`[${config.slug}] Carga finalizada.`)
  } finally {
    await pgClient.end()
  }
}

main().catch(error => {
  console.error(`\nFallo en load-csv-to-postgres: ${error.message}`)
  process.exitCode = 1
})
