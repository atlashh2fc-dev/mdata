#!/usr/bin/env node

import mysql from 'mysql2/promise'
import pg from 'pg'
import { performance } from 'perf_hooks'

const { Pool } = pg

const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST ?? '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT ?? '3306'),
  user: process.env.MYSQL_USER ?? 'root',
  password: process.env.MYSQL_PASSWORD ?? '',
  database: process.env.MYSQL_DATABASE ?? 'master_test',
  charset: 'utf8mb4'
}

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 0,
}

async function syncAutos(mysqlConn, pgClient) {
  console.log('--- Iniciando Sync de AUTOS ---')
  let cursor = '0'
  let updated = 0
  const BATCH_SIZE = 5000

  // 1: autos_resumen has RUTID correctly formatted? Yes, we saw RUTID.
  while (true) {
    const start = performance.now()
    const [rows] = await mysqlConn.query(`
      SELECT LPAD(RUTID, 10, '0') as r, n_autos
      FROM autos_resumen
      WHERE LPAD(RUTID, 10, '0') > ?
      ORDER BY LPAD(RUTID, 10, '0')
      LIMIT ?
    `, [cursor, BATCH_SIZE])

    if (rows.length === 0) break
    const values = rows.map(r => `('${r.r}', ${r.n_autos ?? 0})`).join(',')
    
    await pgClient.query(`
      UPDATE personas_master pm
      SET n_autos = v.na, tiene_autos = true
      FROM (VALUES ${values}) AS v(rutid, na)
      WHERE pm.rutid = v.rutid
    `)
    updated += rows.length
    cursor = rows[rows.length - 1].r
    console.log(`[Autos] Procesados: ${updated} | ${((performance.now() - start)/1000).toFixed(1)}s`)
  }
}

async function syncEmpresas(mysqlConn, pgClient) {
  console.log('--- Iniciando Sync de EMPRESAS ---')
  let cursor = '0'
  let updated = 0
  const BATCH_SIZE = 5000

  while (true) {
    const start = performance.now()
    const [rows] = await mysqlConn.query(`
      SELECT LPAD(RUTID, 10, '0') as r, razon_social_empresa
      FROM empresa_resumen
      WHERE LPAD(RUTID, 10, '0') > ?
      ORDER BY LPAD(RUTID, 10, '0')
      LIMIT ?
    `, [cursor, BATCH_SIZE])

    if (rows.length === 0) break
    const values = rows.map(r => `('${r.r}', '${(r.razon_social_empresa ?? '').replace(/'/g, "''")}')`).join(',')
    
    await pgClient.query(`
      UPDATE personas_master pm
      SET tiene_empresa = true, razon_social_empresa = v.rz
      FROM (VALUES ${values}) AS v(rutid, rz)
      WHERE pm.rutid = v.rutid
    `)
    updated += rows.length
    cursor = rows[rows.length - 1].r
    console.log(`[Empresas] Procesados: ${updated} | ${((performance.now() - start)/1000).toFixed(1)}s`)
  }
}

async function syncBbrr(mysqlConn, pgClient) {
  console.log('--- Iniciando Sync de BIENES RAICES ---')
  let cursor = '0'
  let updated = 0
  const BATCH_SIZE = 5000

  while (true) {
    const start = performance.now()
    const [rows] = await mysqlConn.query(`
      SELECT LPAD(RUTID, 10, '0') as r, COUNT(*) as n, SUM(AVALUO_FISCAL) as av
      FROM bbrr
      WHERE LPAD(RUTID, 10, '0') > ?
      GROUP BY LPAD(RUTID, 10, '0')
      ORDER BY LPAD(RUTID, 10, '0')
      LIMIT ?
    `, [cursor, BATCH_SIZE])

    if (rows.length === 0) break
    const values = rows.map(r => `('${r.r}', ${r.n ?? 0}, ${r.av ?? 0})`).join(',')
    
    await pgClient.query(`
      UPDATE personas_master pm
      SET tiene_bienes_raices = true, n_bienes_raices = v.n, totalavaluos = v.av
      FROM (VALUES ${values}) AS v(rutid, n, av)
      WHERE pm.rutid = v.rutid
    `)
    updated += rows.length
    cursor = rows[rows.length - 1].r
    console.log(`[BBRR] Procesados: ${updated} | ${((performance.now() - start)/1000).toFixed(1)}s`)
  }
}

async function main() {
  const mysqlConn = await mysql.createConnection(MYSQL_CONFIG)
  const pgPool = new Pool(PG_CONFIG)
  const pgClient = await pgPool.connect()

  try {
    await syncAutos(mysqlConn, pgClient)
    await syncEmpresas(mysqlConn, pgClient)
    await syncBbrr(mysqlConn, pgClient)
    
    // Refrescar vistas materializadas para que los KPIs del dashboard se actualicen
    await pgClient.query('SELECT refresh_dashboard_stats()')
    console.log('--- SYNC COMPLETADO EXITOSAMENTE ---')
  } catch(e) {
    console.error('Error durante el sync:', e)
  } finally {
    await mysqlConn.end()
    pgClient.release()
    await pgPool.end()
  }
}

main().catch(console.error)
