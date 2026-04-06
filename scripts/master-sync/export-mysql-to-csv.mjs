import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

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
    out: '',
  }

  for (const rawArg of argv) {
    if (rawArg.startsWith('--table=')) {
      args.table = rawArg.split('=')[1]
    } else if (rawArg.startsWith('--out=')) {
      args.out = path.resolve(rawArg.split('=')[1])
    }
  }

  if (!args.table) {
    throw new Error('Falta --table=<slug>.')
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

function csvEscape(value) {
  const str = String(value ?? '')
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function buildMysqlArgs(sql) {
  const args = [
    '--local-infile=1',
    '--batch',
    '--raw',
    '--quick',
    '--skip-column-names',
    '-h',
    process.env.MYSQL_HOST,
    '-P',
    String(process.env.MYSQL_PORT ?? 3306),
    '-u',
    process.env.MYSQL_USER,
  ]

  if (process.env.MYSQL_PASSWORD) {
    args.push(`--password=${process.env.MYSQL_PASSWORD}`)
  }

  args.push(process.env.MYSQL_DATABASE)
  args.push('-e', sql)

  return args
}

function runMysql(sql) {
  const child = spawn('mysql', buildMysqlArgs(sql), {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return child
}

async function getMysqlColumns(tableName) {
  const child = runMysql(`SHOW COLUMNS FROM \`${tableName}\``)
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  const stderr = []
  child.stderr.on('data', chunk => stderr.push(String(chunk)))

  const columns = []
  for await (const line of rl) {
    if (!line.trim()) continue
    columns.push(line.split('\t')[0])
  }

  const [code] = await once(child, 'close')
  if (code !== 0) {
    throw new Error(`mysql SHOW COLUMNS fallo (${code}): ${stderr.join('').trim()}`)
  }

  return columns
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

async function exportTableFromMySqlCli(config, outputPath) {
  const mysqlColumns = await getMysqlColumns(config.mysqlTable)
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

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const writer = fs.createWriteStream(outputPath, { encoding: 'utf8' })
  writer.write(`${config.targetColumns.join(',')}\n`)

  const child = runMysql(selectSql)
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  const stderr = []
  child.stderr.on('data', chunk => stderr.push(String(chunk)))

  let rowCount = 0

  for await (const line of rl) {
    if (!line) continue

    const fields = line.split('\t')
    const csvRow = config.targetColumns
      .map((column, index) => csvEscape(normalizeCell(column, fields[index] ?? '')))
      .join(',')

    if (!writer.write(`${csvRow}\n`)) {
      await once(writer, 'drain')
    }

    rowCount += 1

    if (rowCount % 100000 === 0) {
      console.log(`[${config.slug}] export ${rowCount} filas...`)
    }
  }

  writer.end()
  await once(writer, 'finish')

  const [code] = await once(child, 'close')
  if (code !== 0) {
    throw new Error(`mysql export fallo (${code}): ${stderr.join('').trim()}`)
  }

  return { outputPath, rowCount }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const config = SOURCE_TABLES.find(table => table.slug === args.table)

  if (!config) {
    throw new Error(`Tabla no soportada: ${args.table}`)
  }

  if (!process.env.MYSQL_HOST || !process.env.MYSQL_USER || !process.env.MYSQL_DATABASE) {
    throw new Error('Faltan variables MYSQL_HOST, MYSQL_USER o MYSQL_DATABASE.')
  }

  const outputPath = args.out || path.join(DEFAULT_EXPORT_DIR, `${config.slug}.csv`)

  console.log(`[${config.slug}] Exportando a ${outputPath} usando mysql CLI...`)
  const result = await exportTableFromMySqlCli(config, outputPath)
  console.log(`[${config.slug}] CSV listo: ${result.outputPath} (${result.rowCount} filas)`)
}

main().catch(error => {
  console.error(`\nFallo en export-mysql-to-csv: ${error.message}`)
  process.exitCode = 1
})
