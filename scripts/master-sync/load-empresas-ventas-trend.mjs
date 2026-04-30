import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import { Client } from 'pg'
import { from as copyFrom } from 'pg-copy-streams'

const DEFAULT_CSV = path.resolve(
  process.cwd(),
  'exports/empresas/empresas_tendencia_ventas_2020_2024.csv'
)
const TABLE = 'empresas_ventas_tendencia'
const COPY_COLUMNS = [
  'rut',
  'dv',
  'razon_social_ultima',
  'anio_ultimo',
  'tipo_contribuyente_ultimo',
  'subtipo_contribuyente_ultimo',
  'rubro_economico_ultimo',
  'subrubro_economico_ultimo',
  'actividad_economica_ultima',
  'region_ultima',
  'provincia_ultima',
  'comuna_ultima',
  'fecha_termino_giro_ultima',
  'tramo_ventas_2020',
  'tramo_ventas_2021',
  'tramo_ventas_2022',
  'tramo_ventas_2023',
  'tramo_ventas_2024',
  'trabajadores_2020',
  'trabajadores_2021',
  'trabajadores_2022',
  'trabajadores_2023',
  'trabajadores_2024',
  'anios_con_tramo',
  'primer_anio_con_tramo',
  'ultimo_anio_con_tramo',
  'primer_tramo_ventas',
  'ultimo_tramo_ventas',
  'tramo_ventas_promedio_2020_2024',
  'cambio_promedio_anual_tramo',
  'pendiente_tendencia_tramo',
  'movimientos_alza',
  'movimientos_baja',
  'resultado_tendencia',
]

function parseArgs(argv) {
  const args = {
    file: DEFAULT_CSV,
    skipMetadata: false,
    metadataOnly: false,
  }

  for (const rawArg of argv) {
    if (rawArg.startsWith('--file=')) {
      args.file = path.resolve(rawArg.split('=').slice(1).join('='))
    } else if (rawArg === '--skip-metadata') {
      args.skipMetadata = true
    } else if (rawArg === '--metadata-only') {
      args.metadataOnly = true
    }
  }

  return args
}

function quoteIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`
}

function columnsSql(columns) {
  return columns.map(quoteIdentifier).join(', ')
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

function sanitizeConnectionString(connectionString) {
  try {
    const url = new URL(connectionString)
    for (const key of [
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
  } catch {
    return connectionString
  }
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
      'Faltan credenciales Postgres. Define DATABASE_URL/SUPABASE_DB_URL o SUPABASE_DB_HOST, SUPABASE_DB_USER y SUPABASE_DB_PASSWORD.'
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

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.${quoteIdentifier(TABLE)} (
      rut text not null,
      dv text not null,
      rutid text generated always as (rut || dv) stored,
      razon_social_ultima text,
      anio_ultimo integer,
      tipo_contribuyente_ultimo text,
      subtipo_contribuyente_ultimo text,
      rubro_economico_ultimo text,
      subrubro_economico_ultimo text,
      actividad_economica_ultima text,
      region_ultima text,
      provincia_ultima text,
      comuna_ultima text,
      fecha_termino_giro_ultima date,
      tramo_ventas_2020 integer,
      tramo_ventas_2021 integer,
      tramo_ventas_2022 integer,
      tramo_ventas_2023 integer,
      tramo_ventas_2024 integer,
      trabajadores_2020 integer,
      trabajadores_2021 integer,
      trabajadores_2022 integer,
      trabajadores_2023 integer,
      trabajadores_2024 integer,
      anios_con_tramo integer,
      primer_anio_con_tramo integer,
      ultimo_anio_con_tramo integer,
      primer_tramo_ventas integer,
      ultimo_tramo_ventas integer,
      tramo_ventas_promedio_2020_2024 numeric(10,2),
      cambio_promedio_anual_tramo numeric(10,4),
      pendiente_tendencia_tramo numeric(10,4),
      movimientos_alza integer,
      movimientos_baja integer,
      resultado_tendencia text not null,
      loaded_at timestamptz not null default now(),
      constraint empresas_ventas_tendencia_resultado_check
        check (resultado_tendencia in ('sube', 'baja', 'estable', 'sin_datos'))
    )
  `)
}

async function dropIndexes(client) {
  const indexes = [
    'idx_empresas_ventas_tendencia_rutid',
    'idx_empresas_ventas_tendencia_resultado',
    'idx_empresas_ventas_tendencia_region',
    'idx_empresas_ventas_tendencia_rubro',
    'idx_empresas_ventas_tendencia_ultimo_anio',
    'idx_empresas_ventas_tendencia_pendiente',
  ]

  for (const index of indexes) {
    await client.query(`DROP INDEX IF EXISTS public.${quoteIdentifier(index)}`)
  }
}

