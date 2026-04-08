#!/usr/bin/env node

import path from 'node:path'

import mysql from 'mysql2/promise'
import { Client } from 'pg'
import XLSX from 'xlsx'

const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST ?? '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT ?? '3306'),
  user: process.env.MYSQL_USER ?? 'root',
  password: process.env.MYSQL_PASSWORD ?? '',
  database: process.env.MYSQL_DATABASE ?? 'master_test',
  charset: 'utf8mb4',
}

function getPgConfig() {
  if (process.env.SUPABASE_DB_HOST) {
    return {
      host: process.env.SUPABASE_DB_HOST,
      port: parseInt(process.env.SUPABASE_DB_PORT ?? '5432'),
      database: process.env.SUPABASE_DB_NAME,
      user: process.env.SUPABASE_DB_USER,
      password: process.env.SUPABASE_DB_PASSWORD,
      ssl: process.env.SUPABASE_DB_SSL === 'true'
        ? { rejectUnauthorized: false }
        : undefined,
      statement_timeout: 0,
    }
  }

  return {
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 0,
  }
}

const PHONE_PRIORITY = {
  ejecutivo_cel: 1,
  ejecutivo_comercial: 2,
  empresa_comercial: 3,
  bbrr_cel: 4,
  bbrr_comercial: 5,
  bbrr_particular: 6,
}

function parseArgs(argv) {
  const args = {
    file: '',
    all: false,
    withBbrr: false,
    batchSize: 500,
    dryRun: false,
  }

  for (const rawArg of argv) {
    if (rawArg.startsWith('--file=')) {
      args.file = path.resolve(rawArg.split('=')[1])
    } else if (rawArg === '--all') {
      args.all = true
    } else if (rawArg === '--with-bbrr') {
      args.withBbrr = true
    } else if (rawArg.startsWith('--batch-size=')) {
      args.batchSize = Number(rawArg.split('=')[1])
    } else if (rawArg === '--dry-run') {
      args.dryRun = true
    }
  }

  if (!args.file && !args.all) {
    throw new Error('Debes indicar --file=/ruta/al/archivo.xlsx o --all')
  }

  if (args.file && args.all) {
    throw new Error('Usa solo uno de --file o --all')
  }

  if (!Number.isFinite(args.batchSize) || args.batchSize < 1) {
    throw new Error(`batch-size invalido: ${args.batchSize}`)
  }

  if (!process.env.DATABASE_URL && !process.env.SUPABASE_DB_HOST) {
    throw new Error('Falta DATABASE_URL o credenciales SUPABASE_DB_*')
  }

  return args
}

function cleanHeader(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
}

function normalizeDirectRut(value) {
  if (value === null || value === undefined) return null
  const clean = String(value).replace(/[.\-\s]/g, '').trim().toUpperCase()
  if (clean.length < 2) return null
  const body = clean.slice(0, -1).replace(/\D/g, '')
  const dv = clean.slice(-1).replace(/[^0-9K]/g, '')
  if (!body || !dv) return null
  return `${body.padStart(9, '0')}${dv}`
}

function normalizeRutWithDv(rutValue, dvValue) {
  const body = String(rutValue ?? '').replace(/\D/g, '')
  const dv = String(dvValue ?? '').trim().toUpperCase().replace(/[^0-9K]/g, '')
  if (!body || !dv) return null
  return `${body.padStart(9, '0')}${dv}`
}

function detectRutColumns(row) {
  const entries = Object.keys(row ?? {}).map(key => ({
    raw: key,
    clean: cleanHeader(key),
  }))

  const rutColumn = entries.find(entry =>
    ['rutid', 'rut', 'r_u_t'].includes(entry.clean)
  )?.raw

  const dvColumn = entries.find(entry =>
    ['dv', 'digito_verificador'].includes(entry.clean)
  )?.raw

  return { rutColumn, dvColumn }
}

