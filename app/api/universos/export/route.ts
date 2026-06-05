import { NextRequest, NextResponse } from 'next/server'
import { Pool, type PoolClient } from 'pg'
import { createSupabaseServerClient } from '@/lib/db/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const BATCH_SIZE = 5000

const STATIC_FILTER_KEYS = new Set([
  'con_nombre',
  'con_fono',
  'con_email',
  'con_domicilio',
  'con_autos',
  'con_bienes_raices',
  'con_empresa',
])

const ENTITY_FILTERS = new Set([
  'todos',
  'persona_natural',
  'persona_juridica',
  'indeterminado',
  'rut_recuperable',
  'basura',
])

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

const BASE_EXPORT_HEADERS = [
  'rutid',
  'entidad_tipo',
  'nombre_o_razon_social',
  'email',
  'fono_cel',
  'region',
  'comuna',
  'direccion',
  'n_autos',
  'n_bienes_raices',
  'totalavaluos',
  'razon_social_empresa',
  'rubro',
  'subrubro',
  'tamano_empresa',
  'tramo_ventas_ultimo',
  'score_patrimonial',
  'cobertura_pct',
  'con_nombre',
  'con_fono',
  'con_email',
  'con_domicilio',
  'con_autos',
  'con_bienes_raices',
  'con_empresa',
]

type DatasetDimension = {
  key: string
  label: string
  slug: string
  table_name: string
}

type ExportBody = {
  entityFilter?: string
  filters?: Record<string, boolean | null | undefined>
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

function createPool() {
  const connectionString = getPostgresConnectionString()
  if (!connectionString) return null
  return new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10000 })
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