async function createIndexes(client) {
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_ventas_tendencia_rutid
      ON public.${quoteIdentifier(TABLE)} (rutid)
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_empresas_ventas_tendencia_resultado
      ON public.${quoteIdentifier(TABLE)} (resultado_tendencia)
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_empresas_ventas_tendencia_region
      ON public.${quoteIdentifier(TABLE)} (region_ultima)
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_empresas_ventas_tendencia_rubro
      ON public.${quoteIdentifier(TABLE)} (rubro_economico_ultimo)
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_empresas_ventas_tendencia_ultimo_anio
      ON public.${quoteIdentifier(TABLE)} (anio_ultimo)
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_empresas_ventas_tendencia_pendiente
      ON public.${quoteIdentifier(TABLE)} (pendiente_tendencia_tramo)
  `)
}

async function copyCsv(client, csvPath) {
  const copySql = `
    COPY public.${quoteIdentifier(TABLE)} (${columnsSql(COPY_COLUMNS)})
    FROM STDIN WITH (FORMAT csv, HEADER true, NULL '')
  `
  const copyStream = client.query(copyFrom(copySql))
  await pipeline(fs.createReadStream(csvPath), copyStream)
}

async function syncMetadata(client, csvPath, rowCount, fileSize, skipMetadata) {
  if (skipMetadata) return

  try {
    await client.query(
      `
        INSERT INTO public.data_sources (
          name,
          slug,
          description,
          source_type,
          canonical_table,
          source_table_name,
          primary_key_column,
          supports_incremental,
          is_active,
          record_count,
          last_loaded_at,
          last_job_status
        )
        VALUES (
          'Empresas tendencia ventas 2020-2024',
          'empresas_ventas_tendencia',
          'Tendencia anual de tramo de ventas por RUT empresa calculada desde PUB_EMPRESAS_PJ_2020_A_2024.',
          'csv',
          'empresas_ventas_tendencia',
          'empresas_ventas_tendencia',
          'rutid',
          false,
          true,
          $1,
          now(),
          'completed'
        )
        ON CONFLICT (slug) DO UPDATE SET
          record_count = EXCLUDED.record_count,
          last_loaded_at = now(),
          last_job_status = 'completed',
          canonical_table = EXCLUDED.canonical_table,
          source_table_name = EXCLUDED.source_table_name,
          primary_key_column = EXCLUDED.primary_key_column,
          supports_incremental = EXCLUDED.supports_incremental,
          updated_at = now()
      `,
      [rowCount]
    )

    await client.query(
      `
        SELECT finalize_source_version(
          $1, $2, 'replace', $3, $4, $5, 0, 0, 'completed', NULL,
          jsonb_build_object(
            'csv_file', $6::text,
            'file_size_bytes', $7::bigint,
            'target_table', $8::text,
            'transport', 'pg_copy_direct'
          )
        )
      `,
      [
        'empresas_ventas_tendencia',
        `empresas_ventas_tendencia-${new Date().toISOString()}`,
        rowCount,
        rowCount,
        rowCount,
        csvPath,
        fileSize,
        TABLE,
      ]
    )
  } catch (error) {
    console.warn(`[metadata] No se pudo registrar source/version: ${error.message}`)
  }
}

async function refreshDerivedViews(client) {
  const statsView = await client.query(
    "SELECT to_regclass('public.empresas_ventas_tendencia_stats') AS name"
  )

  if (statsView.rows[0]?.name) {
    await client.query('REFRESH MATERIALIZED VIEW public.empresas_ventas_tendencia_stats')
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(args.file)) {
    throw new Error(`CSV no encontrado: ${args.file}`)
  }

  const fileStats = fs.statSync(args.file)
  const client = new Client(resolvePgConfig())

  await client.connect()
  await client.query('SET statement_timeout = 0')
  await client.query('SET lock_timeout = 0')
  await client.query('SET maintenance_work_mem = "512MB"').catch(() => {})

  try {
    log(`Preparando tabla public.${TABLE}`)
    await ensureTable(client)

    if (args.metadataOnly) {
      const countRes = await client.query(
        `SELECT COUNT(*)::BIGINT AS count FROM public.${quoteIdentifier(TABLE)}`
      )
      const rowCount = Number(countRes.rows[0]?.count ?? 0)
      await syncMetadata(client, args.file, rowCount, fileStats.size, false)
      log(`OK metadata: ${rowCount.toLocaleString('es-CL')} filas registradas para public.${TABLE}`)
      return
    }

    log('Botando indices para cargar mas rapido')
    await dropIndexes(client)

    log(`TRUNCATE public.${TABLE}`)
    await client.query(`TRUNCATE TABLE public.${quoteIdentifier(TABLE)}`)

    log(`COPY directo desde ${args.file}`)
    await copyCsv(client, args.file)

    log('Recreando indices')
    await createIndexes(client)

    log('ANALYZE')
    await client.query(`ANALYZE public.${quoteIdentifier(TABLE)}`)

    log('Refrescando resumen de tendencias')
    await refreshDerivedViews(client)

    const countRes = await client.query(
      `SELECT COUNT(*)::BIGINT AS count FROM public.${quoteIdentifier(TABLE)}`
    )
    const rowCount = Number(countRes.rows[0]?.count ?? 0)
    await syncMetadata(client, args.file, rowCount, fileStats.size, args.skipMetadata)

    log(`OK: ${rowCount.toLocaleString('es-CL')} filas cargadas en public.${TABLE}`)
  } finally {
    await client.end()
  }
}

main().catch(error => {
  console.error(`\nFallo en load-empresas-ventas-trend: ${error.message}`)
  process.exitCode = 1
})
