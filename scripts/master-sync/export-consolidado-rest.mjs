#!/usr/bin/env node
/**
 * export-consolidado-rest.mjs
 * ============================================================
 * Versión alternativa que usa la API REST de Supabase (via
 * @supabase/supabase-js) en lugar de conexión directa a Postgres.
 * No requiere pooler ni conexión directa — funciona desde cualquier red.
 *
 * Uso:
 *   node --env-file=.env.local scripts/master-sync/export-consolidado-rest.mjs
 *   node --env-file=.env.local scripts/master-sync/export-consolidado-rest.mjs --mode=replace
 *   node --env-file=.env.local scripts/master-sync/export-consolidado-rest.mjs --batch=500
 *   node --env-file=.env.local scripts/master-sync/export-consolidado-rest.mjs --resume=08000000-5
 *
 * Variables de entorno requeridas (.env.local):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 * ============================================================
 */

import mysql from 'mysql2/promise'
import { createClient } from '@supabase/supabase-js'
import { performance } from 'perf_hooks'

// ── CLI args ──────────────────────────────────────────────────
const args = process.argv.slice(2)
const MODE        = args.includes('--mode=replace') ? 'replace' : 'upsert'
const BATCH_SIZE  = parseInt(args.find(a => a.startsWith('--batch='))?.split('=')[1] ?? '500')
const RESUME_FROM = args.find(a => a.startsWith('--resume='))?.split('=')[1] ?? ''
const DRY_RUN     = args.includes('--dry-run')

// ── Config MySQL ──────────────────────────────────────────────
const MYSQL_CONFIG = {
  host:           process.env.MYSQL_HOST     ?? '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT      ?? '3306'),
  user:           process.env.MYSQL_USER     ?? 'root',
  password:       process.env.MYSQL_PASSWORD ?? '',
  database:       process.env.MYSQL_DATABASE ?? 'master_test',
  charset:        'utf8mb4',
  connectTimeout: 30_000,
}

// ── Supabase REST client ──────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

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

// ── Helpers ───────────────────────────────────────────────────
function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a) }

async function getMysqlCount(conn) {
  const [[row]] = await conn.execute('SELECT COUNT(*) AS cnt FROM master_personas')
  return Number(row.cnt)
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  log('═══════════════════════════════════════════════════')
  log('  export-consolidado-rest.mjs — MySQL → Supabase REST')
  log(`  Modo: ${MODE.toUpperCase()} | Batch: ${BATCH_SIZE.toLocaleString()} rows`)
  if (RESUME_FROM) log(`  Resumiendo desde cursor: ${RESUME_FROM}`)
  if (DRY_RUN) log('  ⚠ DRY RUN')
  log('═══════════════════════════════════════════════════')

  // ── Validar env vars ──────────────────────────────────────
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY')
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

  // ── Inicializar cliente Supabase ──────────────────────────
  log('Conectando a Supabase REST API...')
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
  })

  // Test de conexión
  const { error: testErr } = await supabase
    .from('personas_master')
    .select('rutid', { count: 'exact', head: true })

  if (testErr) {
    console.error('❌ Error conectando a Supabase:', testErr.message)
    await mysqlConn.end()
    process.exit(1)
  }
  log('✓ Supabase REST API conectada:', SUPABASE_URL)

  // ── Contar registros origen ───────────────────────────────
  log('Contando registros en MySQL...')
  const totalRows = await getMysqlCount(mysqlConn)
  log(`  Total en master_personas: ${totalRows.toLocaleString()} registros`)

  // ── Modo replace: truncar tabla destino ───────────────────
  if (MODE === 'replace' && !DRY_RUN) {
    log('Truncando personas_master (modo replace)...')
    const { error: truncErr } = await supabase.rpc('truncate_personas_master')
    if (truncErr) {
      // Fallback: borrar en bloques
      log('  RPC no disponible, borrando vía DELETE...')
      const { error: delErr } = await supabase
        .from('personas_master')
        .delete()
        .neq('rutid', 'XXXXX_NEVER_MATCH')
      if (delErr) log('  ⚠ No se pudo truncar:', delErr.message)
      else log('✓ Tabla vaciada')
    } else {
      log('✓ Tabla truncada')
    }
  }

  // ── Estado inicial ────────────────────────────────────────
  const startTime = performance.now()
  let cursor      = RESUME_FROM || '0'
  let totalLoaded = 0
  let batchNum    = 0
  let errors      = 0

  // ── Bucle principal ───────────────────────────────────────
  log('Iniciando migración...')
  log('─────────────────────────────────────────────────────')

  while (true) {
    batchNum++

    // Fetch desde MySQL
    const batchStart = performance.now()
    let rows
    try {
      const sql = CONSOLIDATED_QUERY.replace('?', mysqlConn.escape(cursor)).replace('?', BATCH_SIZE)
      const [mysqlRows] = await mysqlConn.query(sql)
      rows = mysqlRows
    } catch (err) {
      console.error(`❌ Error MySQL batch ${batchNum}:`, err.message)
      errors++
      if (errors > 5) { console.error('Demasiados errores. Abortando.'); break }
      continue
    }

    if (rows.length === 0) {
      log('No hay más registros. Migración completa.')
      break
    }

    // Cargar en Supabase vía REST
    if (!DRY_RUN) {
      const { error: upsertErr } = await supabase
        .from('personas_master')
        .upsert(rows, { onConflict: 'rutid', ignoreDuplicates: false })

      if (upsertErr) {
        console.error(`❌ Error upsert batch ${batchNum}:`, upsertErr.message)
        errors++
        if (errors > 5) { console.error('Demasiados errores. Abortando.'); break }
        cursor = rows[rows.length - 1].rutid
        continue
      }
      errors = 0
    }

    totalLoaded += rows.length
    cursor = rows[rows.length - 1].rutid

    // Progreso
    const batchMs = performance.now() - batchStart
    const totalMs = performance.now() - startTime
    const pct     = totalRows > 0 ? (totalLoaded / totalRows * 100).toFixed(1) : '?'
    const rps     = Math.round(rows.length / (batchMs / 1000))
    const etaSec  = totalRows > 0
      ? Math.round((totalRows - totalLoaded) / (totalLoaded / (totalMs / 1000)))
      : 0
    const etaMin  = Math.floor(etaSec / 60)
    const etaSecs = etaSec % 60

    log(
      `Batch ${batchNum}: +${rows.length.toLocaleString()} | ` +
      `Total: ${totalLoaded.toLocaleString()}/${totalRows.toLocaleString()} (${pct}%) | ` +
      `${rps.toLocaleString()} rows/s | ` +
      `ETA: ${etaMin}m ${etaSecs}s | ` +
      `Cursor: ${cursor}`
    )
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
  if (DRY_RUN) log('  ⚠ DRY RUN — nada fue escrito')
  log('═══════════════════════════════════════════════════')

  await mysqlConn.end()
  process.exit(errors > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Error fatal:', err)
  process.exit(1)
})
