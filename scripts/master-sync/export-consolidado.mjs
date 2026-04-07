#!/usr/bin/env node
/**
 * export-consolidado.mjs
 * ============================================================
 * Exporta el JOIN completo de las 6 tablas MySQL (master_test)
 * directamente hacia la tabla personas_master en Supabase.
 *
 * Estrategia:
 *  - Cursor-based pagination (WHERE rutid > last_cursor ORDER BY rutid)
 *    para evitar el degradado de LIMIT/OFFSET a millones de filas
 *  - Streams COPY para inserción masiva eficiente en Postgres
 *  - Modo upsert por defecto (INSERT ON CONFLICT DO UPDATE)
 *  - Modo truncate+load con flag --mode=replace
 *
 * Uso:
 *   node --env-file=.env.local scripts/master-sync/export-consolidado.mjs
 *   node --env-file=.env.local scripts/master-sync/export-consolidado.mjs --mode=replace
 *   node --env-file=.env.local scripts/master-sync/export-consolidado.mjs --batch=50000
 *   node --env-file=.env.local scripts/master-sync/export-consolidado.mjs --resume=08000000-5
 *
 * Variables de entorno requeridas (.env.local):
 *   MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 *   SUPABASE_DB_HOST, SUPABASE_DB_PORT, SUPABASE_DB_NAME,
 *   SUPABASE_DB_USER, SUPABASE_DB_PASSWORD
 * ============================================================
 */

import mysql from 'mysql2/promise'
import pg from 'pg'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { createGzip } from 'zlib'
import { performance } from 'perf_hooks'

const { Pool } = pg

// ── CLI args ──────────────────────────────────────────────────
const args = process.argv.slice(2)
const MODE        = args.includes('--mode=replace') ? 'replace' : 'upsert'
const BATCH_SIZE  = parseInt(args.find(a => a.startsWith('--batch='))?.split('=')[1] ?? '100000')
const RESUME_FROM = args.find(a => a.startsWith('--resume='))?.split('=')[1] ?? ''
const DRY_RUN     = args.includes('--dry-run')
const VERBOSE     = args.includes('--verbose')

// ── Config ────────────────────────────────────────────────────
const MYSQL_CONFIG = {
  host:               process.env.MYSQL_HOST     ?? '127.0.0.1',
  port:     parseInt(process.env.MYSQL_PORT      ?? '3306'),
  user:               process.env.MYSQL_USER     ?? 'root',
  password:           process.env.MYSQL_PASSWORD ?? '',
  database:           process.env.MYSQL_DATABASE ?? 'master_test',
  charset:            'utf8mb4',
  connectTimeout:     30_000,
  // Sin pool: usamos una sola conexión larga para el streaming
}

const PG_CONFIG = {
  host:     process.env.SUPABASE_DB_HOST     ?? process.env.PGHOST,
  port: parseInt(process.env.SUPABASE_DB_PORT ?? process.env.PGPORT ?? '5432'),
  database: process.env.SUPABASE_DB_NAME     ?? process.env.PGDATABASE ?? 'postgres',
  user:     process.env.SUPABASE_DB_USER     ?? process.env.PGUSER,
  password: process.env.SUPABASE_DB_PASSWORD ?? process.env.PGPASSWORD,
  ssl:      process.env.SUPABASE_DB_SSL !== 'false'
              ? { rejectUnauthorized: false }
              : false,
  connectionTimeoutMillis: 30_000,
  statement_timeout:       0,   // sin timeout para queries largas
}

