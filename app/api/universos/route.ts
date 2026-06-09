import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import { refreshStats } from '@/lib/services/dashboard'
import { Pool } from 'pg'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

let pool: Pool | null = null

const STATIC_DIMENSIONS = [
  { key: 'con_nombre', label: 'Nombre Completo', description: 'Nombre o razón social disponible', source: 'master' },
  { key: 'con_fono', label: 'Teléfono Celular', description: 'Teléfono disponible en el universo base', source: 'master' },
  { key: 'con_email', label: 'Correo Electrónico', description: 'Correo disponible en el universo base', source: 'master' },
  { key: 'con_domicilio', label: 'Domicilio Conocido', description: 'Región, comuna o dirección disponible', source: 'master' },
  { key: 'con_autos', label: 'Tiene Vehículos', description: 'Cruce con automóviles consolidado', source: 'master' },
  { key: 'con_bienes_raices', label: 'Bienes Raíces', description: 'Cruce con propiedades o avalúos', source: 'master' },
  { key: 'con_empresa', label: 'Dueño de Empresa', description: 'Cruce con razón social o empresa', source: 'master' },
] as const

const SKIPPED_DATASET_SLUGS = new Set([
  'master_personas',
  'padron_2024',
  'automoviles2025',
  'bbrr_propiedades',
  'empresas_comercial_unificada',
  'domicilio_resumen',
  'empresa_resumen',
  'pernat_resumen',
  'acumulado_resumen',
  'autos_resumen',
])

type DatasetDimension = {
  key: string
  label: string
  description: string | null
  source: 'dataset'
  slug: string
  table_name: string
  record_count: number
  last_loaded_at: string | null
}

function getPostgresConnectionString() {
  const connectionString = process.env.POSTGRES_URL_NON_POOLING
    ?? process.env.POSTGRES_URL
    ?? process.env.DATABASE_URL
    ?? process.env.SUPABASE_DB_URL

  if (!connectionString) return null

  const url = new URL(connectionString)
  url.searchParams.set('sslmode', 'require')
  url.searchParams.set('uselibpqcompat', 'true')
  return url.toString()
}

function getPool() {
  if (!pool) {
    const connectionString = getPostgresConnectionString()
    if (!connectionString) return null
    pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10000 })
  }

  return pool
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`
}

function normalizeRutExpression(alias: string) {
  return `lpad(regexp_replace(upper(coalesce(${alias}.rutid::text, '')), '[^0-9K]', '', 'g'), 10, '0')`
}

function toDimensionKey(slug: string) {
  return `dataset_${slug
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')}`
}

