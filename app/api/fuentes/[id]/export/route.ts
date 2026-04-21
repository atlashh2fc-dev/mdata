import { NextRequest, NextResponse } from 'next/server'
import { Pool, type PoolClient } from 'pg'
import { createSupabaseServerClient, db } from '@/lib/db/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const DEFAULT_BATCH_SIZE = 1000

type ExportableSource = {
  id: string
  name?: string | null
  slug?: string | null
  canonical_table?: string | null
  source_table_name?: string | null
  primary_key_column?: string | null
}

type ExportColumn = {
  source: string
  alias?: string
}

type ExportPlan = {
  tableName: string
  orderColumn: string | null
  columns: ExportColumn[] | null
}

const DATASET_EXPORT_FALLBACKS: Record<string, ExportPlan> = {
  pernat_resumen: {
    tableName: 'personas_master',
    orderColumn: 'rutid',
    columns: [
      { source: 'rutid' },
      { source: 'nombres' },
      { source: 'paterno' },
      { source: 'materno' },
      { source: 'email' },
      { source: 'fono_cel' },
      { source: 'comuna_part' },
      { source: 'region_part' },
      { source: 'loaded_at' },
    ],
  },
  autos_resumen: {
    tableName: 'personas_master',
    orderColumn: 'rutid',
    columns: [
      { source: 'rutid' },
      { source: 'n_autos' },
      { source: 'loaded_at' },
    ],
  },
  empresa_resumen: {
    tableName: 'personas_master',
    orderColumn: 'rutid',
    columns: [
      { source: 'rutid' },
      { source: 'razon_social_empresa' },
      { source: 'loaded_at' },
    ],
  },
  domicilio_resumen: {
    tableName: 'personas_master',
    orderColumn: 'rutid',
    columns: [
      { source: 'rutid' },
      { source: 'domicilio_comuna', alias: 'comuna' },
      { source: 'domicilio_region', alias: 'region' },
      { source: 'loaded_at' },
    ],
  },
  acumulado_resumen: {
    tableName: 'personas_master',
    orderColumn: 'rutid',
    columns: [
      { source: 'rutid' },
      { source: 'n_bienes_raices' },
      { source: 'totalavaluos' },
      { source: 'loaded_at' },
    ],
  },
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

function csvEscape(value: unknown) {
  if (value === null || value === undefined) return ''

  const stringValue = typeof value === 'object'
    ? JSON.stringify(value)
    : String(value)

  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`
  }

  return stringValue
}

function quoteIdentifier(identifier: string) {
  return `"${identifier}"`
}

function isValidIdentifier(value: string | null | undefined) {
  return Boolean(value && TABLE_NAME_PATTERN.test(value))
}

function resolvePhysicalTable(source: ExportableSource) {
  const candidate = source.canonical_table ?? source.source_table_name ?? null
  if (!isValidIdentifier(candidate)) return null
  return candidate
}

function resolveOrderColumn(source: ExportableSource) {
  const candidates = [
    source.primary_key_column,
    'id',
    'rutid',
    'created_at',
  ]

  return candidates.find(candidate => isValidIdentifier(candidate)) ?? null
}

function resolveExportPlan(source: ExportableSource): ExportPlan | null {
  if (source.slug && DATASET_EXPORT_FALLBACKS[source.slug]) {
    return DATASET_EXPORT_FALLBACKS[source.slug]
  }

  const tableName = resolvePhysicalTable(source)
  if (!tableName) return null

  return {
    tableName,
    orderColumn: resolveOrderColumn(source),
    columns: null,
  }
}

function buildCsvFileName(source: ExportableSource) {
  const baseName = source.slug
    || (source.name ? slugify(source.name) : null)
    || source.canonical_table
    || source.source_table_name
    || 'dataset'

  return `${baseName}.csv`
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
  source: ExportableSource | null
  error: unknown
}> {
  const overviewQuery = await db
    .from('dataset_overview')
    .select('id, name, slug, canonical_table, source_table_name, primary_key_column')
    .eq('id', id)
    .maybeSingle()

  if (overviewQuery.data) {
    return { source: overviewQuery.data as ExportableSource, error: null }
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
    source: (fallbackQuery.data as ExportableSource | null) ?? null,
    error: overviewQuery.error,
  }
}

async function tableExists(client: PoolClient, tableName: string) {
  const result = await client.query(
    'SELECT to_regclass($1) AS relation_name',
    [`public.${tableName}`]
  )

  return Boolean(result.rows[0]?.relation_name)
}

async function fetchColumnNames(client: PoolClient, plan: ExportPlan) {
  if (plan.columns) {
    return plan.columns.map(column => column.alias ?? column.source)
  }

  const result = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
     ORDER BY ordinal_position ASC`,
    [plan.tableName]
  )

  return result.rows.map((row: { column_name: string }) => row.column_name)
}

