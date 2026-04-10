#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import { Client } from 'pg'
import { from as copyFrom } from 'pg-copy-streams'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DEFAULT_INPUT_DIR = path.resolve(__dirname, '../../tmp/master-sync/padron2024')

const TABLES = [
  {
    slug: 'padron_personas_raw',
    file: 'padron_personas_raw.csv',
    targetTable: 'padron_personas_raw',
    targetColumns: [
      'rutid',
      'dv',
      'nombre',
      'sexo',
      'direccion',
      'circunscripcion',
      'comuna',
      'region',
      'source_file',
      'source_dataset',
    ],
    mode: 'overwrite_raw',
  },
  {
    slug: 'personas_master',
    file: 'master_personas.csv',
    targetTable: 'personas_master',
    targetColumns: [
      'rutid',
      'nombres',
      'paterno',
      'materno',
      'comuna_part',
      'region_part',
      'domicilio_comuna',
      'domicilio_region',
    ],
    sourceFiles: {
      master: 'master_personas.csv',
      pernat: 'pernat_resumen.csv',
      domicilio: 'domicilio_resumen.csv',
    },
    mode: 'fill_missing_personas_master',
  },
]

function parseArgs(argv) {
  const args = {
    inputDir: DEFAULT_INPUT_DIR,
    chunkRows: Number(process.env.CSV_COPY_CHUNK_ROWS ?? 50000),
    fromTable: '',
    skipRows: 0,
    metadataOnly: false,
  }

  for (const rawArg of argv) {
    if (rawArg.startsWith('--input-dir=')) {
      args.inputDir = path.resolve(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--chunk-rows=')) {
      args.chunkRows = Number(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--from-table=')) {
      args.fromTable = rawArg.split('=')[1]
    } else if (rawArg.startsWith('--skip-rows=')) {
      args.skipRows = Number(rawArg.split('=')[1])
    } else if (rawArg === '--metadata-only') {
      args.metadataOnly = true
    }
  }

  if (!Number.isFinite(args.chunkRows) || args.chunkRows < 1000) {
    throw new Error(`chunk-rows invalido: ${args.chunkRows}`)
  }

  if (!Number.isFinite(args.skipRows) || args.skipRows < 0) {
    throw new Error(`skip-rows invalido: ${args.skipRows}`)
  }

  return args
}

const DATASET_CATALOG = [
  {
    slug: 'padron_2024',
    name: 'Padron 2024',
    description: 'Padron 2024 importado desde TXT y consolidado contra personas naturales.',
    sourceType: 'csv',
    canonicalTable: 'personas_master',
    sourceTableName: 'padron_personas_raw',
    recordCountTable: 'padron_personas_raw',
    supportsIncremental: false,
  },
  {
    slug: 'master_personas',
    name: 'Master personas',
    description: 'Base maestra consolidada de RUTs unicos.',
    sourceType: 'mysql',
    canonicalTable: 'personas_master',
    sourceTableName: 'personas_master',
    recordCountTable: 'personas_master',
    supportsIncremental: true,
  },
]

function quoteIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`
}

function buildStageTableName(slug) {
  return `import_${slug.replace(/[^a-z0-9_]/g, '_')}_stage`
}

function getCopyColumnsSql(columns) {
  return columns.map(column => quoteIdentifier(column)).join(', ')
}

function textExpression(tableName, column) {
  return `NULLIF(TRIM(${quoteIdentifier(tableName)}.${quoteIdentifier(column)}), '')`
}

function buildPersonasMasterChunk(pgClient, inputDir) {
  const outPath = path.join(inputDir, '.chunks', 'personas_master.chunk.csv')
  return {
    outPath,
    async writeChunk(records) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      const writer = fs.createWriteStream(outPath, { encoding: 'utf8' })
      writer.write('rutid,nombres,paterno,materno,comuna_part,region_part,domicilio_comuna,domicilio_region\n')

      for (const record of records.values()) {
        const row = [
          record.rutid ?? '',
          record.nombres ?? '',
          record.paterno ?? '',
          record.materno ?? '',
          record.comuna_part ?? '',
          record.region_part ?? '',
          record.domicilio_comuna ?? '',
          record.domicilio_region ?? '',
        ]
        const line = `${row.map(value => {
          const str = String(value ?? '')
          return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
        }).join(',')}\n`

        if (!writer.write(line)) {
          await new Promise(resolve => writer.once('drain', resolve))
        }
      }

      writer.end()
      await new Promise(resolve => writer.once('finish', resolve))
      return outPath
    },
    async cleanup() {
      fs.rmSync(outPath, { force: true })
    },
  }
}

function logWithTs(message) {
  console.log(`[${new Date().toISOString()}] ${message}`)
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

  if (connectionString) {
    return {
      connectionString: sanitizeConnectionString(connectionString),
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    }
  }

  const host =
    process.env.SUPABASE_DB_HOST ??
    process.env.POSTGRES_HOST ??
    process.env.PGHOST ??
    null

  const user =
    process.env.SUPABASE_DB_USER ??
    process.env.POSTGRES_USER ??
    process.env.PGUSER ??
    null

  const password =
    process.env.SUPABASE_DB_PASSWORD ??
    process.env.POSTGRES_PASSWORD ??
    process.env.PGPASSWORD ??
    null

  if (!host || !user || !password) {
    throw new Error(
      'Faltan credenciales Postgres. Usa POSTGRES_URL_NON_POOLING/POSTGRES_URL o define host/user/password.'
    )
  }

  return {
    host,
    port: parseInt(
      process.env.SUPABASE_DB_PORT ??
      process.env.POSTGRES_PORT ??
      process.env.PGPORT ??
      '5432',
      10
    ),
    database:
      process.env.SUPABASE_DB_NAME ??
      process.env.POSTGRES_DATABASE ??
      process.env.PGDATABASE ??
      'postgres',
    user,
    password,
    ssl: process.env.SUPABASE_DB_SSL !== 'false'
      ? { rejectUnauthorized: false }
      : false,
  }
}

async function ensurePadronRawTable(pgClient) {
  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS padron_personas_raw (
      rutid VARCHAR(10) PRIMARY KEY,
      dv VARCHAR(1),
      nombre VARCHAR(255),
      sexo VARCHAR(30),
      direccion TEXT,
      circunscripcion VARCHAR(150),
      comuna VARCHAR(100),
      region VARCHAR(100),
      source_file VARCHAR(255),
      source_dataset VARCHAR(100),
      loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pgClient.query(`
    CREATE INDEX IF NOT EXISTS idx_padron_personas_raw_region
      ON padron_personas_raw (region)
  `)

  await pgClient.query(`
    CREATE INDEX IF NOT EXISTS idx_padron_personas_raw_comuna
      ON padron_personas_raw (comuna)
  `)
}

async function ensureStageTable(pgClient, stageTable, columns) {
  const columnsSql = columns
    .map(column => `${quoteIdentifier(column)} TEXT`)
    .join(', ')

  await pgClient.query(
    `CREATE UNLOGGED TABLE IF NOT EXISTS ${quoteIdentifier(stageTable)} (${columnsSql})`
  )
}

async function copyChunkIntoStage(pgClient, stageTable, columns, chunkFile) {
  await pgClient.query(`TRUNCATE TABLE ${quoteIdentifier(stageTable)}`)
  const copySql = `COPY ${quoteIdentifier(stageTable)} (${getCopyColumnsSql(columns)}) FROM STDIN WITH (FORMAT csv, HEADER true)`
  const copyStream = pgClient.query(copyFrom(copySql))
  await pipeline(fs.createReadStream(chunkFile), copyStream)
}

function buildMergeSql(config, stageTable) {
  if (config.mode === 'insert_ignore') {
    return `
      WITH source_rows AS (
        SELECT DISTINCT ON (rutid)
          ${textExpression(stageTable, 'rutid')} AS rutid
        FROM ${quoteIdentifier(stageTable)}
        WHERE ${textExpression(stageTable, 'rutid')} IS NOT NULL
        ORDER BY rutid
      )
      INSERT INTO ${quoteIdentifier(config.targetTable)} (${getCopyColumnsSql(config.targetColumns)})
      SELECT rutid
      FROM source_rows
      ON CONFLICT (rutid) DO NOTHING
    `
  }

  const nonKeyColumns = config.targetColumns.filter(column => column !== 'rutid')
  const insertColumnsSql = getCopyColumnsSql(config.targetColumns)
  const sourceSelectSql = config.targetColumns
    .map(column => `${textExpression(stageTable, column)} AS ${quoteIdentifier(column)}`)
    .join(', ')
  const incomingHasDataSql = nonKeyColumns
    .map(column => `${textExpression(stageTable, column)} IS NOT NULL`)
    .join(' OR ')
  const richnessSql = nonKeyColumns.length > 0
    ? nonKeyColumns
        .map(column => `CASE WHEN ${textExpression(stageTable, column)} IS NOT NULL THEN 1 ELSE 0 END`)
        .join(' + ')
    : '0'

  if (config.mode === 'overwrite_raw') {
    const updates = nonKeyColumns
      .map(column => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)
      .concat(['loaded_at = NOW()', 'updated_at = NOW()'])
      .join(', ')

    return `
      WITH source_rows AS (
        SELECT DISTINCT ON (rutid)
          ${sourceSelectSql}
        FROM ${quoteIdentifier(stageTable)}
        WHERE ${textExpression(stageTable, 'rutid')} IS NOT NULL
        ORDER BY rutid, (${richnessSql}) DESC
      )
      INSERT INTO ${quoteIdentifier(config.targetTable)} (${insertColumnsSql})
      SELECT ${config.targetColumns.map(column => quoteIdentifier(column)).join(', ')}
      FROM source_rows
      ON CONFLICT (rutid) DO UPDATE
      SET ${updates}
    `
  }

  if (config.mode === 'fill_missing_personas_master') {
    const insertColumnsSql = getCopyColumnsSql([...config.targetColumns, 'loaded_at'])
    const sourceSelectSql = config.targetColumns
      .map(column => `${textExpression(stageTable, column)} AS ${quoteIdentifier(column)}`)
      .join(', ')
    const nonKeyColumns = config.targetColumns.filter(column => column !== 'rutid')
    const incomingHasDataSql = nonKeyColumns
      .map(column => `${textExpression(stageTable, column)} IS NOT NULL`)
      .join(' OR ')
    const richnessSql = nonKeyColumns
      .map(column => `CASE WHEN ${textExpression(stageTable, column)} IS NOT NULL THEN 1 ELSE 0 END`)
      .join(' + ')
    const updateAssignments = nonKeyColumns.map(column => (
      `${quoteIdentifier(column)} = COALESCE(` +
      `NULLIF(${quoteIdentifier(config.targetTable)}.${quoteIdentifier(column)}, ''), ` +
      `NULLIF(EXCLUDED.${quoteIdentifier(column)}, ''), ` +
      `${quoteIdentifier(config.targetTable)}.${quoteIdentifier(column)})`
    ))

    const missingConditions = nonKeyColumns.map(column => (
      `NULLIF(${quoteIdentifier(config.targetTable)}.${quoteIdentifier(column)}, '') IS NULL ` +
      `AND NULLIF(EXCLUDED.${quoteIdentifier(column)}, '') IS NOT NULL`
    ))

    return `
      WITH source_rows AS (
        SELECT DISTINCT ON (rutid)
          ${sourceSelectSql}
        FROM ${quoteIdentifier(stageTable)}
        WHERE ${textExpression(stageTable, 'rutid')} IS NOT NULL
          AND (${incomingHasDataSql})
        ORDER BY rutid, (${richnessSql}) DESC
      )
      INSERT INTO ${quoteIdentifier(config.targetTable)} (${insertColumnsSql})
      SELECT
        ${config.targetColumns.map(column => quoteIdentifier(column)).join(', ')},
        NOW()
      FROM source_rows
      ON CONFLICT (rutid) DO UPDATE
      SET ${updateAssignments.join(', ')}, loaded_at = NOW()
      WHERE ${missingConditions.join(' OR ')}
    `
  }

  const updateAssignments = nonKeyColumns.map(column => (
    `${quoteIdentifier(column)} = COALESCE(` +
    `NULLIF(${quoteIdentifier(config.targetTable)}.${quoteIdentifier(column)}, ''), ` +
    `NULLIF(EXCLUDED.${quoteIdentifier(column)}, ''), ` +
    `${quoteIdentifier(config.targetTable)}.${quoteIdentifier(column)})`
  ))

  const missingConditions = nonKeyColumns.map(column => (
    `NULLIF(${quoteIdentifier(config.targetTable)}.${quoteIdentifier(column)}, '') IS NULL ` +
    `AND NULLIF(EXCLUDED.${quoteIdentifier(column)}, '') IS NOT NULL`
  ))

  return `
    WITH source_rows AS (
      SELECT DISTINCT ON (rutid)
        ${sourceSelectSql}
      FROM ${quoteIdentifier(stageTable)}
      WHERE ${textExpression(stageTable, 'rutid')} IS NOT NULL
        AND (${incomingHasDataSql})
      ORDER BY rutid, (${richnessSql}) DESC
    )
    INSERT INTO ${quoteIdentifier(config.targetTable)} (${insertColumnsSql})
    SELECT ${config.targetColumns.map(column => quoteIdentifier(column)).join(', ')}
    FROM source_rows
    ON CONFLICT (rutid) DO UPDATE
    SET ${updateAssignments.join(', ')}, updated_at = NOW()
    WHERE ${missingConditions.join(' OR ')}
  `
}

async function mergeStageIntoTarget(pgClient, config, stageTable) {
  const sourceCountRes = await pgClient.query(
    `SELECT COUNT(*)::BIGINT AS count FROM ${quoteIdentifier(stageTable)}`
  )
  const sourceRowCount = Number(sourceCountRes.rows[0]?.count ?? 0)

  if (sourceRowCount === 0) {
    return { sourceRowCount: 0, affectedRows: 0 }
  }

  const mergeRes = await pgClient.query(buildMergeSql(config, stageTable))
  return {
    sourceRowCount,
    affectedRows: mergeRes.rowCount ?? 0,
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

async function syncDatasetCatalog(pgClient) {
  await pgClient.query(`
    DELETE FROM data_sources
    WHERE slug = 'personas_master'
  `)

  for (const dataset of DATASET_CATALOG) {
    const countRes = await pgClient.query(
      `SELECT COUNT(*)::BIGINT AS count FROM ${quoteIdentifier(dataset.recordCountTable)}`
    )
    const recordCount = Number(countRes.rows[0]?.count ?? 0)

    await pgClient.query(
      `
        INSERT INTO data_sources (
          name,
          slug,
          description,
          source_type,
          canonical_table,
          source_table_name,
          primary_key_column,
          supports_incremental,
          record_count,
          is_active,
          last_loaded_at,
          last_job_status
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'rutid', $7, $8, true, NOW(), 'completed')
        ON CONFLICT (slug) DO UPDATE
        SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          source_type = EXCLUDED.source_type,
          canonical_table = EXCLUDED.canonical_table,
          source_table_name = EXCLUDED.source_table_name,
          primary_key_column = EXCLUDED.primary_key_column,
          supports_incremental = EXCLUDED.supports_incremental,
          record_count = EXCLUDED.record_count,
          is_active = true,
          last_loaded_at = NOW(),
          last_job_status = 'completed',
          updated_at = NOW()
      `,
      [
        dataset.name,
        dataset.slug,
        dataset.description,
        dataset.sourceType,
        dataset.canonicalTable,
        dataset.sourceTableName,
        dataset.supportsIncremental,
        recordCount,
      ]
    )

    logWithTs(`[catalog] ${dataset.slug} actualizado con record_count=${recordCount}`)
  }
}

async function loadCsvInChunks(pgClient, config, csvPath, chunkRows, inputDir, skipRows = 0) {
  const stageTable = buildStageTableName(config.slug)
  const chunkDir = path.join(inputDir, '.chunks')
  const chunkFile = path.join(chunkDir, `${config.slug}.chunk.csv`)

  fs.mkdirSync(chunkDir, { recursive: true })

  const input = fs.createReadStream(csvPath)
  const rl = readline.createInterface({ input, crlfDelay: Infinity })

  let processedRows = 0
  let chunkRowsWritten = 0
  let chunkNumber = 0
  let currentWriter = null

  const beginChunk = () => {
    currentWriter = fs.createWriteStream(chunkFile, { encoding: 'utf8' })
    currentWriter.write(`${config.targetColumns.join(',')}\n`)
    chunkRowsWritten = 0
    chunkNumber += 1
  }

  const finalizeChunk = async () => {
    if (!currentWriter || chunkRowsWritten === 0) return

    currentWriter.end()
    await new Promise(resolve => currentWriter.once('finish', resolve))

    await ensureStageTable(pgClient, stageTable, config.targetColumns)
    const metrics = await copyChunkIntoStage(pgClient, stageTable, config.targetColumns, chunkFile)
      .then(() => mergeStageIntoTarget(pgClient, config, stageTable))

    logWithTs(
      `[${config.slug}] chunk ${chunkNumber}: source=${metrics.sourceRowCount} affected=${metrics.affectedRows} processed=${processedRows}`
    )

    currentWriter = null
    chunkRowsWritten = 0
  }

  try {
    let headerSeen = false

    for await (const line of rl) {
      if (!headerSeen) {
        headerSeen = true
        continue
      }

      processedRows += 1

      if (processedRows <= skipRows) {
        continue
      }

      if (!currentWriter) {
        beginChunk()
      }

      if (!currentWriter.write(`${line}\n`)) {
        await new Promise(resolve => currentWriter.once('drain', resolve))
      }

      chunkRowsWritten += 1

      if (chunkRowsWritten >= chunkRows) {
        await finalizeChunk()
      }
    }

    await finalizeChunk()
  } finally {
    if (currentWriter) {
      currentWriter.destroy()
    }
    rl.close()
    input.destroy()
    fs.rmSync(chunkFile, { force: true })
  }
}

async function loadPersonasMasterFromPreparedCsvs(pgClient, config, inputDir, chunkRows, skipRows = 0) {
  const files = {
    master: path.join(inputDir, config.sourceFiles.master),
    pernat: path.join(inputDir, config.sourceFiles.pernat),
    domicilio: path.join(inputDir, config.sourceFiles.domicilio),
  }

  for (const filePath of Object.values(files)) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`CSV preparado no encontrado: ${filePath}`)
    }
  }

  const stageTable = buildStageTableName(config.slug)
  const chunkWriter = buildPersonasMasterChunk(pgClient, inputDir)
  const masterInput = fs.createReadStream(files.master)
  const masterRl = readline.createInterface({ input: masterInput, crlfDelay: Infinity })
  const pernatInput = fs.createReadStream(files.pernat)
  const pernatRl = readline.createInterface({ input: pernatInput, crlfDelay: Infinity })
  const domicilioInput = fs.createReadStream(files.domicilio)
  const domicilioRl = readline.createInterface({ input: domicilioInput, crlfDelay: Infinity })
  const pernatIterator = pernatRl[Symbol.asyncIterator]()
  const domicilioIterator = domicilioRl[Symbol.asyncIterator]()

  let processedRows = 0
  let chunkNumber = 0
  let masterHeaderSeen = false
  let pernatHeaderSeen = false
  let domicilioHeaderSeen = false
  let currentRows = new Map()

  const finalizeChunk = async () => {
    if (currentRows.size === 0) return

    chunkNumber += 1
    const chunkFile = await chunkWriter.writeChunk(currentRows)
    await ensureStageTable(pgClient, stageTable, config.targetColumns)
    const metrics = await copyChunkIntoStage(pgClient, stageTable, config.targetColumns, chunkFile)
      .then(() => mergeStageIntoTarget(pgClient, config, stageTable))

    logWithTs(
      `[${config.slug}] chunk ${chunkNumber}: source=${metrics.sourceRowCount} affected=${metrics.affectedRows} processed=${processedRows}`
    )

    currentRows = new Map()
  }

  const parseCsvLine = line => {
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

  try {
    const nextPreparedLine = async (iterator, label, headerState) => {
      for (;;) {
        const next = await iterator.next()
        if (next.done) {
          throw new Error(`${label} terminó antes que master_personas.csv`)
        }
        if (!headerState.seen) {
          headerState.seen = true
          continue
        }
        return next.value
      }
    }

    for await (const masterLine of masterRl) {
      if (!masterHeaderSeen) {
        masterHeaderSeen = true
        continue
      }

      processedRows += 1
      const pernatLine = await nextPreparedLine(pernatIterator, 'pernat_resumen.csv', {
        get seen() { return pernatHeaderSeen },
        set seen(value) { pernatHeaderSeen = value },
      })
      const domicilioLine = await nextPreparedLine(domicilioIterator, 'domicilio_resumen.csv', {
        get seen() { return domicilioHeaderSeen },
        set seen(value) { domicilioHeaderSeen = value },
      })

      if (processedRows <= skipRows) {
        continue
      }

      const [rutid] = parseCsvLine(masterLine)
      const [, nombres, paterno, materno, comuna_part, region_part] = parseCsvLine(pernatLine)
      const [, domicilio_comuna, domicilio_region] = parseCsvLine(domicilioLine)

      currentRows.set(rutid, {
        rutid,
        nombres,
        paterno,
        materno,
        comuna_part,
        region_part,
        domicilio_comuna,
        domicilio_region,
      })

      if (currentRows.size >= chunkRows) {
        await finalizeChunk()
      }
    }

    await finalizeChunk()
  } finally {
    masterRl.close()
    pernatRl.close()
    domicilioRl.close()
    masterInput.destroy()
    pernatInput.destroy()
    domicilioInput.destroy()
    await chunkWriter.cleanup()
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!args.metadataOnly) {
    const missingFiles = TABLES
      .map(config => path.join(args.inputDir, config.file))
      .filter(filePath => !fs.existsSync(filePath))

    if (missingFiles.length > 0) {
      throw new Error(`Faltan CSV preparados: ${missingFiles.join(', ')}`)
    }
  }

  const pgConfig = resolvePgConfig()
  const pgClient = new Client(pgConfig)

  await pgClient.connect()
  await pgClient.query('SET statement_timeout = 0')
  await pgClient.query('SET lock_timeout = 0')

  try {
    await ensurePadronRawTable(pgClient)

    if (!args.metadataOnly) {
      const startIndex = args.fromTable
        ? TABLES.findIndex(config => config.slug === args.fromTable)
        : 0

      if (startIndex < 0) {
        throw new Error(`Tabla no soportada en --from-table: ${args.fromTable}`)
      }

      const selectedTables = TABLES.slice(startIndex)

      for (const [index, config] of selectedTables.entries()) {
        const csvPath = config.file ? path.join(args.inputDir, config.file) : null
        logWithTs(`[${config.slug}] cargando ${csvPath ?? 'prepared CSV set'}...`)
        if (index === 0 && args.skipRows > 0) {
          logWithTs(`[${config.slug}] retomando desde skipRows=${args.skipRows}...`)
        }
        if (config.mode === 'fill_missing_personas_master') {
          await loadPersonasMasterFromPreparedCsvs(
            pgClient,
            config,
            args.inputDir,
            args.chunkRows,
            index === 0 ? args.skipRows : 0
          )
        } else {
          await loadCsvInChunks(
            pgClient,
            config,
            csvPath,
            args.chunkRows,
            args.inputDir,
            index === 0 ? args.skipRows : 0
          )
        }
        logWithTs(`[${config.slug}] carga lista.`)
      }
    }

    await syncDatasetCatalog(pgClient)
    await refreshStats(pgClient)
    logWithTs('[padron2024:load] catalogo y stats refrescados.')
  } finally {
    await pgClient.end()
  }
}

main().catch(error => {
  console.error(`\nFallo en load-padron2024-to-postgres: ${error.message}`)
  process.exitCode = 1
})