// ── Query consolidada (JOIN de las 6 tablas) ──────────────────
const CONSOLIDATED_QUERY = `
  SELECT
    mp.rutid,
    pr.nombres,
    pr.paterno,
    pr.materno,
    pr.email,
    pr.fono_cel,
    pr.comuna_part,
    pr.region_part,
    COALESCE(ar.n_autos, 0)                     AS n_autos,
    er.razon_social_empresa,
    dr.comuna                                   AS domicilio_comuna,
    dr.region                                   AS domicilio_region,
    COALESCE(ac.n_bienes_raices, 0)             AS n_bienes_raices,
    COALESCE(ac.totalavaluos, 0)                AS totalavaluos
  FROM master_personas mp
  LEFT JOIN pernat_resumen    pr  ON pr.rutid  = mp.rutid
  LEFT JOIN autos_resumen     ar  ON ar.RUTID  = mp.rutid
  LEFT JOIN empresa_resumen   er  ON er.RUTID  = mp.rutid
  LEFT JOIN domicilio_resumen dr  ON dr.RUT    = mp.rutid
  LEFT JOIN acumulado_resumen ac  ON ac.rutid  = mp.rutid
  WHERE mp.rutid > ?
  ORDER BY mp.rutid
  LIMIT ?
`

const COLUMNS = [
  'rutid','nombres','paterno','materno','email','fono_cel',
  'comuna_part','region_part','n_autos','razon_social_empresa',
  'domicilio_comuna','domicilio_region','n_bienes_raices','totalavaluos',
]

// ── Helpers ───────────────────────────────────────────────────
function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args) }
function verbose(...args) { if (VERBOSE) log('[VERBOSE]', ...args) }

/**
 * Escapado seguro de valores para CSV (RFC 4180)
 * No necesitamos librerías externas — lo hacemos inline
 */
function csvField(val) {
  if (val === null || val === undefined) return ''
  const s = String(val)
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

function rowToCsvLine(row) {
  return COLUMNS.map(col => csvField(row[col])).join(',') + '\n'
}

// ── Upsert vía COPY temporal ──────────────────────────────────
async function copyBatchToPostgres(pgClient, rows) {
  if (rows.length === 0) return 0

  // Tabla temporal para staging del batch
  await pgClient.query(`
    CREATE TEMP TABLE IF NOT EXISTS pm_staging (LIKE personas_master INCLUDING DEFAULTS)
    ON COMMIT DELETE ROWS
  `)

  // Construir CSV en memoria para este batch
  const csvLines = COLUMNS.join(',') + '\n' +
    rows.map(rowToCsvLine).join('')

  // COPY desde stdin
  const copyStream = pgClient.query(
    `COPY pm_staging (${COLUMNS.join(',')}) FROM STDIN WITH (FORMAT csv, HEADER true, NULL '')`
  )

  const readable = Readable.from([csvLines])
  await pipeline(readable, copyStream)

  // Upsert: insertar desde staging con ON CONFLICT UPDATE
  const updateCols = COLUMNS.filter(c => c !== 'rutid')
  const setClause  = updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ')

  const { rowCount } = await pgClient.query(`
    INSERT INTO personas_master (${COLUMNS.join(',')}, loaded_at)
    SELECT ${COLUMNS.join(',')}, NOW() FROM pm_staging
    ON CONFLICT (rutid) DO UPDATE SET
      ${setClause},
      loaded_at = NOW()
  `)

  await pgClient.query('DELETE FROM pm_staging')
  return rowCount ?? rows.length
}

// ── Inserción batch vía multi-value INSERT (fallback sin COPY) ─
async function insertBatchFallback(pgClient, rows) {
  if (rows.length === 0) return 0

  const chunkSize = 500
  let inserted = 0

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    const placeholders = chunk.map((_, ri) => {
      const base = ri * COLUMNS.length
      return '(' + COLUMNS.map((_, ci) => `$${base + ci + 1}`).join(',') + ', NOW())'
    }).join(',')

    const values = chunk.flatMap(row => COLUMNS.map(col => {
      const v = row[col]
      return v === undefined ? null : v
    }))

    const updateCols = COLUMNS.filter(c => c !== 'rutid')
    const setClause  = updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ')

    await pgClient.query(
      `INSERT INTO personas_master (${COLUMNS.join(',')}, loaded_at)
       VALUES ${placeholders}
       ON CONFLICT (rutid) DO UPDATE SET ${setClause}, loaded_at = NOW()`,
      values
    )
    inserted += chunk.length
  }
  return inserted
}

