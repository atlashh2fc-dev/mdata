#!/usr/bin/env node
/**
 * sync-pub-domicilio.mjs
 * ============================================================
 * Sincroniza pub_nom_domicilio (MySQL) → personas_master (Supabase)
 *
 * - Match: LPAD(CONCAT(p.RUT, p.DV), 10, '0') = mp.rutid
 * - ExtraeREGION de pub_nom_domicilio y la limpia
 * - Limpia y normaliza la comuna
 * - Solo actualiza a quienes no tienen region definida aun
 * ============================================================
 */

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
  host: process.env.SUPABASE_DB_HOST,
  port: parseInt(process.env.SUPABASE_DB_PORT ?? '5432'),
  database: process.env.SUPABASE_DB_NAME ?? 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 0,
}

async function main() {
  console.log('[INICIO] Sincronizando pub_nom_domicilio -> Supabase')
  
  const mysqlConn = await mysql.createConnection(MYSQL_CONFIG)
  const pgPool = new Pool(PG_CONFIG)
  const pgClient = await pgPool.connect()
  
  let updated = 0
  let cursor = '0'
  const BATCH_SIZE = 5000
  
  while (true) {
    const start = performance.now()
    
    // Obtener batch validando con RUT+DV a 10 chars
    const [rows] = await mysqlConn.query(`
      SELECT 
        LPAD(CONCAT(p.RUT, p.DV), 10, '0') as rutid,
        TRIM(REPLACE(p.REGION, CHAR(13), '')) as region,
        TRIM(p.COMUNA) as comuna
      FROM pub_nom_domicilio p
      JOIN master_personas mp ON LPAD(CONCAT(p.RUT, p.DV), 10, '0') = mp.rutid
      WHERE LPAD(CONCAT(p.RUT, p.DV), 10, '0') > ? 
        AND p.REGION IS NOT NULL AND p.REGION != ''
      ORDER BY LPAD(CONCAT(p.RUT, p.DV), 10, '0')
      LIMIT ?
    `, [cursor, BATCH_SIZE])
    
    if (rows.length === 0) break
    
    const values = rows.map(r => `('${r.rutid}', '${r.region.replace(/'/g, "''")}', '${(r.comuna ?? '').replace(/'/g, "''")}')`).join(',')
    
    // UPSERT: Solo actualiza si region_part O domicilio_region estan vacios
    await pgClient.query(`
      UPDATE personas_master AS pm
      SET 
        region_part = COALESCE(NULLIF(pm.region_part, ''), v.region),
        comuna_part = COALESCE(NULLIF(pm.comuna_part, ''), v.comuna),
        domicilio_region = COALESCE(NULLIF(pm.domicilio_region, ''), v.region),
        domicilio_comuna = COALESCE(NULLIF(pm.domicilio_comuna, ''), v.comuna)
      FROM (VALUES ${values}) AS v(rutid, region, comuna)
      WHERE pm.rutid = v.rutid 
        AND (pm.region_part IS NULL OR pm.region_part = '' OR pm.domicilio_region IS NULL)
    `)
    
    updated += rows.length
    cursor = rows[rows.length - 1].rutid
    const elapsed = ((performance.now() - start)/1000).toFixed(1)
    
    console.log(`[Batch] +${rows.length} | Procesados: ${updated.toLocaleString()} | ${elapsed}s`)
  }

  // Refrescar vistas en Supabase
  try {
    await pgClient.query('SELECT refresh_dashboard_stats()')
    console.log('[FIN] Vistas materializadas actualizadas')
  } catch(e) {
    console.log('[FIN] No se pudo refrescar vistas (ejecutar SQL pendiente)')
  }

  await mysqlConn.end()
  pgClient.release()
  await pgPool.end()
}

main().catch(console.error)
