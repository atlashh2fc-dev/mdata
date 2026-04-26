import { NextResponse } from 'next/server'
import { Pool, type PoolClient } from 'pg'
import { createSupabaseServerClient, db } from '@/lib/db/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const PREVIEW_LIMIT = 10

type PreviewSource = {
  id: string
  name?: string | null
  slug?: string | null
  canonical_table?: string | null
  source_table_name?: string | null
  primary_key_column?: string | null
}

type PreviewColumn = {
  source: string
  alias?: string
}

type PreviewPlan = {
  tableName: string
  orderColumn: string | null
  orderDirection?: 'ASC' | 'DESC'
  columns: PreviewColumn[] | null
  whereClause?: string
}

const DATASET_PREVIEW_FALLBACKS: Record<string, PreviewPlan> = {
  pernat_resumen: {
    tableName: 'personas_master',
    orderColumn: 'rutid',
    whereClause: `COALESCE(NULLIF(BTRIM("nombres"), ''), NULLIF(BTRIM("paterno"), ''), NULLIF(BTRIM("materno"), '')) IS NOT NULL`,
    columns: null,
  },
  autos_resumen: {
    tableName: 'personas_master',
    orderColumn: 'n_autos',
    orderDirection: 'DESC',
    whereClause: `"n_autos" > 0`,
    columns: [
      { source: 'rutid' },
      { source: 'n_autos' },
      { source: 'loaded_at' },
    ],
  },
  empresa_resumen: {
    tableName: 'personas_master',
    orderColumn: 'razon_social_empresa',
    whereClause: `"razon_social_empresa" IS NOT NULL`,
    columns: null,
  },
  domicilio_resumen: {
    tableName: 'personas_master',
    orderColumn: 'rutid',
    whereClause: `COALESCE(NULLIF(BTRIM("domicilio_comuna"), ''), NULLIF(BTRIM("domicilio_region"), '')) IS NOT NULL`,
    columns: null,
  },
  acumulado_resumen: {
    tableName: 'personas_master',
    orderColumn: 'n_bienes_raices',
    orderDirection: 'DESC',
    whereClause: `COALESCE("n_bienes_raices", 0) > 0 OR COALESCE("totalavaluos", 0) > 0`,
    columns: [
      { source: 'rutid' },
      { source: 'n_bienes_raices' },
      { source: 'totalavaluos' },
      { source: 'loaded_at' },
    ],
  },
}

function isValidIdentifier(value: string | null | undefined) {
  return Boolean(value && TABLE_NAME_PATTERN.test(value))
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`
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

  return new Pool({
    connectionString,
    max: 1,
  })
}

async function getSourceById(id: string): Promise<{
  source: PreviewSource | null
  error: unknown
}> {
  const overviewQuery = await db
    .from('dataset_overview')
    .select('id, name, slug, canonical_table, source_table_name, primary_key_column')
    .eq('id', id)
    .maybeSingle()

  if (overviewQuery.data) {
    return { source: overviewQuery.data as PreviewSource, error: null }
  }

  const fallbackQuery = await db
    .from('data_sources')
    .select('id, name, slug, canonical_table, source_table_name, primary_key_column')
    .eq('id', id)
    .maybeSingle()

  if (fallbackQuery.error) {
    return {
      source: null,
      error: {
        overview: overviewQuery.error,
        fallback: fallbackQuery.error,
      },
    }
  }

  return {
    source: (fallbackQuery.data as PreviewSource | null) ?? null,
    error: overviewQuery.error,
  }
}

function resolveTableName(source: PreviewSource) {
  const candidate = source.canonical_table ?? source.source_table_name ?? null
  if (!isValidIdentifier(candidate)) return null
  return candidate
}

function resolvePhysicalPlan(source: PreviewSource): PreviewPlan | null {
  const tableName = resolveTableName(source)
  if (!tableName) return null

  return {
    tableName,
    orderColumn: isValidIdentifier(source.primary_key_column) ? source.primary_key_column ?? null : null,
    columns: null,
  }
}

async function tableExists(client: PoolClient, tableName: string) {
  const result = await client.query(
    'SELECT to_regclass($1) AS relation_name',
    [`public.${tableName}`]
  )

  return Boolean(result.rows[0]?.relation_name)
}

async function fetchColumns(client: PoolClient, tableName: string) {
  const result = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
     ORDER BY ordinal_position ASC`,
    [tableName]
  )

  return result.rows.map((row: { column_name: string }) => row.column_name)
}