async function fetchBatch(
  client: PoolClient,
  plan: ExportPlan,
  batchSize: number,
  cursorValue: unknown,
  offset: number
) {
  const selectClause = plan.columns
    ? plan.columns
      .map(column => {
        const sourceColumn = quoteIdentifier(column.source)
        const alias = column.alias ? ` AS ${quoteIdentifier(column.alias)}` : ''
        return `${sourceColumn}${alias}`
      })
      .join(', ')
    : '*'

  const tableRef = `public.${plan.tableName}`

  if (plan.orderColumn) {
    const orderRef = quoteIdentifier(plan.orderColumn)

    if (cursorValue !== null && cursorValue !== undefined) {
      const result = await client.query(
        `SELECT ${selectClause} FROM ${tableRef}
         WHERE ${orderRef} > $1
         ORDER BY ${orderRef} ASC
         LIMIT $2`,
        [cursorValue, batchSize]
      )
      return result.rows as Record<string, unknown>[]
    }

    const result = await client.query(
      `SELECT ${selectClause} FROM ${tableRef}
       ORDER BY ${orderRef} ASC
       LIMIT $1`,
      [batchSize]
    )

    return result.rows as Record<string, unknown>[]
  }

  const result = await client.query(
    `SELECT ${selectClause} FROM ${tableRef}
     LIMIT $1 OFFSET $2`,
    [batchSize, offset]
  )

  return result.rows as Record<string, unknown>[]
}

function createCsvStream(source: ExportableSource, plan: ExportPlan) {
  const encoder = new TextEncoder()
  const pool = createPool()

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (!pool) {
        controller.error(new Error('No hay una conexion Postgres disponible para exportar.'))
        return
      }

      let client: PoolClient | null = null
      let headerColumns: string[] = []
      let cursorValue: unknown = null
      let offset = 0

      try {
        client = await pool.connect()

        headerColumns = await fetchColumnNames(client, plan)
        if (headerColumns.length > 0) {
          controller.enqueue(
            encoder.encode(`${headerColumns.map(csvEscape).join(',')}\n`)
          )
        }

        while (true) {
          const rows = await fetchBatch(
            client,
            plan,
            DEFAULT_BATCH_SIZE,
            cursorValue,
            offset
          )

          if (rows.length === 0) {
            if (headerColumns.length === 0) {
              controller.enqueue(encoder.encode(''))
            }
            break
          }

          if (headerColumns.length === 0) {
            headerColumns = Object.keys(rows[0])
            controller.enqueue(
              encoder.encode(`${headerColumns.map(csvEscape).join(',')}\n`)
            )
          }

          const csvChunk = rows
            .map(row => headerColumns.map(column => csvEscape(row[column])).join(','))
            .join('\n')

          controller.enqueue(encoder.encode(`${csvChunk}\n`))

          if (rows.length < DEFAULT_BATCH_SIZE) {
            break
          }

          if (plan.orderColumn) {
            cursorValue = rows.at(-1)?.[plan.orderColumn]
            if (cursorValue === null || cursorValue === undefined) {
              offset += rows.length
            }
          } else {
            offset += rows.length
          }
        }

        controller.close()
      } catch (error) {
        console.error('[fuentes/export][stream]', {
          sourceId: source.id,
          tableName: plan.tableName,
          orderColumn: plan.orderColumn,
          offset,
          error,
        })
        controller.error(error)
      } finally {
        client?.release()
        await pool.end()
      }
    },
  })
}

export async function GET(
  _req: NextRequest,
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
      console.error('[fuentes/export][source_lookup]', { id, error })
    }
    return NextResponse.json({ error: 'Dataset no encontrado' }, { status: 404 })
  }

  const plan = resolveExportPlan(source)
  if (!plan) {
    return NextResponse.json(
      { error: 'Este dataset no tiene una configuracion exportable.' },
      { status: 400 }
    )
  }

  if (!isValidIdentifier(plan.tableName) || !isValidIdentifier(plan.orderColumn ?? 'id')) {
    return NextResponse.json(
      { error: 'La configuracion del dataset es invalida para exportar.' },
      { status: 400 }
    )
  }

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
    const exists = await tableExists(client, plan.tableName)
    if (!exists) {
      return NextResponse.json(
        { error: `La tabla fuente ${plan.tableName} no existe en la base actual.` },
        { status: 400 }
      )
    }
  } catch (preflightError) {
    console.error('[fuentes/export][preflight]', {
      sourceId: source.id,
      tableName: plan.tableName,
      error: preflightError,
    })
    return NextResponse.json(
      { error: 'No se pudo preparar la exportacion del dataset.' },
      { status: 500 }
    )
  } finally {
    client?.release()
    await pool.end()
  }

  return new NextResponse(createCsvStream(source, plan), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${buildCsvFileName(source)}"`,
      'Cache-Control': 'no-store',
    },
  })
}