function csvEscape(value: unknown) {
  if (value === null || value === undefined) return ''
  const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (/[",\n\r]/.test(stringValue)) return `"${stringValue.replace(/"/g, '""')}"`
  return stringValue
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function discoverDatasetDimensions(client: PoolClient): Promise<DatasetDimension[]> {
  const { rows } = await client.query(`
    SELECT
      ds.slug,
      ds.name,
      ds.canonical_table
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
      slug: row.slug,
      table_name: row.canonical_table,
    }))
}

function buildDatasetCtes(dimensions: DatasetDimension[]) {
  return dimensions.map(dim => {
    const tableName = quoteIdentifier(dim.table_name)
    return `${quoteIdentifier(dim.key)} AS (
      SELECT DISTINCT ${normalizeRutExpression('d')} AS rut_key
      FROM public.${tableName} d
      WHERE d.rutid IS NOT NULL
        AND ${normalizeRutExpression('d')} <> '0000000000'
    )`
  })
}

function buildDatasetJoins(dimensions: DatasetDimension[]) {
  return dimensions.map(dim =>
    `LEFT JOIN ${quoteIdentifier(dim.key)} ${quoteIdentifier(`${dim.key}_m`)}
      ON ${quoteIdentifier(`${dim.key}_m`)}.rut_key = b.rut_key`
  )
}

function buildDatasetSelects(dimensions: DatasetDimension[]) {
  return dimensions.map(dim => {
    const alias = quoteIdentifier(`${dim.key}_m`)
    const column = quoteIdentifier(`dataset_${dim.slug}`)
    return `(${alias}.rut_key IS NOT NULL) AS ${column}`
  })
}

function buildExportQuery(
  dimensions: DatasetDimension[],
  entityFilter: string,
  filters: Record<string, boolean | null | undefined>,
  cursor: { rutKey: string; entityType: string } | null
) {
  const datasetKeys = new Set(dimensions.map(dim => dim.key))
  const params: unknown[] = []
  const whereClauses: string[] = []

  if (entityFilter !== 'todos') {
    params.push(entityFilter)
    whereClauses.push(`b.entidad_tipo = $${params.length}`)
  }

  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === undefined) continue

    if (STATIC_FILTER_KEYS.has(key)) {
      whereClauses.push(`b.${quoteIdentifier(key)} = ${value ? 'true' : 'false'}`)
      continue
    }

    if (datasetKeys.has(key)) {
      const alias = quoteIdentifier(`${key}_m`)
      whereClauses.push(`${alias}.rut_key IS ${value ? 'NOT ' : ''}NULL`)
    }
  }

  if (cursor) {
    params.push(cursor.rutKey, cursor.entityType)
    whereClauses.push(`(b.rut_key, b.entidad_tipo) > ($${params.length - 1}, $${params.length})`)
  }

  params.push(BATCH_SIZE)

  const datasetCtes = buildDatasetCtes(dimensions)
  const datasetSelects = buildDatasetSelects(dimensions)
  const datasetJoins = buildDatasetJoins(dimensions)
  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join('\n        AND ')}` : ''

  const sql = `
    WITH base AS (
      SELECT
        ${normalizeRutExpression('p')} AS rut_key,
        p.rutid,
        p.entidad_tipo::text AS entidad_tipo,
        p.nombre_completo AS nombre_o_razon_social,
        p.email,
        p.fono_cel,
        COALESCE(NULLIF(BTRIM(p.region_canonica), ''), NULLIF(BTRIM(p.region_part), ''), NULLIF(BTRIM(p.domicilio_region), '')) AS region,
        COALESCE(NULLIF(BTRIM(p.comuna_canonica), ''), NULLIF(BTRIM(p.comuna_part), ''), NULLIF(BTRIM(p.domicilio_comuna), '')) AS comuna,
        NULL::text AS direccion,
        p.n_autos,
        p.n_bienes_raices,
        p.totalavaluos,
        p.razon_social_empresa,
        NULL::text AS rubro,
        NULL::text AS subrubro,
        NULL::text AS tamano_empresa,
        NULL::text AS tramo_ventas_ultimo,
        p.score_patrimonial,
        p.cobertura_pct,
        p.con_nombre_real AS con_nombre,
        (NULLIF(BTRIM(p.fono_cel), '') IS NOT NULL) AS con_fono,
        (NULLIF(BTRIM(p.email), '') IS NOT NULL) AS con_email,
        (
          COALESCE(
            NULLIF(BTRIM(p.region_part), ''),
            NULLIF(BTRIM(p.comuna_part), ''),
            NULLIF(BTRIM(p.domicilio_region), ''),
            NULLIF(BTRIM(p.domicilio_comuna), '')
          ) IS NOT NULL
        ) AS con_domicilio,
        (p.n_autos > 0) AS con_autos,
        (COALESCE(p.n_bienes_raices, 0) > 0 OR COALESCE(p.totalavaluos, 0) > 0) AS con_bienes_raices,
        (NULLIF(BTRIM(p.razon_social_empresa), '') IS NOT NULL) AS con_empresa
      FROM public.personas_master_clasificada p
      WHERE p.entidad_tipo <> 'persona_juridica'

      UNION ALL

      SELECT
        ${normalizeRutExpression('e')} AS rut_key,
        e.rutid,
        'persona_juridica'::text AS entidad_tipo,
        e.razon_social AS nombre_o_razon_social,
        e.email,
        e.fono_cel,
        e.region,
        e.comuna,
        e.domicilio_direccion AS direccion,
        e.n_autos,
        e.n_bienes_raices,
        e.totalavaluos,
        e.razon_social AS razon_social_empresa,
        e.rubro_economico_ultimo AS rubro,
        e.subrubro_economico_ultimo AS subrubro,
        e.segmento_tamano_empresa AS tamano_empresa,
        e.ultimo_tramo_ventas::text AS tramo_ventas_ultimo,
        e.score_patrimonial,
        e.cobertura_pct,
        (NULLIF(BTRIM(e.razon_social), '') IS NOT NULL) AS con_nombre,
        (NULLIF(BTRIM(e.fono_cel), '') IS NOT NULL) AS con_fono,
        (NULLIF(BTRIM(e.email), '') IS NOT NULL) AS con_email,
        (
          COALESCE(
            NULLIF(BTRIM(e.domicilio_direccion), ''),
            NULLIF(BTRIM(e.region), ''),
            NULLIF(BTRIM(e.comuna), '')
          ) IS NOT NULL
        ) AS con_domicilio,
        (COALESCE(e.n_autos, 0) > 0) AS con_autos,
        (COALESCE(e.n_bienes_raices, 0) > 0 OR COALESCE(e.totalavaluos, 0) > 0) AS con_bienes_raices,
        true AS con_empresa
      FROM public.empresas_comercial_unificada e
      WHERE COALESCE(e.es_universo_operativo_ventas, true) = true
    )
    ${datasetCtes.length > 0 ? `, ${datasetCtes.join(',\n')}` : ''}
    SELECT
      ${BASE_EXPORT_HEADERS.map(header => `b.${quoteIdentifier(header)}`).join(',\n      ')}
      ${datasetSelects.length > 0 ? `,\n      ${datasetSelects.join(',\n      ')}` : ''}
    FROM base b
    ${datasetJoins.join('\n')}
    ${whereSql}
    ORDER BY b.rut_key ASC, b.entidad_tipo ASC
    LIMIT $${params.length}
  `

  return { sql, params }
}

function validateExportRequest(
  dimensions: DatasetDimension[],
  entityFilter: string,
  filters: Record<string, boolean | null | undefined>
) {
  if (!ENTITY_FILTERS.has(entityFilter)) {
    return 'Tipo de universo no valido.'
  }

  const datasetKeys = new Set(dimensions.map(dim => dim.key))
  for (const [key, value] of Object.entries(filters)) {
    if (value !== true && value !== false && value !== null && value !== undefined) {
      return `Filtro invalido para ${key}.`
    }

    if (!STATIC_FILTER_KEYS.has(key) && !datasetKeys.has(key)) {
      return `Filtro desconocido: ${key}. Actualiza la matriz e intenta de nuevo.`
    }
  }

  return null
}

function getActiveDatasetDimensions(
  dimensions: DatasetDimension[],
  filters: Record<string, boolean | null | undefined>
) {
  const activeDatasetKeys = new Set(
    Object.entries(filters)
      .filter(([key, value]) => value !== null && value !== undefined && !STATIC_FILTER_KEYS.has(key))
      .map(([key]) => key)
  )

  return dimensions.filter(dim => activeDatasetKeys.has(dim.key))
}

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as ExportBody
  const entityFilter = body.entityFilter ?? 'persona_natural'
  const filters = body.filters ?? {}

  const pool = createPool()
  if (!pool) {
    return NextResponse.json(
      { error: 'No hay una conexion Postgres disponible para exportar.' },
      { status: 500 }
    )
  }

  let client: PoolClient | null = null
  try {
    client = await pool.connect()
    await client.query('SET statement_timeout = 0')
    const dimensions = await discoverDatasetDimensions(client)
    const validationError = validateExportRequest(dimensions, entityFilter, filters)

    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 })
    }

    const activeDatasetDimensions = getActiveDatasetDimensions(dimensions, filters)
    const encoder = new TextEncoder()
    const headers = [
      ...BASE_EXPORT_HEADERS,
      ...activeDatasetDimensions.map(dim => `dataset_${dim.slug}`),
    ]
    const fileName = `universo-${slugify(entityFilter)}-${new Date().toISOString().slice(0, 10)}.csv`

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let cursor: { rutKey: string; entityType: string } | null = null

        try {
          controller.enqueue(encoder.encode(`${headers.map(csvEscape).join(',')}\n`))

          while (true) {
            const { sql, params } = buildExportQuery(activeDatasetDimensions, entityFilter, filters, cursor)
            const result = await client!.query(sql, params)

            if (result.rows.length === 0) break

            const chunk = result.rows
              .map(row => headers.map(header => csvEscape(row[header])).join(','))
              .join('\n')

            controller.enqueue(encoder.encode(`${chunk}\n`))

            if (result.rows.length < BATCH_SIZE) break

            const lastRow = result.rows.at(-1)
            cursor = {
              rutKey: lastRow.rutid
                ? String(lastRow.rutid).replace(/[^0-9Kk]/g, '').toUpperCase().padStart(10, '0')
                : '',
              entityType: String(lastRow.entidad_tipo ?? ''),
            }

            if (!cursor.rutKey || !cursor.entityType) break
          }

          controller.close()
        } catch (error) {
          console.error('[universos/export][stream]', error)
          controller.error(error)
        } finally {
          client?.release()
          await pool.end()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    client?.release()
    await pool.end()
    console.error('[universos/export]', error)
    return NextResponse.json({ error: 'No se pudo exportar el universo.' }, { status: 500 })
  }
}
