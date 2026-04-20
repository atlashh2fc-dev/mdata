#!/usr/bin/env node

import { Client } from 'pg'

function parseArgs(argv) {
  return {
    refreshStats: !argv.includes('--no-refresh-stats'),
  }
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
    'pgbouncer',
    'supa',
  ]) {
    url.searchParams.delete(key)
  }
  return url.toString()
}

function getPgConfig() {
  const connectionString =
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.POSTGRES_URL ??
    process.env.POSTGRES_PRISMA_URL ??
    process.env.DATABASE_URL ??
    process.env.SUPABASE_DB_URL ??
    null

  if (!connectionString) {
    throw new Error('Faltan credenciales Postgres.')
  }

  return {
    connectionString: sanitizeConnectionString(connectionString),
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    statement_timeout: 0,
    query_timeout: 0,
    connectionTimeoutMillis: 30000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    application_name: 'refresh-bbrr-rollups',
  }
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

async function trySet(client, sql) {
  try {
    await client.query(sql)
  } catch (error) {
    log(`[warn] no se pudo aplicar ${sql}: ${error.message}`)
  }
}

async function configureSession(client) {
  await client.query('SET statement_timeout TO 0')
  await client.query('SET lock_timeout TO 0')
  await client.query('SET idle_in_transaction_session_timeout TO 0')
  await trySet(client, "SET synchronous_commit TO OFF")
  await trySet(client, "SET work_mem TO '128MB'")
  await trySet(client, "SET maintenance_work_mem TO '256MB'")
}

async function inspectSchema(client) {
  const columnsRes = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('personas_master', 'acumulado_resumen')
  `)

  const schema = {
    personasMasterColumns: new Set(),
    hasAcumuladoResumen: false,
  }

  for (const row of columnsRes.rows) {
    if (row.table_name === 'personas_master') {
      schema.personasMasterColumns.add(row.column_name)
    }
    if (row.table_name === 'acumulado_resumen') {
      schema.hasAcumuladoResumen = true
    }
  }

  return schema
}

async function refreshStats(client) {
  for (const sql of [
    'REFRESH MATERIALIZED VIEW public.dashboard_stats',
    'REFRESH MATERIALIZED VIEW public.stats_por_region',
    'REFRESH MATERIALIZED VIEW public.stats_score_dist',
    'REFRESH MATERIALIZED VIEW public.stats_universos',
  ]) {
    try {
      await client.query(sql)
    } catch {
      // ignore views not present
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const client = new Client(getPgConfig())

  await client.connect()
  try {
    await configureSession(client)
    const schema = await inspectSchema(client)

    log('armando rollup temporal desde bbrr_propiedades...')
    await client.query('DROP TABLE IF EXISTS bbrr_rollup')
    await client.query(`
      CREATE TEMP TABLE bbrr_rollup AS
      SELECT
        NULLIF(BTRIM(rutid), '') AS rutid,
        COUNT(*)::INTEGER AS n_bienes_raices,
        COALESCE(SUM(COALESCE(avaluo_fiscal, 0)), 0)::NUMERIC(18,2) AS totalavaluos
      FROM public.bbrr_propiedades
      WHERE NULLIF(BTRIM(rutid), '') IS NOT NULL
      GROUP BY 1
    `)
    await client.query('CREATE UNIQUE INDEX bbrr_rollup_rutid_idx ON bbrr_rollup (rutid)')

    const totals = await client.query(`
      SELECT
        COUNT(*)::BIGINT AS rutids,
        COALESCE(SUM(n_bienes_raices), 0)::BIGINT AS bienes,
        COALESCE(SUM(totalavaluos), 0)::NUMERIC(18,2) AS total_avaluos
      FROM bbrr_rollup
    `)
    log(
      `rollup temporal listo rutids=${totals.rows[0]?.rutids ?? 0} ` +
      `bienes=${totals.rows[0]?.bienes ?? 0} total_avaluos=${totals.rows[0]?.total_avaluos ?? 0}`
    )

    await client.query(`
      INSERT INTO public.master_personas (rutid)
      SELECT rutid
      FROM bbrr_rollup
      ON CONFLICT (rutid) DO NOTHING
    `)

    await client.query(`
      INSERT INTO public.personas_master (rutid)
      SELECT rutid
      FROM bbrr_rollup
      ON CONFLICT (rutid) DO NOTHING
    `)

    if (schema.hasAcumuladoResumen) {
      log('sincronizando acumulado_resumen...')
      await client.query(`
        DELETE FROM public.acumulado_resumen ar
        WHERE NOT EXISTS (
          SELECT 1
          FROM bbrr_rollup br
          WHERE br.rutid = ar.rutid
        )
      `)
      await client.query(`
        INSERT INTO public.acumulado_resumen (rutid, n_bienes_raices, totalavaluos)
        SELECT rutid, n_bienes_raices, totalavaluos
        FROM bbrr_rollup
        ON CONFLICT (rutid) DO UPDATE
        SET
          n_bienes_raices = EXCLUDED.n_bienes_raices,
          totalavaluos = EXCLUDED.totalavaluos,
          updated_at = NOW()
      `)
    }

    const personasMasterUpdates = []
    const personasMasterReset = []
    const personasMasterResetPredicates = []
    if (schema.personasMasterColumns.has('n_bienes_raices')) {
      personasMasterUpdates.push('n_bienes_raices = br.n_bienes_raices')
      personasMasterReset.push('n_bienes_raices = 0')
      personasMasterResetPredicates.push('COALESCE(pm.n_bienes_raices, 0) <> 0')
    }
    if (schema.personasMasterColumns.has('totalavaluos')) {
      personasMasterUpdates.push('totalavaluos = br.totalavaluos')
      personasMasterReset.push('totalavaluos = 0')
      personasMasterResetPredicates.push('COALESCE(pm.totalavaluos, 0) <> 0')
    }
    if (schema.personasMasterColumns.has('tiene_bienes_raices')) {
      personasMasterUpdates.push('tiene_bienes_raices = br.n_bienes_raices > 0')
      personasMasterReset.push('tiene_bienes_raices = FALSE')
      personasMasterResetPredicates.push('COALESCE(pm.tiene_bienes_raices, FALSE)')
    }
    if (schema.personasMasterColumns.has('updated_at')) {
      personasMasterUpdates.push('updated_at = NOW()')
      personasMasterReset.push('updated_at = NOW()')
    }
    if (schema.personasMasterColumns.has('loaded_at')) {
      personasMasterUpdates.push('loaded_at = NOW()')
      personasMasterReset.push('loaded_at = NOW()')
    }

    if (personasMasterUpdates.length > 0) {
      log('reseteando personas_master sin propiedades...')
      if (personasMasterReset.length > 0 && personasMasterResetPredicates.length > 0) {
        await client.query(`
          UPDATE public.personas_master pm
          SET
            ${personasMasterReset.join(', ')}
          WHERE (${personasMasterResetPredicates.join(' OR ')})
            AND NOT EXISTS (
              SELECT 1
              FROM bbrr_rollup br
              WHERE br.rutid = pm.rutid
            )
        `)
      }

      log('actualizando personas_master con rollup BBRR...')
      await client.query(`
        UPDATE public.personas_master pm
        SET
          ${personasMasterUpdates.join(', ')}
        FROM bbrr_rollup br
        WHERE pm.rutid = br.rutid
      `)
    }

    if (args.refreshStats) {
      log('refrescando vistas materializadas...')
      await refreshStats(client)
    }

    log('rollups BBRR completados')
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch(error => {
  console.error(`\nFallo en refresh-bbrr-rollups: ${error.message}`)
  process.exit(1)
})