function extractRutidsFromFile(filePath) {
  const workbook = XLSX.readFile(filePath)
  const worksheet = workbook.Sheets[workbook.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(worksheet, { defval: null })
  if (rows.length === 0) return []

  const { rutColumn, dvColumn } = detectRutColumns(rows[0])
  if (!rutColumn) {
    throw new Error('No se detecto columna RUT en el archivo')
  }

  const rutids = rows
    .map(row => {
      if (dvColumn) return normalizeRutWithDv(row[rutColumn], row[dvColumn])
      return normalizeDirectRut(row[rutColumn])
    })
    .filter(Boolean)

  return [...new Set(rutids)]
}

function isPresent(value) {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

function normalizeEmail(value) {
  if (!isPresent(value)) return null
  const email = String(value).trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

function normalizePhone(area, number) {
  const areaDigits = String(area ?? '').replace(/\D/g, '')
  const numberDigits = String(number ?? '').replace(/\D/g, '')
  const digits = `${areaDigits}${numberDigits}`

  if (!digits) return null
  if (digits.startsWith('56') && digits.length >= 10) return `+${digits}`
  if (areaDigits === '9' && numberDigits.length === 8) return `+56${areaDigits}${numberDigits}`
  if (!areaDigits && numberDigits.length === 9 && numberDigits.startsWith('9')) return `+56${numberDigits}`
  if (areaDigits && numberDigits.length >= 6) return `+56${areaDigits}${numberDigits}`
  if (!areaDigits && numberDigits.length === 8) return `+562${numberDigits}`
  if (!areaDigits && numberDigits.length >= 9) return numberDigits
  return null
}

function pushCandidate(bucket, value, source) {
  if (!value) return
  bucket.push({ value, source, priority: PHONE_PRIORITY[source] ?? 99 })
}

function choosePhone(candidates) {
  const seen = new Set()
  return candidates
    .filter(item => {
      if (seen.has(item.value)) return false
      seen.add(item.value)
      return true
    })
    .sort((left, right) => left.priority - right.priority)[0]?.value ?? null
}

function chooseEmail(candidates) {
  const unique = [...new Set(candidates)]
  return unique[0] ?? null
}

async function fetchMySqlRows(connection, table, columns, rutColumn, rutids) {
  const rows = []
  const chunkSize = 200

  for (let index = 0; index < rutids.length; index += chunkSize) {
    const slice = rutids.slice(index, index + chunkSize)
    const placeholders = slice.map(() => '?').join(',')
    const sql = `SELECT ${columns.join(', ')} FROM ${table} WHERE ${rutColumn} IN (${placeholders})`
    const [result] = await connection.query(sql, slice)
    rows.push(...result)
  }

  return rows
}

async function fetchGlobalTargetRutids(connection) {
  const [rows] = await connection.query(`
    SELECT DISTINCT rutid
    FROM (
      SELECT RUTID AS rutid FROM empresa_resumen
      UNION
      SELECT RUTID AS rutid FROM empresas
      UNION
      SELECT RUTID AS rutid FROM ejecutivos
    ) src
    WHERE NULLIF(TRIM(rutid), '') IS NOT NULL
  `)

  return rows
    .map(row => String(row.rutid).trim())
    .filter(Boolean)
}

async function createTargetRutidsTempTable(connection, rutids) {
  await connection.query('DROP TEMPORARY TABLE IF EXISTS tmp_target_rutids')
  await connection.query(`
    CREATE TEMPORARY TABLE tmp_target_rutids (
      rutid VARCHAR(20) PRIMARY KEY
    )
  `)

  const chunkSize = 1000
  for (let index = 0; index < rutids.length; index += chunkSize) {
    const slice = rutids.slice(index, index + chunkSize)
    const placeholders = slice.map(() => '(?)').join(',')
    await connection.query(
      `INSERT IGNORE INTO tmp_target_rutids (rutid) VALUES ${placeholders}`,
      slice
    )
  }
}

async function fetchEmpresasCandidates(connection) {
  const [rows] = await connection.query(`
    SELECT
      t.rutid,
      MAX(NULLIF(TRIM(e.RAZON_SOCIAL), '')) AS company_name,
      MAX(NULLIF(TRIM(e.FONO_AREA_COMER), '')) AS fono_area_comer,
      MAX(NULLIF(TRIM(e.FONO_NUMERO_COMER), '')) AS fono_numero_comer
    FROM tmp_target_rutids t
    LEFT JOIN empresas e ON e.RUTID = t.rutid
    GROUP BY t.rutid
    HAVING company_name IS NOT NULL OR fono_numero_comer IS NOT NULL
  `)

  return rows
}

async function fetchEjecutivosCandidates(connection) {
  const [rows] = await connection.query(`
    SELECT
      t.rutid,
      MAX(NULLIF(TRIM(e.RAZON_SOCIAL), '')) AS company_name,
      MIN(LOWER(NULLIF(TRIM(e.EMAIL), ''))) AS email,
      MAX(NULLIF(TRIM(e.FONO_AREA_CEL), '')) AS fono_area_cel,
      MAX(NULLIF(TRIM(e.FONO_NUMERO_CEL), '')) AS fono_numero_cel,
      MAX(NULLIF(TRIM(e.FONO_AREA_COMER), '')) AS fono_area_comer,
      MAX(NULLIF(TRIM(e.FONO_NUMERO_COMER), '')) AS fono_numero_comer
    FROM tmp_target_rutids t
    LEFT JOIN ejecutivos e ON e.RUTID = t.rutid
    GROUP BY t.rutid
    HAVING company_name IS NOT NULL OR email IS NOT NULL OR fono_numero_cel IS NOT NULL OR fono_numero_comer IS NOT NULL
  `)

  return rows
}

async function fetchBbrrCandidates(connection) {
  const [rows] = await connection.query(`
    SELECT
      t.rutid,
      MAX(NULLIF(TRIM(b.NOMBRE_RAZONSOCIAL), '')) AS company_name,
      MAX(NULLIF(TRIM(b.FONO_AREA_CEL), '')) AS fono_area_cel,
      MAX(NULLIF(TRIM(b.FONO_NUMERO_CEL), '')) AS fono_numero_cel,
      MAX(NULLIF(TRIM(b.FONO_AREA_COMER), '')) AS fono_area_comer,
      MAX(NULLIF(TRIM(b.FONO_NUMERO_COMER), '')) AS fono_numero_comer,
      MAX(NULLIF(TRIM(b.FONO_AREA_PART), '')) AS fono_area_part,
      MAX(NULLIF(TRIM(b.FONO_NUMERO_PART), '')) AS fono_numero_part
    FROM tmp_target_rutids t
    LEFT JOIN bbrr b ON b.RUTID = t.rutid
    GROUP BY t.rutid
    HAVING company_name IS NOT NULL OR fono_numero_cel IS NOT NULL OR fono_numero_comer IS NOT NULL OR fono_numero_part IS NOT NULL
  `)

  return rows
}

async function fetchPgRows(client, rutids) {
  const rows = []
  const chunkSize = 5000

  for (let index = 0; index < rutids.length; index += chunkSize) {
    const slice = rutids.slice(index, index + chunkSize)
    const placeholders = slice.map((_, offset) => `$${offset + 1}`).join(', ')
    const sql = `
      SELECT rutid, email, fono_cel, razon_social_empresa
      FROM personas_master
      WHERE rutid IN (${placeholders})
    `
    const result = await client.query(sql, slice)
    rows.push(...result.rows)
  }

  return rows
}

function ensureCandidate(map, rutid) {
  if (!map.has(rutid)) {
    map.set(rutid, {
      rutid,
      companyName: null,
      emails: [],
      phones: [],
    })
  }

  return map.get(rutid)
}

async function upsertPgRows(client, rows, batchSize) {
  let processed = 0

  for (let index = 0; index < rows.length; index += batchSize) {
    const slice = rows.slice(index, index + batchSize)
    const values = []
    const placeholders = slice.map((row, rowIndex) => {
      const offset = rowIndex * 4
      values.push(row.rutid, row.email, row.fono_cel, row.razon_social_empresa)
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, NOW())`
    }).join(', ')

    const sql = `
      INSERT INTO personas_master (rutid, email, fono_cel, razon_social_empresa, loaded_at)
      VALUES ${placeholders}
      ON CONFLICT (rutid) DO UPDATE SET
        email = COALESCE(NULLIF(personas_master.email, ''), EXCLUDED.email),
        fono_cel = COALESCE(NULLIF(personas_master.fono_cel, ''), EXCLUDED.fono_cel),
        razon_social_empresa = COALESCE(NULLIF(personas_master.razon_social_empresa, ''), EXCLUDED.razon_social_empresa),
        loaded_at = NOW()
    `

    await client.query(sql, values)
    processed += slice.length
  }

  return processed
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const mysqlConnection = await mysql.createConnection(MYSQL_CONFIG)
  const rutids = args.all
    ? await fetchGlobalTargetRutids(mysqlConnection)
    : extractRutidsFromFile(args.file)

  if (rutids.length === 0) {
    throw new Error('El archivo no contiene RUTs validos')
  }

  const pgClient = new Client(getPgConfig())
  await pgClient.connect()

  try {
    await createTargetRutidsTempTable(mysqlConnection, rutids)

    const [empresas, ejecutivos, bbrr, currentMaster] = await Promise.all([
      fetchEmpresasCandidates(mysqlConnection),
      fetchEjecutivosCandidates(mysqlConnection),
      args.all && !args.withBbrr
        ? Promise.resolve([])
        : fetchBbrrCandidates(mysqlConnection),
      fetchPgRows(pgClient, rutids),
    ])

    const candidates = new Map()

    for (const row of empresas) {
      const candidate = ensureCandidate(candidates, String(row.rutid))
      if (!candidate.companyName && isPresent(row.company_name)) {
        candidate.companyName = String(row.company_name).trim()
      }

      pushCandidate(
        candidate.phones,
        normalizePhone(row.fono_area_comer, row.fono_numero_comer),
        'empresa_comercial'
      )
    }

    for (const row of ejecutivos) {
      const candidate = ensureCandidate(candidates, String(row.rutid))
      if (!candidate.companyName && isPresent(row.company_name)) {
        candidate.companyName = String(row.company_name).trim()
      }

      const email = normalizeEmail(row.email)
      if (email) candidate.emails.push(email)

      pushCandidate(
        candidate.phones,
        normalizePhone(row.fono_area_cel, row.fono_numero_cel),
        'ejecutivo_cel'
      )
      pushCandidate(
        candidate.phones,
        normalizePhone(row.fono_area_comer, row.fono_numero_comer),
        'ejecutivo_comercial'
      )
    }

    for (const row of bbrr) {
      const candidate = ensureCandidate(candidates, String(row.rutid))
      if (!candidate.companyName && isPresent(row.company_name)) {
        candidate.companyName = String(row.company_name).trim()
      }

      pushCandidate(
        candidate.phones,
        normalizePhone(row.fono_area_cel, row.fono_numero_cel),
        'bbrr_cel'
      )
      pushCandidate(
        candidate.phones,
        normalizePhone(row.fono_area_comer, row.fono_numero_comer),
        'bbrr_comercial'
      )
      pushCandidate(
        candidate.phones,
        normalizePhone(row.fono_area_part, row.fono_numero_part),
        'bbrr_particular'
      )
    }

    const currentByRut = new Map(currentMaster.map(row => [String(row.rutid), row]))

    const upsertRows = []
    let rowsWithCandidate = 0
    let emailCandidates = 0
    let phoneCandidates = 0
    let emailBackfilled = 0
    let phoneBackfilled = 0
    let companyBackfilled = 0
    let insertedRows = 0

    for (const rutid of rutids) {
      const candidate = candidates.get(rutid)
      if (!candidate) continue

      const bestEmail = chooseEmail(candidate.emails)
      const bestPhone = choosePhone(candidate.phones)
      const existing = currentByRut.get(rutid) ?? null

      if (bestEmail || bestPhone || candidate.companyName) rowsWithCandidate += 1
      if (bestEmail) emailCandidates += 1
      if (bestPhone) phoneCandidates += 1

      const payload = {
        rutid,
        email: null,
        fono_cel: null,
        razon_social_empresa: null,
      }

      if ((!isPresent(existing?.email)) && bestEmail) {
        payload.email = bestEmail
        emailBackfilled += 1
      }

      if ((!isPresent(existing?.fono_cel)) && bestPhone) {
        payload.fono_cel = bestPhone
        phoneBackfilled += 1
      }

      if ((!isPresent(existing?.razon_social_empresa)) && isPresent(candidate.companyName)) {
        payload.razon_social_empresa = candidate.companyName
        companyBackfilled += 1
      }

      if (payload.email || payload.fono_cel || payload.razon_social_empresa) {
        if (!existing) insertedRows += 1
        upsertRows.push(payload)
      }
    }

    if (!args.dryRun && upsertRows.length > 0) {
      await upsertPgRows(pgClient, upsertRows, args.batchSize)
      await pgClient.query('SELECT refresh_dashboard_stats()')
    }

    const afterRows = await fetchPgRows(pgClient, rutids)
    const afterSummary = {
      matched_rows: afterRows.length,
      with_email: afterRows.filter(row => isPresent(row.email)).length,
      with_phone: afterRows.filter(row => isPresent(row.fono_cel)).length,
      with_company: afterRows.filter(row => isPresent(row.razon_social_empresa)).length,
    }

    console.log(JSON.stringify({
      file: args.file,
      all: args.all,
      with_bbrr: args.all ? args.withBbrr : true,
      dry_run: args.dryRun,
      target_rutids: rutids.length,
      source_rows: {
        empresas: empresas.length,
        ejecutivos: ejecutivos.length,
        bbrr: bbrr.length,
      },
      candidates: {
        rows_with_candidate: rowsWithCandidate,
        email_candidates: emailCandidates,
        phone_candidates: phoneCandidates,
      },
      applied: {
        rows_to_upsert: upsertRows.length,
        inserted_rows: insertedRows,
        email_backfilled: emailBackfilled,
        phone_backfilled: phoneBackfilled,
        company_backfilled: companyBackfilled,
      },
      after: afterSummary,
    }, null, 2))
  } finally {
    await mysqlConnection.end()
    await pgClient.end()
  }
}

main().catch(error => {
  console.error(`Fallo en backfill-company-contacts: ${error.message}`)
  process.exitCode = 1
})