function getPreviewColumns(plan: PreviewPlan, tableColumns: string[]) {
  if (!plan.columns) return tableColumns
  return plan.columns.map(column => column.alias ?? column.source)
}

function buildSelectClause(plan: PreviewPlan) {
  if (!plan.columns) return '*'

  return plan.columns
    .map(column => {
      const sourceColumn = quoteIdentifier(column.source)
      const alias = column.alias ? ` AS ${quoteIdentifier(column.alias)}` : ''
      return `${sourceColumn}${alias}`
    })
    .join(', ')
}

function normalizeCell(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return `[binary ${value.length} bytes]`
  return value
}

function normalizeRow(row: Record<string, unknown>, columns: string[]) {
  return columns.reduce<Record<string, unknown>>((previewRow, column) => {
    previewRow[column] = normalizeCell(row[column])
    return previewRow
  }, {})
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const { id } = await context.params
  const { source, error } = await getSourceById(id)

  if (!source) {
    if (error) {
      console.error('[fuentes/preview][source_lookup]', { id, error })
    }
    return NextResponse.json({ error: 'Dataset no encontrado' }, { status: 404 })
  }

  const physicalPlan = resolvePhysicalPlan(source)
  if (!physicalPlan) {
    return NextResponse.json(
      { error: 'Este dataset no tiene una tabla configurada para preview.' },
      { status: 400 }
    )
  }

  const pool = createPool()
  if (!pool) {
    return NextResponse.json(
      { error: 'No hay una conexion Postgres disponible para previsualizar.' },
      { status: 500 }
    )
  }

  let client: PoolClient | null = null

  try {
    client = await pool.connect()

    const physicalExists = await tableExists(client, physicalPlan.tableName)
    const fallbackPlan = source.slug ? DATASET_PREVIEW_FALLBACKS[source.slug] : null
    const plan = physicalExists ? physicalPlan : fallbackPlan

    if (!plan) {
      return NextResponse.json(
        { error: `La tabla fuente ${physicalPlan.tableName} no existe en la base actual.` },
        { status: 400 }
      )
    }

    const exists = physicalExists || await tableExists(client, plan.tableName)
    if (!exists) {
      return NextResponse.json(
        { error: `La tabla fuente ${plan.tableName} no existe en la base actual.` },
        { status: 400 }
      )
    }

    const tableColumns = await fetchColumns(client, plan.tableName)
    const columns = getPreviewColumns(plan, tableColumns)
    const orderColumn = isValidIdentifier(plan.orderColumn) && tableColumns.includes(plan.orderColumn as string)
      ? plan.orderColumn
      : columns.find(column => ['id', 'rutid', 'created_at'].includes(column)) ?? null

    const tableRef = `${quoteIdentifier('public')}.${quoteIdentifier(plan.tableName)}`
    const selectClause = buildSelectClause(plan)
    const whereClause = plan.whereClause ? ` WHERE ${plan.whereClause}` : ''
    const orderDirection = plan.orderDirection === 'DESC' ? 'DESC' : 'ASC'
    const orderClause = orderColumn ? ` ORDER BY ${quoteIdentifier(orderColumn)} ${orderDirection}` : ''
    const result = await client.query(
      `SELECT ${selectClause} FROM ${tableRef}${whereClause}${orderClause} LIMIT $1`,
      [PREVIEW_LIMIT]
    )

    return NextResponse.json({
      success: true,
      data: {
        source: {
          id: source.id,
          name: source.name,
          slug: source.slug,
          table_name: plan.tableName,
        },
        columns,
        rows: result.rows.map(row => normalizeRow(row, columns)),
        row_limit: PREVIEW_LIMIT,
      },
    })
  } catch (previewError) {
    console.error('[fuentes/preview]', {
      sourceId: source.id,
      tableName: physicalPlan.tableName,
      error: previewError,
    })

    return NextResponse.json(
      { error: 'No se pudo cargar la preview del dataset.' },
      { status: 500 }
    )
  } finally {
    client?.release()
    await pool.end()
  }
}