async function ensureUniverseSyncTables(pgPool: Pool) {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS public.universe_dataset_dimensions (
      key text PRIMARY KEY,
      slug text NOT NULL,
      label text NOT NULL,
      description text,
      table_name text NOT NULL,
      record_count bigint NOT NULL DEFAULT 0,
      last_loaded_at timestamptz,
      is_active boolean NOT NULL DEFAULT true,
      refreshed_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS public.stats_universos_dynamic (
      entidad_tipo text NOT NULL,
      con_nombre boolean NOT NULL,
      con_email boolean NOT NULL,
      con_fono boolean NOT NULL,
      con_autos boolean NOT NULL,
      con_empresa boolean NOT NULL,
      con_domicilio boolean NOT NULL,
      con_bienes_raices boolean NOT NULL,
      dataset_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
      trabajadores_bucket text NOT NULL DEFAULT 'sin_datos',
      facturacion_bucket text NOT NULL DEFAULT 'sin_datos',
      tamano_empresa_bucket text NOT NULL DEFAULT 'sin_segmento',
      tendencia_bucket text NOT NULL DEFAULT 'sin_datos',
      patrimonio_bucket text NOT NULL DEFAULT 'sin_datos',
      region_bucket text NOT NULL DEFAULT 'sin_region',
      total bigint NOT NULL,
      refreshed_at timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE public.stats_universos_dynamic
      ADD COLUMN IF NOT EXISTS trabajadores_bucket text NOT NULL DEFAULT 'sin_datos',
      ADD COLUMN IF NOT EXISTS facturacion_bucket text NOT NULL DEFAULT 'sin_datos',
      ADD COLUMN IF NOT EXISTS tamano_empresa_bucket text NOT NULL DEFAULT 'sin_segmento',
      ADD COLUMN IF NOT EXISTS tendencia_bucket text NOT NULL DEFAULT 'sin_datos',
      ADD COLUMN IF NOT EXISTS patrimonio_bucket text NOT NULL DEFAULT 'sin_datos',
      ADD COLUMN IF NOT EXISTS region_bucket text NOT NULL DEFAULT 'sin_region';

    CREATE INDEX IF NOT EXISTS idx_stats_universos_dynamic_entity
      ON public.stats_universos_dynamic (entidad_tipo);

    ALTER TABLE public.universe_dataset_dimensions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.stats_universos_dynamic ENABLE ROW LEVEL SECURITY;
  `)
}

async function discoverDatasetDimensions(pgPool: Pool): Promise<DatasetDimension[]> {
  const { rows } = await pgPool.query(`
    SELECT
      ds.slug,
      ds.name,
      ds.description,
      ds.canonical_table,
      COALESCE(ds.record_count, ds.latest_loaded_row_count, 0) AS record_count,
      COALESCE(ds.latest_version_completed_at, ds.last_loaded_at, ds.updated_at, ds.created_at) AS last_loaded_at
    FROM public.dataset_overview ds
    JOIN pg_catalog.pg_class cls
      ON cls.relname = ds.canonical_table
     AND cls.relkind IN ('r', 'p', 'v', 'm')
    JOIN pg_catalog.pg_namespace ns
      ON ns.oid = cls.relnamespace
     AND ns.nspname = 'public'
    JOIN pg_catalog.pg_attribute attr
      ON attr.attrelid = cls.oid
     AND attr.attname = 'rutid'
     AND attr.attnum > 0
     AND NOT attr.attisdropped
    WHERE ds.is_active = true
      AND ds.canonical_table IS NOT NULL
      AND COALESCE(ds.last_job_status, ds.latest_version_status, 'completed') <> 'failed'
      AND COALESCE(ds.record_count, ds.latest_loaded_row_count, 0) > 0
    ORDER BY COALESCE(ds.latest_version_completed_at, ds.last_loaded_at, ds.updated_at, ds.created_at) DESC NULLS LAST
  `)

  return rows
    .filter(row => row.slug && row.canonical_table && !SKIPPED_DATASET_SLUGS.has(row.slug))
    .map(row => ({
      key: toDimensionKey(row.slug),
      label: row.name,
      description: row.description,
      source: 'dataset',
      slug: row.slug,
      table_name: row.canonical_table,
      record_count: Number(row.record_count ?? 0),
      last_loaded_at: row.last_loaded_at ? new Date(row.last_loaded_at).toISOString() : null,
    }))
}

async function getDatasetDimensions(pgPool: Pool) {
  await ensureUniverseSyncTables(pgPool)
  const { rows } = await pgPool.query(`
    SELECT key, slug, label, description, table_name, record_count, last_loaded_at
    FROM public.universe_dataset_dimensions
    WHERE is_active = true
    ORDER BY last_loaded_at DESC NULLS LAST, label ASC
  `)

  return rows.map(row => ({
    key: row.key,
    label: row.label,
    description: row.description,
    source: 'dataset',
    slug: row.slug,
    table_name: row.table_name,
    record_count: Number(row.record_count ?? 0),
    last_loaded_at: row.last_loaded_at ? new Date(row.last_loaded_at).toISOString() : null,
  }))
}

async function getUpdatedUniversos() {
  const pgPool = getPool()
  if (!pgPool) return null

  await ensureUniverseSyncTables(pgPool)

  const { rows: dynamicRows } = await pgPool.query(`
    SELECT
      entidad_tipo,
      con_nombre,
      con_email,
      con_fono,
      con_autos,
      con_empresa,
      con_domicilio,
      con_bienes_raices,
      dataset_flags,
      trabajadores_bucket,
      facturacion_bucket,
      tamano_empresa_bucket,
      tendencia_bucket,
      patrimonio_bucket,
      region_bucket,
      total::bigint,
      refreshed_at
    FROM public.stats_universos_dynamic
  `)

  if (dynamicRows.length > 0) {
    return dynamicRows.map(row => ({
      ...row,
      dataset_flags: row.dataset_flags ?? {},
      total: Number(row.total ?? 0),
      refreshed_at: row.refreshed_at ? new Date(row.refreshed_at).toISOString() : null,
    }))
  }

  const { rows } = await pgPool.query(`
    WITH persona_rows AS (
      SELECT
        entidad_tipo::text,
        con_nombre,
        con_email,
        con_fono,
        con_autos,
        con_empresa,
        con_domicilio,
        con_bienes_raices,
        total::bigint
      FROM public.stats_universos
      WHERE entidad_tipo <> 'persona_juridica'
    ),
    empresa_rows AS (
      SELECT
        entidad_tipo::text,
        con_nombre,
        con_email,
        con_fono,
        con_autos,
        con_empresa,
        con_domicilio,
        con_bienes_raices,
        total::bigint
      FROM public.stats_universos_empresas
    )
    SELECT *
    FROM persona_rows
    UNION ALL
    SELECT *
    FROM empresa_rows
  `)

  return rows.map(row => ({
    ...row,
    dataset_flags: {},
    total: Number(row.total ?? 0),
  }))
}

async function refreshDynamicUniverseMatrix() {
  const pgPool = getPool()
  if (!pgPool) return null

  await ensureUniverseSyncTables(pgPool)
  const dimensions = await discoverDatasetDimensions(pgPool)

  const datasetCtes = dimensions.map(dim => {
    const tableName = quoteIdentifier(dim.table_name)
    return `${quoteIdentifier(dim.key)} AS (
      SELECT DISTINCT ${normalizeRutExpression('d')} AS rut_key
      FROM public.${tableName} d
      WHERE d.rutid IS NOT NULL
        AND ${normalizeRutExpression('d')} <> '0000000000'
    )`
  })

  const joins = dimensions.map(dim =>
    `LEFT JOIN ${quoteIdentifier(dim.key)} ${quoteIdentifier(`${dim.key}_m`)}
      ON ${quoteIdentifier(`${dim.key}_m`)}.rut_key = b.rut_key`
  )

  const flagPairs = dimensions.flatMap(dim => [
    `'${dim.key}'`,
    `${quoteIdentifier(`${dim.key}_m`)}.rut_key IS NOT NULL`,
  ])

  const flagGroupings = dimensions.map(dim => `${quoteIdentifier(`${dim.key}_m`)}.rut_key IS NOT NULL`)

  await pgPool.query('BEGIN')
  try {
    await pgPool.query('SET LOCAL statement_timeout = 0')
    await pgPool.query('TRUNCATE public.universe_dataset_dimensions')

    for (const dim of dimensions) {
      await pgPool.query(
        `INSERT INTO public.universe_dataset_dimensions
          (key, slug, label, description, table_name, record_count, last_loaded_at, is_active, refreshed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, now())`,
        [dim.key, dim.slug, dim.label, dim.description, dim.table_name, dim.record_count, dim.last_loaded_at]
      )
    }

    await pgPool.query('TRUNCATE public.stats_universos_dynamic')
    await pgPool.query(`
      INSERT INTO public.stats_universos_dynamic (
        entidad_tipo,
        con_nombre,
        con_email,
        con_fono,
        con_autos,
        con_empresa,
        con_domicilio,
        con_bienes_raices,
        dataset_flags,
        trabajadores_bucket,
        facturacion_bucket,
        tamano_empresa_bucket,
        tendencia_bucket,
        patrimonio_bucket,
        region_bucket,
        total,
        refreshed_at
      )
      WITH base AS (
        SELECT
          ${normalizeRutExpression('p')} AS rut_key,
          p.entidad_tipo::text,
          p.con_nombre_real AS con_nombre,
          (NULLIF(BTRIM(p.email), '') IS NOT NULL) AS con_email,
          (NULLIF(BTRIM(p.fono_cel), '') IS NOT NULL) AS con_fono,
          (p.n_autos > 0) AS con_autos,
          (NULLIF(BTRIM(p.razon_social_empresa), '') IS NOT NULL) AS con_empresa,
          (
            COALESCE(
              NULLIF(BTRIM(p.region_part), ''),
              NULLIF(BTRIM(p.comuna_part), ''),
              NULLIF(BTRIM(p.domicilio_region), ''),
              NULLIF(BTRIM(p.domicilio_comuna), '')
            ) IS NOT NULL
          ) AS con_domicilio,
          (COALESCE(p.n_bienes_raices, 0) > 0 OR COALESCE(p.totalavaluos, 0) > 0) AS con_bienes_raices,
          'sin_datos'::text AS trabajadores_bucket,
          'sin_datos'::text AS facturacion_bucket,
          'sin_segmento'::text AS tamano_empresa_bucket,
          'sin_datos'::text AS tendencia_bucket,
          CASE
            WHEN COALESCE(p.score_patrimonial, 0) = 0 THEN '0'
            WHEN COALESCE(p.score_patrimonial, 0) BETWEEN 1 AND 20 THEN '1-20'
            WHEN COALESCE(p.score_patrimonial, 0) BETWEEN 21 AND 40 THEN '21-40'
            WHEN COALESCE(p.score_patrimonial, 0) BETWEEN 41 AND 60 THEN '41-60'
            WHEN COALESCE(p.score_patrimonial, 0) BETWEEN 61 AND 80 THEN '61-80'
            ELSE '81+'
          END AS patrimonio_bucket,
          COALESCE(
            NULLIF(BTRIM(p.region_part), ''),
            NULLIF(BTRIM(p.domicilio_region), ''),
            'sin_region'
          ) AS region_bucket
        FROM public.personas_master_clasificada p
        WHERE p.entidad_tipo <> 'persona_juridica'

        UNION ALL

        SELECT
          ${normalizeRutExpression('e')} AS rut_key,
          'persona_juridica'::text AS entidad_tipo,
          (NULLIF(BTRIM(e.razon_social), '') IS NOT NULL) AS con_nombre,
          (NULLIF(BTRIM(e.email), '') IS NOT NULL) AS con_email,
          (NULLIF(BTRIM(e.fono_cel), '') IS NOT NULL) AS con_fono,
          (COALESCE(e.n_autos, 0) > 0) AS con_autos,
          true AS con_empresa,
          (
            COALESCE(
              NULLIF(BTRIM(e.domicilio_direccion), ''),
              NULLIF(BTRIM(e.region), ''),
              NULLIF(BTRIM(e.comuna), '')
            ) IS NOT NULL
          ) AS con_domicilio,
          (COALESCE(e.n_bienes_raices, 0) > 0 OR COALESCE(e.totalavaluos, 0) > 0) AS con_bienes_raices,
          CASE
            WHEN e.trabajadores_2024 IS NULL THEN 'sin_datos'
            WHEN e.trabajadores_2024 = 0 THEN '0'
            WHEN e.trabajadores_2024 BETWEEN 1 AND 9 THEN '1-9'
            WHEN e.trabajadores_2024 BETWEEN 10 AND 49 THEN '10-49'
            WHEN e.trabajadores_2024 BETWEEN 50 AND 199 THEN '50-199'
            WHEN e.trabajadores_2024 BETWEEN 200 AND 499 THEN '200-499'
            ELSE '500+'
          END AS trabajadores_bucket,
          CASE
            WHEN e.ultimo_tramo_ventas IS NULL THEN 'sin_datos'
            WHEN e.ultimo_tramo_ventas BETWEEN 1 AND 5 THEN 'T1-T5'
            WHEN e.ultimo_tramo_ventas BETWEEN 6 AND 7 THEN 'T6-T7'
            WHEN e.ultimo_tramo_ventas BETWEEN 8 AND 9 THEN 'T8-T9'
            WHEN e.ultimo_tramo_ventas BETWEEN 10 AND 12 THEN 'T10-T12'
            ELSE 'T13+'
          END AS facturacion_bucket,
          COALESCE(NULLIF(BTRIM(e.segmento_tamano_empresa), ''), 'sin_segmento') AS tamano_empresa_bucket,
          COALESCE(NULLIF(BTRIM(e.resultado_tendencia), ''), 'sin_datos') AS tendencia_bucket,
          CASE
            WHEN COALESCE(e.score_patrimonial, 0) = 0 THEN '0'
            WHEN COALESCE(e.score_patrimonial, 0) BETWEEN 1 AND 20 THEN '1-20'
            WHEN COALESCE(e.score_patrimonial, 0) BETWEEN 21 AND 40 THEN '21-40'
            WHEN COALESCE(e.score_patrimonial, 0) BETWEEN 41 AND 60 THEN '41-60'
            WHEN COALESCE(e.score_patrimonial, 0) BETWEEN 61 AND 80 THEN '61-80'
            ELSE '81+'
          END AS patrimonio_bucket,
          COALESCE(NULLIF(BTRIM(e.region), ''), 'sin_region') AS region_bucket
        FROM public.empresas_comercial_unificada e
        WHERE COALESCE(e.es_universo_operativo_ventas, true) = true
      )
      ${datasetCtes.length > 0 ? `, ${datasetCtes.join(',\n')}` : ''}
      SELECT
        b.entidad_tipo,
        b.con_nombre,
        b.con_email,
        b.con_fono,
        b.con_autos,
        b.con_empresa,
        b.con_domicilio,
        b.con_bienes_raices,
        ${flagPairs.length > 0 ? `jsonb_build_object(${flagPairs.join(', ')})` : `'{}'::jsonb`} AS dataset_flags,
        b.trabajadores_bucket,
        b.facturacion_bucket,
        b.tamano_empresa_bucket,
        b.tendencia_bucket,
        b.patrimonio_bucket,
        b.region_bucket,
        COUNT(*)::bigint AS total,
        now() AS refreshed_at
      FROM base b
      ${joins.join('\n')}
      GROUP BY
        b.entidad_tipo,
        b.con_nombre,
        b.con_email,
        b.con_fono,
        b.con_autos,
        b.con_empresa,
        b.con_domicilio,
        b.con_bienes_raices,
        b.trabajadores_bucket,
        b.facturacion_bucket,
        b.tamano_empresa_bucket,
        b.tendencia_bucket,
        b.patrimonio_bucket,
        b.region_bucket
        ${flagGroupings.length > 0 ? `,\n        ${flagGroupings.join(',\n        ')}` : ''}
    `)

    await pgPool.query('COMMIT')
    return dimensions
  } catch (error) {
    await pgPool.query('ROLLBACK')
    throw error
  }
}

async function getStoredUniversos(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>) {
  const { data, error } = await supabase
    .from('stats_universos')
    .select('*')

  if (error) throw error
  return (data as Record<string, unknown>[] | null)?.map(row => ({ ...row, dataset_flags: {} }))
}

export async function GET(req: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    // if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const pgPool = getPool()
    const data = await getUpdatedUniversos() ?? await getStoredUniversos(supabase)
    const datasetDimensions = pgPool ? await getDatasetDimensions(pgPool) : []

    return NextResponse.json({
      success: true,
      data,
      dimensions: [...STATIC_DIMENSIONS, ...datasetDimensions],
      synced_at: data?.[0]?.refreshed_at ?? null,
    })
  } catch (error) {
    console.error('[API/Universos]', error)
    return NextResponse.json({ success: false, error: 'Internal Server Error' }, { status: 500 })
  }
}

export async function POST() {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    await refreshStats()
    const datasetDimensions = await refreshDynamicUniverseMatrix()

    const data = await getUpdatedUniversos() ?? await getStoredUniversos(supabase)

    return NextResponse.json({
      success: true,
      data,
      dimensions: [...STATIC_DIMENSIONS, ...(datasetDimensions ?? [])],
      synced_at: data?.[0]?.refreshed_at ?? null,
    })
  } catch (error) {
    console.error('[API/Universos refresh]', error)
    return NextResponse.json({ success: false, error: 'Internal Server Error' }, { status: 500 })
  }
}
