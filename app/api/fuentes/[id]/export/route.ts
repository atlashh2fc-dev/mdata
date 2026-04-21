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

const CRM_EXPORT_COLUMNS = [
  'rutid',
  'razon_social_empresa',
  'loaded_at',
  'CRM - Tiene historial',
  'CRM - Última gestión',
  'CRM - Último resultado',
  'CRM - Subresultado',
  'CRM - Último canal',
  'CRM - Último agente',
  'CRM - Última campaña',
  'CRM - Último contacto',
  'CRM - Última venta',
  'CRM - Total gestiones',
  'CRM - Contactos efectivos',
  'CRM - Intereses',
  'CRM - Callbacks',
  'CRM - Ventas',
  'CRM - Próxima acción',
  'CRM - Prioridad',
  'CRM - Canal sugerido',
  'CRM - Mejor hora',
  'CRM - Mejor teléfono',
  'CRM - Mejor email',
] as const

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

function supportsCrmExport(source: ExportableSource) {
  return source.slug === 'empresa_resumen' || source.canonical_table === 'empresa_resumen'
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

async function fetchCompanyBatchWithCrm(
  client: PoolClient,
  batchSize: number,
  cursorValue: unknown
) {
  const cursorClause = cursorValue !== null && cursorValue !== undefined
    ? 'AND pm.rutid > $1'
    : ''
  const params = cursorValue !== null && cursorValue !== undefined
    ? [cursorValue, batchSize]
    : [batchSize]
  const limitParam = cursorValue !== null && cursorValue !== undefined ? '$2' : '$1'

  const result = await client.query(
    `
      WITH latest_feedback AS (
        SELECT DISTINCT ON (target_rutid)
          target_rutid,
          managed_at,
          outcome,
          outcome_subtype,
          channel,
          agent_name,
          campaign_name
        FROM (
          SELECT
            COALESCE(matched_rutid, rutid) AS target_rutid,
            managed_at,
            outcome,
            outcome_subtype,
            channel,
            agent_name,
            campaign_name
          FROM public.contact_center_feedback
          WHERE COALESCE(matched_rutid, rutid) IS NOT NULL
        ) base_feedback
        ORDER BY target_rutid, managed_at DESC
      )
      SELECT
        pm.rutid,
        pm.razon_social_empresa,
        pm.loaded_at,
        CASE WHEN COALESCE(ps.feedback_coverage, FALSE) THEN 'Sí' ELSE 'No' END AS "CRM - Tiene historial",
        COALESCE(lf.managed_at, ps.last_feedback_at) AS "CRM - Última gestión",
        lf.outcome AS "CRM - Último resultado",
        lf.outcome_subtype AS "CRM - Subresultado",
        lf.channel AS "CRM - Último canal",
        lf.agent_name AS "CRM - Último agente",
        lf.campaign_name AS "CRM - Última campaña",
        ps.last_contact_at AS "CRM - Último contacto",
        ps.last_sale_at AS "CRM - Última venta",
        ps.total_interactions AS "CRM - Total gestiones",
        ps.effective_contacts AS "CRM - Contactos efectivos",
        ps.interest_events AS "CRM - Intereses",
        ps.callback_events AS "CRM - Callbacks",
        ps.sales_events AS "CRM - Ventas",
        ps.next_best_action AS "CRM - Próxima acción",
        ps.action_priority AS "CRM - Prioridad",
        ps.best_channel AS "CRM - Canal sugerido",
        CASE
          WHEN ps.best_contact_hour IS NULL THEN NULL
          ELSE LPAD(ps.best_contact_hour::text, 2, '0') || ':00'
        END AS "CRM - Mejor hora",
        ps.best_phone AS "CRM - Mejor teléfono",
        ps.best_email AS "CRM - Mejor email"
      FROM public.personas_master pm
      LEFT JOIN public.persona_scores ps
        ON ps.rutid = pm.rutid
      LEFT JOIN latest_feedback lf
        ON lf.target_rutid = pm.rutid
      WHERE pm.razon_social_empresa IS NOT NULL
      ${cursorClause}
      ORDER BY pm.rutid ASC
      LIMIT ${limitParam}
    `,
    params
  )

  return result.rows as Record<string, unknown>[]
}

async function fetchCompanyBatch(
  client: PoolClient,
  batchSize: number,
  cursorValue: unknown
) {
  const cursorClause = cursorValue !== null && cursorValue !== undefined
    ? 'AND pm.rutid > $1'
    : ''
  const params = cursorValue !== null && cursorValue !== undefined
    ? [cursorValue, batchSize]
    : [batchSize]
  const limitParam = cursorValue !== null && cursorValue !== undefined ? '$2' : '$1'

  const result = await client.query(
    `
      SELECT
        pm.rutid,
        pm.razon_social_empresa,
        pm.loaded_at
      FROM public.personas_master pm
      WHERE pm.razon_social_empresa IS NOT NULL
      ${cursorClause}
      ORDER BY pm.rutid ASC
      LIMIT ${limitParam}
    `,
    params
  )

  return result.rows as Record<string, unknown>[]
}

async function fetchBatch(
  client: PoolClient,
  plan: ExportPlan,
  batchSize: number,
  cursorValue: unknown,
  offset: number,
  source: ExportableSource,
  includeCrm: boolean
) {
  if (includeCrm && supportsCrmExport(source)) {
    return fetchCompanyBatchWithCrm(client, batchSize, cursorValue)
  }

  if (supportsCrmExport(source)) {
    return fetchCompanyBatch(client, batchSize, cursorValue)
  }

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
            offset,
            source,
            false
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

function createCsvStreamWithCrm(source: ExportableSource, plan: ExportPlan) {
  const encoder = new TextEncoder()
  const pool = createPool()

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (!pool) {
        controller.error(new Error('No hay una conexion Postgres disponible para exportar.'))
        return
      }

      let client: PoolClient | null = null
      let cursorValue: unknown = null

      try {
        client = await pool.connect()

        controller.enqueue(
          encoder.encode(`${CRM_EXPORT_COLUMNS.map(csvEscape).join(',')}\n`)
        )

        while (true) {
          const rows = await fetchBatch(
            client,
            plan,
            DEFAULT_BATCH_SIZE,
            cursorValue,
            0,
            source,
            true
          )

          if (rows.length === 0) break

          const csvChunk = rows
            .map(row => CRM_EXPORT_COLUMNS.map(column => csvEscape(row[column])).join(','))
            .join('\n')

          controller.enqueue(encoder.encode(`${csvChunk}\n`))

          if (rows.length < DEFAULT_BATCH_SIZE) break

          cursorValue = rows.at(-1)?.rutid
          if (cursorValue === null || cursorValue === undefined) break
        }

        controller.close()
      } catch (error) {
        console.error('[fuentes/export][stream_crm]', {
          sourceId: source.id,
          tableName: plan.tableName,
          orderColumn: plan.orderColumn,
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
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const { id } = await context.params
  const includeCrm = req.nextUrl.searchParams.get('include_crm') === '1'
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

  if (includeCrm && !supportsCrmExport(source)) {
    return NextResponse.json(
      { error: 'La actualización contra CRM solo está disponible para el dataset de empresas.' },
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

  return new NextResponse(includeCrm ? createCsvStreamWithCrm(source, plan) : createCsvStream(source, plan), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${includeCrm ? buildCsvFileName({
        ...source,
        slug: `${source.slug ?? 'dataset'}-crm`,
      }) : buildCsvFileName(source)}"`,
      'Cache-Control': 'no-store',
    },
  })
}
