#!/usr/bin/env node
/**
 * sync-domicilio.mjs
 * ============================================================
 * Sincroniza domicilio_resumen (MySQL) → personas_master (Supabase)
 *
 * - Match: LPAD(domicilio.RUT, 10, '0') = personas_master.rutid
 * - Solo actualiza registros donde domicilio_region IS NULL
 * - Limpia \r del campo region
 * - Batches de 5.000 para evitar timeouts
 *
 * Uso:
 *   node --env-file=.env.local scripts/master-sync/sync-domicilio.mjs
 *   node --env-file=.env.local scripts/master-sync/sync-domicilio.mjs --dry-run
 *   node --env-file=.env.local scripts/master-sync/sync-domicilio.mjs --batch=10000
 * ============================================================
 */

import mysql from 'mysql2/promise'
import pg from 'pg'
import { performance } from 'perf_hooks'

const { Pool } = pg

const args        = process.argv.slice(2)
const DRY_RUN     = args.includes('--dry-run')
const BATCH_SIZE  = parseInt(args.find(a => a.startsWith('--batch='))?.split('=')[1] ?? '5000')

const MYSQL_CONFIG = {
  host:     process.env.MYSQL_HOST     ?? '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT ?? '3306'),
  user:     process.env.MYSQL_USER     ?? 'root',
  password: process.env.MYSQL_PASSWORD ?? '',
  database: process.env.MYSQL_DATABASE ?? 'master_test',
  charset:  'utf8mb4',
}

const PG_CONFIG = {
  host:     process.env.SUPABASE_DB_HOST,
  port: parseInt(process.env.SUPABASE_DB_PORT ?? '5432'),
  database: process.env.SUPABASE_DB_NAME     ?? 'postgres',
  user:     process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl:      { rejectUnauthorized: false },
  statement_timeout: 0,
}

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a) }

async function main() {
  log('═══════════════════════════════════════════════════')
  log('  sync-domicilio.mjs — MySQL domicilio → Supabase')
  log(`  Batch: ${BATCH_SIZE.toLocaleString()} | ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)
  log('═══════════════════════════════════════════════════')

  // ── Conectar MySQL ──────────────────────────────────────────
  const mysqlConn = await mysql.createConnection(MYSQL_CONFIG)
  log('✓ MySQL conectado')

  // ── Contar registros que harán match ───────────────────────
  const [[{ total_match }]] = await mysqlConn.query(`
    SELECT COUNT(*) AS total_match
    FROM domicilio_resumen dr
    JOIN master_personas mp ON LPAD(dr.RUT, 10, '0') = mp.rutid
    WHERE dr.region IS NOT NULL
  `)
  log(`  Registros con match (RUT existe en personas_master): ${Number(total_match).toLocaleString()}`)

  if (total_match === 0) {
    log('⚠ No hay registros para sincronizar. Revisa el mapeo de RUTs.')
    await mysqlConn.end()
    return
  }

  // ── Conectar Postgres ───────────────────────────────────────
  const pgPool = new Pool(PG_CONFIG)
  const pgClient = await pgPool.connect()
  log('✓ Supabase/Postgres conectado')

  // ── Leer en batches con cursor ──────────────────────────────
  let cursor   = '0'
  let updated  = 0
  let batchNum = 0
  const start  = performance.now()

  while (true) {
    batchNum++

    const [rows] = await mysqlConn.query(`
      SELECT
        LPAD(dr.RUT, 10, '0')                          AS rutid,
        TRIM(REPLACE(dr.region, CHAR(13), ''))          AS domicilio_region,
        TRIM(dr.comuna)                                 AS domicilio_comuna
      FROM domicilio_resumen dr
      JOIN master_personas mp ON LPAD(dr.RUT, 10, '0') = mp.rutid
      WHERE LPAD(dr.RUT, 10, '0') > ? AND dr.region IS NOT NULL
      ORDER BY LPAD(dr.RUT, 10, '0')
      LIMIT ?
    `, [cursor, BATCH_SIZE])

    if (rows.length === 0) {
      log('Sin más registros. Sincronización completa.')
      break
    }

    if (!DRY_RUN) {
      // UPDATE en lote usando VALUES temp
      const values = rows.map(r => `('${r.rutid}', '${r.domicilio_region.replace(/'/g, "''")}', '${(r.domicilio_comuna ?? '').replace(/'/g, "''")}')`).join(',')

      await pgClient.query(`
        UPDATE personas_master AS pm
        SET
          domicilio_region = v.domicilio_region,
          domicilio_comuna = v.domicilio_comuna
        FROM (VALUES ${values}) AS v(rutid, domicilio_region, domicilio_comuna)
        WHERE pm.rutid = v.rutid
      `)
    }

    updated  += rows.length
    cursor    = rows[rows.length - 1].rutid

    const elapsed = ((performance.now() - start) / 1000).toFixed(1)
    const pct = ((updated / total_match) * 100).toFixed(1)
    log(`Batch ${batchNum}: +${rows.length.toLocaleString()} | Total: ${updated.toLocaleString()}/${Number(total_match).toLocaleString()} (${pct}%) | ${elapsed}s`)
  }

  // ── Refrescar vistas materializadas ────────────────────────
  if (!DRY_RUN && updated > 0) {
    log('Refrescando dashboard_stats...')
    try {
      await pgClient.query('SELECT refresh_dashboard_stats()')
      log('✓ Vistas actualizadas')
    } catch (e) {
      log('⚠ refresh_dashboard_stats no disponible aún:', e.message)
    }
  }

  // ── Resumen ─────────────────────────────────────────────────
  const totalSec = ((performance.now() - start) / 1000).toFixed(1)
  log('═══════════════════════════════════════════════════')
  log(`  COMPLETADO: ${updated.toLocaleString()} registros de domicilio sincronizados`)
  log(`  Tiempo: ${totalSec}s${DRY_RUN ? ' (DRY RUN — nada escrito)' : ''}`)
  log('═══════════════════════════════════════════════════')

  await mysqlConn.end()
  pgClient.release()
  await pgPool.end()
}

main().catch(e => { console.error('Error fatal:', e); process.exit(1) })
