import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import mysql from 'mysql2'
import { Client } from 'pg'
import { from as copyFrom } from 'pg-copy-streams'
import { createClient } from '@supabase/supabase-js'

import {
  SOURCE_TABLES,
  INTEGER_COLUMNS,
  NUMERIC_COLUMNS,
  FULL_REPLACE_ORDER,
} from './config.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DEFAULT_EXPORT_DIR = path.resolve(__dirname, '../../tmp/master-sync')

function parseArgs(argv) {
  const args = {
    mode: 'upsert',
    tables: SOURCE_TABLES.map(table => table.slug),
    exportDir: DEFAULT_EXPORT_DIR,
  }

  for (const rawArg of argv) {
    if (rawArg.startsWith('--mode=')) {
      args.mode = rawArg.split('=')[1]
    } else if (rawArg.startsWith('--tables=')) {
      args.tables = rawArg
        .split('=')[1]
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
    } else if (rawArg.startsWith('--export-dir=')) {
      args.exportDir = path.resolve(rawArg.split('=')[1])
    }
  }

  if (!['upsert', 'replace'].includes(args.mode)) {
    throw new Error(`Modo no soportado: ${args.mode}`)
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
  if (value === null || value === undefined || value === '') return ''
  const normalized = String(value).replace(/[^\d-]/g, '')
  return normalized ? String(Number(normalized)) : ''
}

function normalizeNumeric(value) {
  if (value === null || value === undefined || value === '') return ''
  const str = String(value).trim()
  const sanitized = str.replace(/[^0-9,.\-]/g, '')
  if (!sanitized) return ''

  if (sanitized.includes(',') && sanitized.includes('.')) {
    return sanitized.replace(/\./g, '').replace(',', '.')
  }

  if (sanitized.includes(',')) {
    return sanitized.replace(/\./g, '').replace(',', '.')
  }

  return sanitized
}

function normalizeText(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function normalizeCell(column, value) {
  if (column === 'rutid') return normalizeRut(value)
  if (INTEGER_COLUMNS.has(column)) return normalizeInteger(value)
  if (NUMERIC_COLUMNS.has(column)) return normalizeNumeric(value)
  return normalizeText(value)
}

function toSupabaseValue(column, value) {
  const normalized = normalizeCell(column, value)
  if (normalized === '') return null
  if (INTEGER_COLUMNS.has(column)) return Number(normalized)
  if (NUMERIC_COLUMNS.has(column)) return Number(normalized)
  return normalized
}

function csvEscape(value) {
  const str = String(value ?? '')
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function quoteIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`
}

function buildTempTableName(slug) {
  const suffix = Date.now().toString(36)
  return `tmp_${slug.replace(/[^a-z0-9_]/g, '_')}_${suffix}`
}

function resolveColumnMap(config, mysqlColumns) {
  const byLower = new Map(mysqlColumns.map(column => [column.toLowerCase(), column]))

  return config.targetColumns.map(targetColumn => {
    const aliases = config.aliases[targetColumn] ?? [targetColumn]
    const match = aliases
      .map(alias => byLower.get(alias.toLowerCase()))
      .find(Boolean)

    if (!match && targetColumn === 'rutid') {
      throw new Error(
        `No se encontró columna origen para ${config.slug}.rutid en ${config.mysqlTable}`
      )
    }

    return { targetColumn, sourceColumn: match ?? null }
  })
}

async function exportTableFromMySql(mysqlConnection, config, exportDir) {
  const [columnsResult] = await mysqlConnection
    .promise()
    .query(`SHOW COLUMNS FROM \`${config.mysqlTable}\``)

  const mysqlColumns = columnsResult.map(column => column.Field)
  const mappings = resolveColumnMap(config, mysqlColumns)

  const selectList = mappings.map(mapping => {
    if (!mapping.sourceColumn) {
      return `NULL AS \`${mapping.targetColumn}\``
    }

    return `\`${mapping.sourceColumn}\` AS \`${mapping.targetColumn}\``
  }).join(', ')

  const selectSql = config.targetTable === 'master_personas'
    ? `SELECT DISTINCT ${selectList} FROM \`${config.mysqlTable}\``
    : `SELECT ${selectList} FROM \`${config.mysqlTable}\``

  fs.mkdirSync(exportDir, { recursive: true })
  const outputPath = path.join(exportDir, `${config.slug}.csv`)
  const writer = fs.createWriteStream(outputPath, { encoding: 'utf8' })
  writer.write(`${config.targetColumns.join(',')}\n`)

  const queryStream = mysqlConnection.query(selectSql).stream({ highWaterMark: 500 })

  let rowCount = 0

  for await (const row of queryStream) {
    const csvRow = config.targetColumns
      .map(column => csvEscape(normalizeCell(column, row[column])))
      .join(',')

    if (!writer.write(`${csvRow}\n`)) {
      await once(writer, 'drain')
    }

    rowCount += 1
  }

  writer.end()
  await once(writer, 'finish')

  return { outputPath, rowCount }
}

async function* streamNormalizedRowsFromMySql(mysqlConnection, config) {
  const [columnsResult] = await mysqlConnection
    .promise()
    .query(`SHOW COLUMNS FROM \`${config.mysqlTable}\``)

  const mysqlColumns = columnsResult.map(column => column.Field)
  const mappings = resolveColumnMap(config, mysqlColumns)

  const selectList = mappings.map(mapping => {
    if (!mapping.sourceColumn) {
      return `NULL AS \`${mapping.targetColumn}\``
    }

    return `\`${mapping.sourceColumn}\` AS \`${mapping.targetColumn}\``
  }).join(', ')

  const selectSql = config.targetTable === 'master_personas'
    ? `SELECT DISTINCT ${selectList} FROM \`${config.mysqlTable}\``
    : `SELECT ${selectList} FROM \`${config.mysqlTable}\``

  const queryStream = mysqlConnection.query(selectSql).stream({ highWaterMark: 500 })

  for await (const row of queryStream) {
    const normalizedRow = Object.fromEntries(
      config.targetColumns.map(column => [column, toSupabaseValue(column, row[column])])
    )

    if (!normalizedRow.rutid) continue

    yield normalizedRow
  }
}

async function scalar(pgClient, sql, params = []) {
  const result = await pgClient.query(sql, params)
  return result.rows[0]?.count ? Number(result.rows[0].count) : 0
}

function getCopyColumnsSql(columns) {
  return columns.map(column => quoteIdentifier(column)).join(', ')
}

function getSelectExpressions(tempTable, columns) {
  return columns.map(column => {
    const qualified = `${quoteIdentifier(tempTable)}.${quoteIdentifier(column)}`

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

async function loadCsvIntoPostgres(pgClient, config, csvPath, sourceRowCount, mode) {
  const tempTable = buildTempTableName(config.slug)
  const columnsSql = config.targetColumns
    .map(column => `${quoteIdentifier(column)} TEXT`)
    .join(', ')

  await pgClient.query(`CREATE TEMP TABLE ${quoteIdentifier(tempTable)} (${columnsSql}) ON COMMIT DROP`)

  const copySql = `COPY ${quoteIdentifier(tempTable)} (${getCopyColumnsSql(config.targetColumns)}) FROM STDIN WITH (FORMAT csv, HEADER true)`
  const copyStream = pgClient.query(copyFrom(copySql))

  await pipeline(fs.createReadStream(csvPath), copyStream)

  const tempCount = await scalar(
    pgClient,
    `SELECT COUNT(*)::BIGINT AS count FROM ${quoteIdentifier(tempTable)}`
  )

  let newRows = 0
  let updatedRows = 0

  if (mode === 'replace') {
    newRows = tempCount
  } else if (config.targetTable === 'master_personas') {
    newRows = await scalar(
      pgClient,
      `
        SELECT COUNT(*)::BIGINT AS count
        FROM ${quoteIdentifier(tempTable)} t
        LEFT JOIN master_personas mp ON mp.rutid = NULLIF(TRIM(t.rutid), '')
        WHERE NULLIF(TRIM(t.rutid), '') IS NOT NULL
          AND mp.rutid IS NULL
      `
    )
  } else {
    newRows = await scalar(
      pgClient,
      `
        SELECT COUNT(*)::BIGINT AS count
        FROM ${quoteIdentifier(tempTable)} t
        LEFT JOIN ${quoteIdentifier(config.targetTable)} dest
          ON dest.rutid = NULLIF(TRIM(t.rutid), '')
        WHERE NULLIF(TRIM(t.rutid), '') IS NOT NULL
          AND dest.rutid IS NULL
      `
    )
    updatedRows = Math.max(tempCount - newRows, 0)
  }

  const selectExpressions = getSelectExpressions(tempTable, config.targetColumns)
  const insertColumnsSql = getCopyColumnsSql(config.targetColumns)
  const selectSql = `
    SELECT ${selectExpressions.join(', ')}
    FROM ${quoteIdentifier(tempTable)}
    WHERE NULLIF(TRIM(${quoteIdentifier(tempTable)}.rutid), '') IS NOT NULL
  `

  if (config.targetTable === 'master_personas') {
    await pgClient.query(`
      INSERT INTO master_personas (${insertColumnsSql})
      ${selectSql}
      ON CONFLICT (rutid) DO NOTHING
    `)
  } else if (mode === 'replace') {
    await pgClient.query(`
      INSERT INTO ${quoteIdentifier(config.targetTable)} (${insertColumnsSql})
      ${selectSql}
    `)
  } else {
    const updateAssignments = config.targetColumns
      .filter(column => column !== 'rutid')
      .map(column => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)

    if (config.targetColumns.includes('updated_at')) {
      updateAssignments.push(`updated_at = NOW()`)
    }

    await pgClient.query(`
      INSERT INTO ${quoteIdentifier(config.targetTable)} (${insertColumnsSql})
      ${selectSql}
      ON CONFLICT (rutid) DO UPDATE
      SET ${updateAssignments.join(', ')}
    `)
  }

  return {
    sourceRowCount,
    loadedRowCount: tempCount,
    newRows,
    updatedRows,
    failedRows: Math.max(sourceRowCount - tempCount, 0),
  }
}

async function syncMetadata(pgClient, config, metrics, mode) {
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
          $1, $2, $3, $4, $5, $6, $7, $8, 'completed', NULL,
          jsonb_build_object('mysql_table', $9, 'target_table', $10)
        )
      `,
      [
        config.slug,
        `${config.slug}-${new Date().toISOString()}`,
        mode,
        metrics.sourceRowCount,
        metrics.loadedRowCount,
        metrics.newRows,
        metrics.updatedRows,
        metrics.failedRows,
        config.mysqlTable,
        config.targetTable,
      ]
    )
  } catch (error) {
    console.warn(`[metadata] No se pudo registrar metadata para ${config.slug}: ${error.message}`)
  }
}

async function prepareReplaceMode(pgClient, configs) {
  const selectedTargets = new Set(configs.map(config => config.targetTable))
  for (const required of FULL_REPLACE_ORDER) {
    if (!selectedTargets.has(required)) {
      throw new Error(
        'El modo replace requiere cargar todas las tablas canonicas en una sola corrida.'
      )
    }
  }

  await pgClient.query(`
    TRUNCATE TABLE
      pernat_resumen,
      autos_resumen,
      empresa_resumen,
      domicilio_resumen,
      acumulado_resumen,
      master_personas
    CASCADE
  `)
}

async function refreshStats(pgClient) {
  const candidates = [
    'SELECT refresh_all_stats()',
    'SELECT refresh_dashboard_stats()',
  ]

  for (const sql of candidates) {
    try {
      await pgClient.query(sql)
      return
    } catch {
      // try next
    }
  }
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

async function syncMetadataViaApi(supabase, config, metrics, mode) {
  try {
    await supabase
      .from('data_sources')
      .upsert(
        {
          name: config.slug.replace(/_/g, ' '),
          slug: config.slug,
          source_type: 'mysql',
          canonical_table: config.targetTable,
          source_table_name: config.mysqlTable,
          primary_key_column: 'rutid',
          supports_incremental: true,
          record_count: metrics.loadedRowCount,
          last_loaded_at: new Date().toISOString(),
          last_job_status: 'completed',
        },
        { onConflict: 'slug' }
      )
      .throwOnError()

    await supabase.rpc('finalize_source_version', {
      p_source_slug: config.slug,
      p_version_label: `${config.slug}-${new Date().toISOString()}`,
      p_load_mode: mode,
      p_source_row_count: metrics.sourceRowCount,
      p_loaded_row_count: metrics.loadedRowCount,
      p_new_rows: metrics.newRows,
      p_updated_rows: metrics.updatedRows,
      p_failed_rows: metrics.failedRows,
      p_status: 'completed',
      p_notes: null,
      p_metadata: {
        mysql_table: config.mysqlTable,
        target_table: config.targetTable,
        transport: 'supabase-js',
      },
    }).throwOnError()
  } catch (error) {
    console.warn(`[metadata] No se pudo registrar metadata para ${config.slug}: ${error.message}`)
  }
}

async function loadRowsViaSupabaseApi(supabase, config, rowIterator, mode) {
  if (mode === 'replace') {
    throw new Error(
      'El modo replace requiere DATABASE_URL/SUPABASE_DB_URL. Sin password de Postgres usa ops:sync:master (upsert).'
    )
  }

  const chunkSize = 1000
  let sourceRowCount = 0
  let loadedRowCount = 0
  let batch = []

  const flush = async () => {
    if (batch.length === 0) return

    const query = config.targetTable === 'master_personas'
      ? supabase.from(config.targetTable).upsert(batch, { onConflict: 'rutid', ignoreDuplicates: true })
      : supabase.from(config.targetTable).upsert(batch, { onConflict: 'rutid' })

    const { error } = await query
    if (error) {
      throw new Error(`[${config.slug}] upsert API fallo: ${error.message}`)
    }

    loadedRowCount += batch.length
    batch = []
  }

  for await (const row of rowIterator) {
    batch.push(row)
    sourceRowCount += 1

    if (batch.length >= chunkSize) {
      await flush()
      console.log(`[${config.slug}] API upsert ${loadedRowCount} filas...`)
    }
  }

  await flush()

  return {
    sourceRowCount,
    loadedRowCount,
    newRows: loadedRowCount,
    updatedRows: 0,
    failedRows: Math.max(sourceRowCount - loadedRowCount, 0),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const selectedConfigs = SOURCE_TABLES.filter(table => args.tables.includes(table.slug))

  if (selectedConfigs.length === 0) {
    throw new Error('No hay tablas seleccionadas para sincronizar.')
  }

  const mysqlConnection = mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    charset: 'utf8mb4',
  })

  if (!process.env.MYSQL_HOST || !process.env.MYSQL_USER || !process.env.MYSQL_DATABASE) {
    throw new Error('Faltan variables MYSQL_HOST, MYSQL_USER o MYSQL_DATABASE.')
  }

  const databaseUrl = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL

  if (databaseUrl) {
    const pgClient = new Client({
      connectionString: databaseUrl,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    })

    await pgClient.connect()

    try {
      if (args.mode === 'replace') {
        await prepareReplaceMode(pgClient, selectedConfigs)
      }

      for (const config of selectedConfigs) {
        console.log(`\n[${config.slug}] Exportando desde MySQL...`)
        const exportResult = await exportTableFromMySql(mysqlConnection, config, args.exportDir)
        console.log(`[${config.slug}] CSV listo: ${exportResult.outputPath} (${exportResult.rowCount} filas)`)

        console.log(`[${config.slug}] Cargando en Postgres (${args.mode})...`)
        const metrics = await loadCsvIntoPostgres(
          pgClient,
          config,
          exportResult.outputPath,
          exportResult.rowCount,
          args.mode
        )

        console.log(
          `[${config.slug}] OK source=${metrics.sourceRowCount} loaded=${metrics.loadedRowCount} new=${metrics.newRows} updated=${metrics.updatedRows}`
        )

        await syncMetadata(pgClient, config, metrics, args.mode)
      }

      await refreshStats(pgClient)
      console.log('\nSincronizacion completada.')
    } finally {
      mysqlConnection.end()
      await pgClient.end()
    }

    return
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'Falta DATABASE_URL/SUPABASE_DB_URL y tampoco existen NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY para fallback API.'
    )
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

  try {
    for (const config of selectedConfigs) {
      console.log(`\n[${config.slug}] Leyendo desde MySQL y cargando por API...`)
      const metrics = await loadRowsViaSupabaseApi(
        supabase,
        config,
        streamNormalizedRowsFromMySql(mysqlConnection, config),
        args.mode
      )

      console.log(
        `[${config.slug}] OK source=${metrics.sourceRowCount} loaded=${metrics.loadedRowCount} new=${metrics.newRows} updated=${metrics.updatedRows}`
      )

      await syncMetadataViaApi(supabase, config, metrics, args.mode)
    }

    await refreshStatsViaApi(supabase)
    console.log('\nSincronizacion completada por API.')
  } finally {
    mysqlConnection.end()
  }
}

main().catch(error => {
  console.error(`\nFallo en sync-master-data: ${error.message}`)
  process.exitCode = 1
})
