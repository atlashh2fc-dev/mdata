#!/usr/bin/env node
/**
 * verify-migration.mjs
 * ============================================================
 * Verifica la integridad y completitud de la migración
 * MySQL master_test → Supabase personas_master
 *
 * Compara:
 *  - Conteo de filas
 *  - Cobertura de cada columna
 *  - Muestras aleatorias de RUTs específicos
 *  - Distribución por región
 *
 * Uso:
 *   node --env-file=.env.local scripts/master-sync/verify-migration.mjs
 *   node --env-file=.env.local scripts/master-sync/verify-migration.mjs --rut=12345678-9
 * ============================================================
 */

import mysql from 'mysql2/promise'
import pg from 'pg'

const { Pool } = pg

const SPECIFIC_RUT = process.argv.find(a => a.startsWith('--rut='))?.split('=')[1]

const MYSQL_CONFIG = {
  host:     process.env.MYSQL_HOST     ?? '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT ?? '3306'),
  user:     process.env.MYSQL_USER     ?? 'root',
  password: process.env.MYSQL_PASSWORD ?? '',
  database: process.env.MYSQL_DATABASE ?? 'master_test',
  charset:  'utf8mb4',
}

const PG_CONFIG = {
  host:     process.env.SUPABASE_DB_HOST     ?? process.env.PGHOST,
  port: parseInt(process.env.SUPABASE_DB_PORT ?? process.env.PGPORT ?? '5432'),
  database: process.env.SUPABASE_DB_NAME     ?? process.env.PGDATABASE ?? 'postgres',
  user:     process.env.SUPABASE_DB_USER     ?? process.env.PGUSER,
  password: process.env.SUPABASE_DB_PASSWORD ?? process.env.PGPASSWORD,
  ssl: process.env.SUPABASE_DB_SSL !== 'false'
    ? { rejectUnauthorized: false }
    : false,
}

function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args) }

function pct(part, total) {
  if (!total) return '0.0%'
  return (part / total * 100).toFixed(1) + '%'
}