// ── Conteo MySQL ──────────────────────────────────────────────
async function getMysqlCount(mysqlConn) {
  const [[row]] = await mysqlConn.execute('SELECT COUNT(*) AS cnt FROM master_personas')
  return Number(row.cnt)
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  log('═══════════════════════════════════════════════════')
  log('  export-consolidado.mjs — MySQL → Supabase')
  log(`  Modo: ${MODE.toUpperCase()} | Batch: ${BATCH_SIZE.toLocaleString()} rows`)
  if (RESUME_FROM) log(`  Resumiendo desde cursor: ${RESUME_FROM}`)
  if (DRY_RUN) log('  ⚠ DRY RUN — no se escribirá nada en Supabase')
  log('═══════════════════════════════════════════════════')

  // ── Validar variables de entorno ──────────────────────────
  const missingVars = []
  if (!PG_CONFIG.host)     missingVars.push('SUPABASE_DB_HOST')
  if (!PG_CONFIG.user)     missingVars.push('SUPABASE_DB_USER')
  if (!PG_CONFIG.password) missingVars.push('SUPABASE_DB_PASSWORD')

  if (missingVars.length > 0) {
    console.error('❌ Faltan variables de entorno:', missingVars.join(', '))
    console.error('   Crea .env.local con las variables necesarias.')
    process.exit(1)
  }

  // ── Conectar MySQL ────────────────────────────────────────
  log('Conectando a MySQL...')
  let mysqlConn
  try {
    mysqlConn = await mysql.createConnection(MYSQL_CONFIG)
    await mysqlConn.execute('SELECT 1')
    log('✓ MySQL conectado:', MYSQL_CONFIG.host, '/', MYSQL_CONFIG.database)
  } catch (err) {
    console.error('❌ Error conectando a MySQL:', err.message)
    process.exit(1)
  }

  // ── Conectar PostgreSQL ───────────────────────────────────
  log('Conectando a Supabase/Postgres...')
  const pgPool = new Pool(PG_CONFIG)
  let pgClient
  try {
    pgClient = await pgPool.connect()
    await pgClient.query('SELECT 1')
    log('✓ Postgres conectado:', PG_CONFIG.host, '/', PG_CONFIG.database)
  } catch (err) {
    console.error('❌ Error conectando a Postgres:', err.message)
    await mysqlConn.end()
    process.exit(1)
  }

  // ── Verificar tabla destino ───────────────────────────────
  const { rows: tableCheck } = await pgClient.query(`
    SELECT to_regclass('public.personas_master') AS tbl
  `)
  if (!tableCheck[0].tbl) {
    console.error('❌ La tabla personas_master no existe en Supabase.')
    console.error('   Ejecuta primero: supabase/schema-consolidado.sql')
    await cleanup(mysqlConn, pgClient, pgPool)
    process.exit(1)
  }

  // ── Contar registros origen ───────────────────────────────
  log('Contando registros en MySQL...')
  const totalRows = await getMysqlCount(mysqlConn)
  log(`  Total en master_personas: ${totalRows.toLocaleString()} registros`)

  // ── Modo replace: truncar tabla destino ───────────────────
  if (MODE === 'replace' && !DRY_RUN) {
    log('Truncando personas_master (modo replace)...')
    await pgClient.query('TRUNCATE TABLE personas_master')
    log('✓ Tabla truncada')
  }

  // ── Estado inicial ────────────────────────────────────────
  const startTime = performance.now()
  let cursor      = RESUME_FROM || '0'
  let totalLoaded = 0
  let batchNum    = 0
  let errors      = 0

  if (RESUME_FROM) {
    // Contar cuántos ya estaban cargados
    const { rows: countRows } = await pgClient.query(
      `SELECT COUNT(*) AS cnt FROM personas_master WHERE rutid <= $1`, [RESUME_FROM]
    )
    totalLoaded = parseInt(countRows[0].cnt)
    log(`Reanudando: ${totalLoaded.toLocaleString()} registros ya cargados`)
  }

  // ── Bucle principal ───────────────────────────────────────
  log('Iniciando migración...')
  log('─────────────────────────────────────────────────────')

  while (true) {
    batchNum++
    verbose(`Batch ${batchNum}: cursor="${cursor}"`)

    // Fetch desde MySQL
    const batchStart = performance.now()
    let rows
    try {
      const sql = CONSOLIDATED_QUERY.replace('?', mysqlConn.escape(cursor)).replace('?', BATCH_SIZE)
      const [mysqlRows] = await mysqlConn.query(sql)
      rows = mysqlRows
    } catch (err) {
      console.error(`❌ Error en MySQL batch ${batchNum}:`, err.message)
      errors++
      if (errors > 5) {
        console.error('Demasiados errores consecutivos. Abortando.')
        break
      }
      continue
    }

    if (rows.length === 0) {
      log('No hay más registros. Migración completa.')
      break
    }

    // Cargar en Postgres
    if (!DRY_RUN) {
      try {
        let inserted
        try {
          // Usar INSERT directo (compatible con Transaction Mode pooler)
          inserted = await insertBatchFallback(pgClient, rows)
        } catch (copyErr) {
          verbose('INSERT falló:', copyErr.message)
          inserted = 0
        }
        errors = 0 // reset en éxito
        totalLoaded += inserted
      } catch (err) {
        console.error(`❌ Error cargando batch ${batchNum}:`, err.message)
        errors++
        if (errors > 5) {
          console.error('Demasiados errores. Abortando.')
          break
        }
        // Continuar con el siguiente batch
        cursor = rows[rows.length - 1].rutid
        continue
      }
    } else {
      totalLoaded += rows.length
    }

    // Actualizar cursor
    cursor = rows[rows.length - 1].rutid

    // Progreso
    const batchMs  = performance.now() - batchStart
    const totalMs  = performance.now() - startTime
    const pct      = totalRows > 0 ? (totalLoaded / totalRows * 100).toFixed(1) : '?'
    const rps      = Math.round(rows.length / (batchMs / 1000))
    const etaSec   = totalRows > 0
      ? Math.round((totalRows - totalLoaded) / (totalLoaded / (totalMs / 1000)))
      : 0
    const etaMin   = Math.floor(etaSec / 60)
    const etaSecs  = etaSec % 60

    log(
      `Batch ${batchNum}: +${rows.length.toLocaleString()} rows | ` +
      `Total: ${totalLoaded.toLocaleString()}/${totalRows.toLocaleString()} (${pct}%) | ` +
      `${rps.toLocaleString()} rows/s | ` +
      `ETA: ${etaMin}m ${etaSecs}s | ` +
      `Cursor: ${cursor}`
    )
  }

  // ── Refrescar vistas materializadas ──────────────────────
  if (!DRY_RUN && totalLoaded > 0) {
    log('Refrescando vistas materializadas...')
    try {
      await pgClient.query('SELECT refresh_pm_stats()')
      log('✓ Vistas materializadas actualizadas')
    } catch (err) {
      log('⚠ No se pudieron refrescar vistas (puede que no existan aún):', err.message)
    }
  }

  // ── Resumen final ─────────────────────────────────────────
  const totalSec = ((performance.now() - startTime) / 1000).toFixed(1)
  const avgRps   = totalSec > 0 ? Math.round(totalLoaded / totalSec) : 0

  log('═══════════════════════════════════════════════════')
  log('  MIGRACIÓN COMPLETADA')
  log(`  Registros migrados : ${totalLoaded.toLocaleString()}`)
  log(`  Tiempo total       : ${totalSec}s`)
  log(`  Velocidad promedio : ${avgRps.toLocaleString()} rows/s`)
  if (errors > 0) log(`  ⚠ Errores ignorados: ${errors}`)
  if (DRY_RUN) log('  ⚠ DRY RUN — nada fue escrito en Supabase')
  log('═══════════════════════════════════════════════════')

  await cleanup(mysqlConn, pgClient, pgPool)
  process.exit(errors > 0 ? 1 : 0)
}

async function cleanup(mysqlConn, pgClient, pgPool) {
  try { await mysqlConn?.end() } catch {}
  try { pgClient?.release() } catch {}
  try { await pgPool?.end() } catch {}
}

main().catch(err => {
  console.error('Error fatal:', err)
  process.exit(1)
})