function bar(pctNum, width = 20) {
  const filled = Math.round(pctNum / 100 * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

async function main() {
  log('═══════════════════════════════════════════════════')
  log('  verify-migration.mjs — Verificación de Migración')
  log('═══════════════════════════════════════════════════')

  // ── Conexiones ────────────────────────────────────────────
  log('Conectando...')
  let mysqlConn, pgClient, pgPool

  try {
    mysqlConn = await mysql.createConnection(MYSQL_CONFIG)
    pgPool    = new Pool(PG_CONFIG)
    pgClient  = await pgPool.connect()
    log('✓ Conexiones establecidas')
  } catch (err) {
    console.error('❌ Error de conexión:', err.message)
    process.exit(1)
  }

  // ── 1. Conteo de filas ───────────────────────────────────
  log('\n── 1. CONTEO DE FILAS ─────────────────────────────')

  const [[mysqlCount]] = await mysqlConn.execute(
    'SELECT COUNT(*) AS cnt FROM master_personas'
  )
  const { rows: pgRows } = await pgClient.query(
    'SELECT COUNT(*) AS cnt FROM personas_master'
  )

  const mysqlTotal = Number(mysqlCount.cnt)
  const pgTotal    = Number(pgRows[0].cnt)
  const diff       = mysqlTotal - pgTotal
  const pctDone    = mysqlTotal > 0 ? (pgTotal / mysqlTotal * 100).toFixed(2) : '0'

  console.log(`  MySQL  master_personas : ${mysqlTotal.toLocaleString()} registros`)
  console.log(`  Supabase personas_master: ${pgTotal.toLocaleString()} registros`)
  console.log(`  Diferencia              : ${diff > 0 ? '+' : ''}${diff.toLocaleString()}`)
  console.log(`  Progreso migración      : ${pctDone}% [${bar(parseFloat(pctDone))}]`)

  if (diff === 0) {
    console.log('  ✅ Conteo EXACTO — migración completa')
  } else if (diff > 0) {
    console.log(`  ⚠️  Faltan ${diff.toLocaleString()} registros en Supabase`)
  } else {
    console.log(`  ⚠️  Hay ${Math.abs(diff).toLocaleString()} registros de más en Supabase`)
  }

  // ── 2. Cobertura de columnas en Supabase ─────────────────
  log('\n── 2. COBERTURA DE DATOS EN SUPABASE ──────────────')

  const coverageQuery = `
    SELECT
      COUNT(*) AS total,
      COUNT(nombres)              AS nombres,
      COUNT(email)                AS email,
      COUNT(fono_cel)             AS fono,
      COUNT(razon_social_empresa) AS empresa,
      COUNT(*) FILTER (WHERE n_autos > 0)         AS con_autos,
      COUNT(*) FILTER (WHERE n_bienes_raices > 0) AS con_bienes,
      COUNT(domicilio_region)     AS domicilio
    FROM personas_master
  `
  const { rows: cov } = await pgClient.query(coverageQuery)
  const c = cov[0]
  const t = parseInt(c.total)

  const metrics = [
    { label: 'Con nombre',   n: parseInt(c.nombres) },
    { label: 'Con email',    n: parseInt(c.email) },
    { label: 'Con teléfono', n: parseInt(c.fono) },
    { label: 'Con empresa',  n: parseInt(c.empresa) },
    { label: 'Con autos',    n: parseInt(c.con_autos) },
    { label: 'Con bienes',   n: parseInt(c.con_bienes) },
    { label: 'Con domicilio',n: parseInt(c.domicilio) },
  ]

  for (const m of metrics) {
    const p = t > 0 ? (m.n / t * 100) : 0
    console.log(
      `  ${m.label.padEnd(15)}: ${m.n.toLocaleString().padStart(12)} ` +
      `(${p.toFixed(1).padStart(5)}%) [${bar(p, 15)}]`
    )
  }

  // ── 3. Top 5 regiones ────────────────────────────────────
  log('\n── 3. DISTRIBUCIÓN POR REGIÓN ─────────────────────')

  const { rows: regionRows } = await pgClient.query(`
    SELECT
      COALESCE(region_part, 'Sin región') AS region,
      COUNT(*) AS total
    FROM personas_master
    GROUP BY region_part
    ORDER BY COUNT(*) DESC
    LIMIT 8
  `)

  for (const r of regionRows) {
    const p = pgTotal > 0 ? (parseInt(r.total) / pgTotal * 100) : 0
    console.log(
      `  ${r.region.substring(0,35).padEnd(35)}: ` +
      `${parseInt(r.total).toLocaleString().padStart(10)} (${p.toFixed(1)}%)`
    )
  }

  // ── 4. Verificación por RUT específico ───────────────────
  if (SPECIFIC_RUT) {
    log(`\n── 4. VERIFICACIÓN RUT: ${SPECIFIC_RUT} ─────────────`)

    // MySQL
    const [mysqlRutRows] = await mysqlConn.execute(`
      SELECT
        mp.rutid,
        pr.nombres, pr.paterno, pr.materno,
        pr.email, pr.fono_cel,
        pr.region_part,
        COALESCE(ar.n_autos, 0) AS n_autos,
        er.razon_social_empresa,
        COALESCE(ac.n_bienes_raices, 0) AS n_bienes_raices,
        COALESCE(ac.totalavaluos, 0)    AS totalavaluos
      FROM master_personas mp
      LEFT JOIN pernat_resumen    pr ON pr.rutid = mp.rutid
      LEFT JOIN autos_resumen     ar ON ar.RUTID = mp.rutid
      LEFT JOIN empresa_resumen   er ON er.RUTID = mp.rutid
      LEFT JOIN acumulado_resumen ac ON ac.rutid = mp.rutid
      WHERE mp.rutid = ?
      LIMIT 1
    `, [SPECIFIC_RUT])

    const { rows: pgRutRows } = await pgClient.query(
      'SELECT * FROM personas_master WHERE rutid = $1', [SPECIFIC_RUT]
    )

    if (mysqlRutRows.length === 0) {
      console.log(`  ⚠️  RUT ${SPECIFIC_RUT} NO encontrado en MySQL`)
    } else if (pgRutRows.length === 0) {
      console.log(`  ❌ RUT ${SPECIFIC_RUT} existe en MySQL pero NO en Supabase`)
    } else {
      const m = mysqlRutRows[0]
      const p = pgRutRows[0]
      console.log('\n  MySQL:')
      console.log('   ', JSON.stringify(m, null, 2).split('\n').join('\n    '))
      console.log('\n  Supabase:')
      console.log('   ', JSON.stringify(p, null, 2).split('\n').join('\n    '))

      // Comparar campos clave
      const mismatches = []
      for (const col of ['nombres','paterno','email','fono_cel','n_autos','n_bienes_raices']) {
        const mv = m[col] === null ? null : String(m[col])
        const pv = p[col] === null ? null : String(p[col])
        if (mv !== pv) mismatches.push(`${col}: MySQL="${mv}" vs Supabase="${pv}"`)
      }
      if (mismatches.length === 0) {
        console.log('\n  ✅ Datos CONSISTENTES entre MySQL y Supabase')
      } else {
        console.log('\n  ⚠️  Diferencias detectadas:')
        mismatches.forEach(m => console.log('    •', m))
      }
    }
  } else {
    // Verificar 5 RUTs aleatorios
    log('\n── 4. MUESTRA ALEATORIA (5 RUTs) ──────────────────')

    const { rows: sampleRuts } = await pgClient.query(`
      SELECT rutid FROM personas_master
      WHERE email IS NOT NULL
      ORDER BY RANDOM()
      LIMIT 5
    `)

    for (const { rutid } of sampleRuts) {
      const [mysqlSample] = await mysqlConn.execute(
        `SELECT COUNT(*) AS cnt FROM master_personas WHERE rutid = ?`, [rutid]
      )
      const exists = Number(mysqlSample[0].cnt) > 0
      console.log(`  ${rutid}: ${exists ? '✅ existe en MySQL' : '❌ NO en MySQL'}`)
    }
  }

  // ── 5. Score distribution ────────────────────────────────
  log('\n── 5. DISTRIBUCIÓN DE SCORE ───────────────────────')

  const { rows: scoreRows } = await pgClient.query(`
    SELECT
      CASE
        WHEN score = 0              THEN '0    Sin datos'
        WHEN score BETWEEN 1  AND 20  THEN '1-20 Básico'
        WHEN score BETWEEN 21 AND 40  THEN '21-40 Medio'
        WHEN score BETWEEN 41 AND 60  THEN '41-60 Alto'
        WHEN score BETWEEN 61 AND 80  THEN '61-80 Premium'
        ELSE                               '81+  Elite'
      END AS rango,
      COUNT(*) AS total
    FROM personas_master
    GROUP BY rango
    ORDER BY rango
  `)

  for (const r of scoreRows) {
    const p = pgTotal > 0 ? (parseInt(r.total) / pgTotal * 100) : 0
    console.log(
      `  ${r.rango.padEnd(18)}: ${parseInt(r.total).toLocaleString().padStart(12)} ` +
      `(${p.toFixed(1)}%) [${bar(p, 15)}]`
    )
  }

  // ── 6. Última carga ──────────────────────────────────────
  const { rows: lastLoad } = await pgClient.query(`
    SELECT MAX(loaded_at) AS ultima FROM personas_master
  `)
  log(`\n  Última carga registrada: ${lastLoad[0].ultima ?? 'N/A'}`)

  // ── Resumen ───────────────────────────────────────────────
  log('\n═══════════════════════════════════════════════════')
  if (diff === 0 && pgTotal > 0) {
    log('  ✅ MIGRACIÓN VERIFICADA — datos completos y consistentes')
  } else if (pgTotal === 0) {
    log('  ❌ MIGRACIÓN VACÍA — ejecuta: npm run ops:consolidado')
  } else {
    log(`  ⚠️  MIGRACIÓN PARCIAL — ${pctDone}% completado`)
    log(`     Para completar: npm run ops:consolidado -- --resume=${
      // Obtener último cursor
      'ULTIMO_RUT_CARGADO'
    }`)
  }
  log('═══════════════════════════════════════════════════')

  // Cleanup
  try { await mysqlConn.end() } catch {}
  try { pgClient.release() } catch {}
  try { await pgPool.end() } catch {}
}

main().catch(err => {
  console.error('Error fatal:', err)
  process.exit(1)
})
