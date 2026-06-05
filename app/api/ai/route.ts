import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import { getDashboardKPIs } from '@/lib/services/dashboard'
import { createSegmento } from '@/lib/services/segmentos'
import { FILTER_FIELDS, type FilterCondition, type FilterOperator, type SegmentFilter } from '@/types'
import { search, SafeSearchType } from 'duck-duck-scrape'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Pool, type PoolClient } from 'pg'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const INCEPTION_URL = 'https://api.inceptionlabs.ai/v1/chat/completions'
const INCEPTION_KEY = process.env.INCEPTION_API_KEY
const CRM_SYNC_MAX_BUFFER = 1024 * 1024 * 4
const DEFAULT_CRM_FRESH_MINUTES = 180
const DEFAULT_SAMPLE_LIMIT = 20
const MAX_SAMPLE_LIMIT = 100
const DEFAULT_DATASET_CATALOG_LIMIT = 30
const DEFAULT_DATASET_SAMPLE_LIMIT = 8
const LLM_TIMEOUT_MS = 45000
const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const ALLOWED_SEGMENT_FIELDS = new Set(FILTER_FIELDS.map(field => field.key as string))
const ALLOWED_SEGMENT_OPERATORS = new Set<FilterOperator>([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'in',
  'not_in',
  'is_null',
  'is_not_null',
  'contains',
  'starts_with',
])

const execFileAsync = promisify(execFile)

type ToolCall = {
  id: string
  function: {
    name: string
    arguments?: string
  }
}

type CrmFreshness = {
  last_sync_completed_at: string | null
  last_cursor_value: string | null
  last_feedback_at: string | null
  last_score_refresh_at: string | null
  age_minutes: number | null
  is_fresh: boolean
}

type DatasetCatalogItem = {
  id: string | null
  name: string | null
  slug: string | null
  description: string | null
  canonical_table: string | null
  source_table_name: string | null
  record_count: number | null
  latest_loaded_row_count: number | null
  last_loaded_at: string | null
  latest_version_completed_at: string | null
  last_job_status: string | null
  latest_version_status: string | null
}

let pool: Pool | null = null
let crmSyncPromise: Promise<{
  stdout: string
  stderr: string
}> | null = null

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
    if (!connectionString) {
      throw new Error('No hay una conexion Postgres disponible para consultar inteligencia de negocio.')
    }

    pool = new Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 10000,
    })
  }

  return pool
}

function isValidIdentifier(value: string | null | undefined) {
  return Boolean(value && TABLE_NAME_PATTERN.test(value))
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`
}

function getLastUserMessage(messages: { role: string; content: string }[]) {
  return [...messages].reverse().find(message => message.role === 'user')?.content ?? ''
}

function formatCount(value: unknown) {
  const numberValue = Number(value ?? 0)
  return Number.isFinite(numberValue) ? numberValue.toLocaleString('es-CL') : '0'
}

function formatDate(value: unknown) {
  if (!value) return 'sin fecha'
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' })
}

function csvLikeValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function withTimeoutSignal(timeoutMs = LLM_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  }
}

async function fetchStats() {
  return getDashboardKPIs()
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await getPool().connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

async function getCrmFreshness(maxFreshMinutes = DEFAULT_CRM_FRESH_MINUTES): Promise<CrmFreshness> {
  return withClient(async client => {
    const result = await client.query(`
      WITH latest_sync AS (
        SELECT completed_at, cursor_value
        FROM public.external_sync_runs
        WHERE source_name = 'registro_intel'
          AND status IN ('completed', 'partial')
        ORDER BY completed_at DESC NULLS LAST
        LIMIT 1
      ),
      feedback AS (
        SELECT max(managed_at) AS last_feedback_at
        FROM public.contact_center_feedback
      ),
      scores AS (
        SELECT max(updated_at) AS last_score_refresh_at
        FROM public.persona_scores
      )
      SELECT
        latest_sync.completed_at AS last_sync_completed_at,
        latest_sync.cursor_value AS last_cursor_value,
        feedback.last_feedback_at,
        scores.last_score_refresh_at,
        CASE
          WHEN latest_sync.completed_at IS NULL THEN NULL
          ELSE extract(epoch FROM (now() - latest_sync.completed_at)) / 60
        END AS age_minutes
      FROM latest_sync
      CROSS JOIN feedback
      CROSS JOIN scores
    `)

    const row = result.rows[0] ?? {}
    const ageMinutes = row.age_minutes === null || row.age_minutes === undefined
      ? null
      : Number(row.age_minutes)

    return {
      last_sync_completed_at: row.last_sync_completed_at ?? null,
      last_cursor_value: row.last_cursor_value ?? null,
      last_feedback_at: row.last_feedback_at ?? null,
      last_score_refresh_at: row.last_score_refresh_at ?? null,
      age_minutes: ageMinutes,
      is_fresh: ageMinutes !== null && ageMinutes <= maxFreshMinutes,
    }
  })
}

function parseLastJsonObject(output: string) {
  const matches = output.match(/\{[\s\S]*\}/g)
  if (!matches?.length) return null

  for (let i = matches.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(matches[i])
    } catch {
      // Keep scanning older blocks.
    }
  }

  return null
}

async function ensureCrmFresh(maxFreshMinutes = DEFAULT_CRM_FRESH_MINUTES) {
  const before = await getCrmFreshness(maxFreshMinutes)
  if (before.is_fresh) {
    return {
      ok: true,
      refreshed: false,
      reason: `CRM sincronizado hace ${Math.round(before.age_minutes ?? 0)} minutos.`,
      before,
      after: before,
    }
  }

  if (!crmSyncPromise) {
    crmSyncPromise = execFileAsync(
      'npm',
      ['run', 'ops:sync:crm-feedback'],
      {
        cwd: process.cwd(),
        env: process.env,
        maxBuffer: CRM_SYNC_MAX_BUFFER,
        timeout: 240000,
      }
    ).finally(() => {
      crmSyncPromise = null
    }) as Promise<{ stdout: string; stderr: string }>
  }

  const { stdout, stderr } = await crmSyncPromise

  const after = await getCrmFreshness(maxFreshMinutes)
  return {
    ok: true,
    refreshed: true,
    before,
    after,
    sync_result: parseLastJsonObject(stdout),
    stderr: stderr?.trim() || null,
  }
}

async function getPymeCrmOverview() {
  return withClient(async client => {
    const [freshness, metrics] = await Promise.all([
      getCrmFreshness(),
      client.query(`
        SELECT
          count(*)::bigint AS total_pyme,
          count(*) FILTER (WHERE COALESCE(ps.feedback_coverage, false))::bigint AS pyme_con_gestion_crm,
          count(*) FILTER (
            WHERE COALESCE(ps.feedback_coverage, false)
              AND (NULLIF(ps.best_phone, '') IS NOT NULL OR NULLIF(ps.best_email, '') IS NOT NULL)
          )::bigint AS pyme_con_gestion_y_contacto_valido,
          count(*) FILTER (WHERE NULLIF(ps.best_phone, '') IS NOT NULL)::bigint AS pyme_con_mejor_telefono,
          count(*) FILTER (WHERE NULLIF(ps.best_email, '') IS NOT NULL)::bigint AS pyme_con_mejor_email,
          count(*) FILTER (WHERE ps.action_priority = 'alta')::bigint AS pyme_prioridad_alta,
          max(ps.last_feedback_at) AS ultima_gestion_crm_en_scores
        FROM public.personas_master pm
        LEFT JOIN public.persona_scores ps
          ON ps.rutid = pm.rutid
        WHERE pm.razon_social_empresa IS NOT NULL
      `),
    ])

    const row = metrics.rows[0] ?? {}

    return {
      universe: 'empresa_resumen / PyME',
      metrics: {
        total_pyme: Number(row.total_pyme ?? 0),
        pyme_con_gestion_crm: Number(row.pyme_con_gestion_crm ?? 0),
        pyme_con_gestion_y_contacto_valido: Number(row.pyme_con_gestion_y_contacto_valido ?? 0),
        pyme_con_mejor_telefono: Number(row.pyme_con_mejor_telefono ?? 0),
        pyme_con_mejor_email: Number(row.pyme_con_mejor_email ?? 0),
        pyme_prioridad_alta: Number(row.pyme_prioridad_alta ?? 0),
        ultima_gestion_crm_en_scores: row.ultima_gestion_crm_en_scores ?? null,
      },
      freshness,
    }
  })
}

async function getDatasetCatalog(limit = DEFAULT_DATASET_CATALOG_LIMIT) {
  const safeLimit = Math.min(Math.max(Number(limit), 1), 100)

  return withClient(async client => {
    const result = await client.query(`
      SELECT
        id,
        name,
        slug,
        description,
        canonical_table,
        source_table_name,
        record_count,
        latest_loaded_row_count,
        last_loaded_at,
        latest_version_completed_at,
        last_job_status,
        latest_version_status
      FROM public.dataset_overview
      WHERE COALESCE(is_active, true) = true
      ORDER BY COALESCE(latest_version_completed_at, last_loaded_at, updated_at, created_at) DESC NULLS LAST
      LIMIT $1
    `, [safeLimit])

    return result.rows as DatasetCatalogItem[]
  })
}

function resolveDatasetFromMessage(message: string, catalog: DatasetCatalogItem[]) {
  const normalized = message.toLowerCase()

  return catalog.find(item => {
    const slug = item.slug?.toLowerCase()
    const name = item.name?.toLowerCase()
    const table = item.canonical_table?.toLowerCase()
    return Boolean(
      (slug && normalized.includes(slug)) ||
      (table && normalized.includes(table)) ||
      (name && name.length > 3 && normalized.includes(name))
    )
  }) ?? null
}

async function getDatasetProfile(dataset: DatasetCatalogItem, sampleLimit = DEFAULT_DATASET_SAMPLE_LIMIT) {
  const tableName = dataset.canonical_table ?? dataset.source_table_name
  if (!isValidIdentifier(tableName)) {
    throw new Error('La base no tiene una tabla fisica valida para revisar.')
  }

  const safeLimit = Math.min(Math.max(Number(sampleLimit), 1), 20)

  return withClient(async client => {
    const columnsResult = await client.query(`
      SELECT
        a.attname AS column_name,
        format_type(a.atttypid, a.atttypmod) AS data_type
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = $1
        AND c.relkind IN ('r', 'p', 'v', 'm')
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum ASC
    `, [tableName])

    const sampleResult = await client.query(
      `SELECT * FROM public.${quoteIdentifier(tableName!)} LIMIT $1`,
      [safeLimit]
    )

    return {
      dataset,
      table_name: tableName,
      columns: columnsResult.rows as { column_name: string; data_type: string }[],
      sample_rows: sampleResult.rows as Record<string, unknown>[],
    }
  })
}

function extractCompanyIndustryQuery(message: string) {
  const normalized = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const patterns = [
    /\bempresas?\s+(?:de|del|en|sobre|rubro|actividad)\s+(.+)$/,
    /\bcompanias?\s+(?:de|del|en|sobre|rubro|actividad)\s+(.+)$/,
    /\bclientes?\s+(?:de|del|en|sobre|rubro|actividad)\s+(.+)$/,
    /\bbases?\s+(?:de|del|en|sobre|rubro|actividad)\s+(.+)$/,
  ]

  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    const candidate = match?.[1]
      ?.replace(/\b(tienes|tenemos|hay|existen|disponibles|en la base|en bases|para exportar)\b/g, '')
      .trim()

    if (candidate && candidate.length > 2) return candidate
  }

  const knownIndustryTerms = [
    'factoring',
    'leasing',
    'financiera',
    'financieras',
    'constructora',
    'constructoras',
    'inmobiliaria',
    'inmobiliarias',
    'transporte',
    'logistica',
    'mineria',
    'agricola',
    'retail',
    'salud',
    'educacion',
  ]

  return knownIndustryTerms.find(term => normalized.includes(term)) ?? null
}

async function searchCompaniesByIndustry(term: string, limit = 10) {
  const safeLimit = Math.min(Math.max(Number(limit), 1), 30)
  const searchTerm = term.trim()

  if (searchTerm.length < 3) {
    throw new Error('Indica un rubro o actividad con al menos 3 caracteres.')
  }

  return withClient(async client => {
    const result = await client.query(`
      WITH matches AS (
        SELECT
          rutid,
          razon_social,
          segmento_tamano_empresa,
          rubro_economico_ultimo,
          subrubro_economico_ultimo,
          actividad_economica_ultima,
          region,
          comuna,
          email,
          fono_cel,
          score_patrimonial
        FROM public.empresas_comercial_unificada
        WHERE COALESCE(es_universo_operativo_ventas, true) = true
          AND (
            razon_social ILIKE $1
            OR rubro_economico_ultimo ILIKE $1
            OR subrubro_economico_ultimo ILIKE $1
            OR actividad_economica_ultima ILIKE $1
          )
      ),
      counted AS (
        SELECT count(*)::bigint AS total FROM matches
      )
      SELECT
        matches.*,
        counted.total
      FROM matches
      CROSS JOIN counted
      ORDER BY
        score_patrimonial DESC NULLS LAST,
        razon_social ASC NULLS LAST
      LIMIT $2
    `, [`%${searchTerm}%`, safeLimit])

    return {
      term: searchTerm,
      total: Number(result.rows[0]?.total ?? 0),
      rows: result.rows.map(({ total, ...row }) => row),
    }
  })
}

function renderDatasetCatalogMarkdown(catalog: DatasetCatalogItem[]) {
  if (catalog.length === 0) {
    return 'No encontré bases activas registradas en `dataset_overview`.'
  }

  const rows = catalog.map(item => {
    const count = item.latest_loaded_row_count ?? item.record_count ?? 0
    const status = item.latest_version_status ?? item.last_job_status ?? 'sin estado'
    const loadedAt = item.latest_version_completed_at ?? item.last_loaded_at
    return `| ${item.name ?? item.slug ?? 'Sin nombre'} | \`${item.slug ?? 'sin-slug'}\` | ${formatCount(count)} | ${status} | ${formatDate(loadedAt)} |`
  })

  return [
    `Tenemos **${catalog.length} bases activas recientes** listas para consulta rápida:`,
    '',
    '| Base | Slug | Filas | Estado | Última carga |',
    '|---|---:|---:|---|---|',
    ...rows,
    '',
    'Puedes pedirme `analiza base <slug>` o `muéstrame columnas de <slug>` y respondo desde la tabla real sin hacer procesos largos.',
  ].join('\n')
}

function renderDatasetProfileMarkdown(profile: Awaited<ReturnType<typeof getDatasetProfile>>) {
  const { dataset, columns, sample_rows: sampleRows } = profile
  const count = dataset.latest_loaded_row_count ?? dataset.record_count ?? 0
  const columnPreview = columns.slice(0, 18).map(col => `\`${col.column_name}\` (${col.data_type})`).join(', ')
  const visibleColumns = columns.slice(0, 8).map(col => col.column_name)
  const sampleTable = sampleRows.length > 0
    ? [
      `| ${visibleColumns.join(' | ')} |`,
      `| ${visibleColumns.map(() => '---').join(' | ')} |`,
      ...sampleRows.slice(0, 5).map(row => `| ${visibleColumns.map(column => csvLikeValue(row[column])).join(' | ')} |`),
    ].join('\n')
    : 'Sin muestra disponible.'

  return [
    `**${dataset.name ?? dataset.slug ?? 'Base'}**`,
    '',
    `- Slug: \`${dataset.slug ?? 'sin-slug'}\``,
    `- Tabla: \`${profile.table_name}\``,
    `- Filas registradas: **${formatCount(count)}**`,
    `- Columnas: **${columns.length}**`,
    `- Última carga: ${formatDate(dataset.latest_version_completed_at ?? dataset.last_loaded_at)}`,
    '',
    `Columnas principales: ${columnPreview || 'sin columnas detectadas'}.`,
    '',
    sampleTable,
  ].join('\n')
}

function shouldAnswerFastDataQuestion(messages: { role: string; content: string }[]) {
  const lastUserMessage = getLastUserMessage(messages)
  return /\b(bases?|datas?|datasets?|fuentes?|tablas?|bdd|columnas?|filas?|registros?|muestra|muestrame|analiza|analisis|cruces?|crm|contact\s*center|gestiones?|pyme|pymes)\b/i
    .test(lastUserMessage)
}

function wantsDatasetProfile(message: string) {
  return /\b(analiza|analisis|columnas?|muestra|muestrame|ejemplos?|filas?|estructura|perfil|preview)\b/i.test(message)
}

async function answerFastDataQuestion(messages: { role: string; content: string }[]) {
  const lastUserMessage = getLastUserMessage(messages)
  const companyIndustryQuery = extractCompanyIndustryQuery(lastUserMessage)

  if (companyIndustryQuery) {
    const result = await searchCompaniesByIndustry(companyIndustryQuery)
    const columns = ['rutid', 'razon_social', 'actividad_economica_ultima', 'region', 'comuna', 'fono_cel', 'email']
    const sampleTable = result.rows.length > 0
      ? [
        `| ${columns.join(' | ')} |`,
        `| ${columns.map(() => '---').join(' | ')} |`,
        ...result.rows.slice(0, 8).map(row => `| ${columns.map(column => csvLikeValue(row[column])).join(' | ')} |`),
      ].join('\n')
      : 'No encontré coincidencias directas en razón social, rubro, subrubro ni actividad.'

    return [
      `**Empresas relacionadas con “${result.term}”**`,
      '',
      `Encontré **${formatCount(result.total)}** coincidencia${result.total === 1 ? '' : 's'} en el universo de empresas.`,
      '',
      sampleTable,
      '',
      result.total > 0
        ? 'Puedo usar este mismo criterio para armar una descarga filtrada o cruzarlo con contacto, región, tamaño y score.'
        : 'Si quieres, pruebo una búsqueda más amplia por rubros financieros relacionados.',
    ].join('\n')
  }

  if (/\b(crm|contact\s*center|gestiones?|gestion|pyme|pymes)\b/i.test(lastUserMessage)) {
    const overview = await getPymeCrmOverview()
    const freshness = overview.freshness
    const metrics = overview.metrics

    return [
      '**Resumen PyME / CRM rápido**',
      '',
      `- Total PyME: **${formatCount(metrics.total_pyme)}**`,
      `- Con gestión CRM: **${formatCount(metrics.pyme_con_gestion_crm)}**`,
      `- Con gestión y contacto válido: **${formatCount(metrics.pyme_con_gestion_y_contacto_valido)}**`,
      `- Con mejor teléfono: **${formatCount(metrics.pyme_con_mejor_telefono)}**`,
      `- Con mejor email: **${formatCount(metrics.pyme_con_mejor_email)}**`,
      `- Prioridad alta: **${formatCount(metrics.pyme_prioridad_alta)}**`,
      '',
      `Freshness CRM: ${freshness.is_fresh ? 'vigente' : 'revisar'} · último sync ${formatDate(freshness.last_sync_completed_at)}.`,
      '',
      'No lancé sincronización automática para no dejar pegado el chat. Si quieres refrescar CRM ahora, pídeme “sincroniza CRM”.',
    ].join('\n')
  }

  const catalog = await getDatasetCatalog()
  const matchedDataset = resolveDatasetFromMessage(lastUserMessage, catalog)

  if (matchedDataset && wantsDatasetProfile(lastUserMessage)) {
    const profile = await getDatasetProfile(matchedDataset)
    return renderDatasetProfileMarkdown(profile)
  }

  return renderDatasetCatalogMarkdown(catalog)
}

async function getPymeCrmSample(args: { limit?: number; onlyValidContact?: boolean; onlyWithCrm?: boolean }) {
  const limit = Math.min(Math.max(Number(args.limit ?? DEFAULT_SAMPLE_LIMIT), 1), MAX_SAMPLE_LIMIT)
  const onlyValidContact = args.onlyValidContact !== false
  const onlyWithCrm = args.onlyWithCrm !== false

  const filters = [
    'pm.razon_social_empresa IS NOT NULL',
    onlyWithCrm ? 'COALESCE(ps.feedback_coverage, false)' : null,
    onlyValidContact ? "(NULLIF(ps.best_phone, '') IS NOT NULL OR NULLIF(ps.best_email, '') IS NOT NULL)" : null,
  ].filter(Boolean).join('\n          AND ')

  return withClient(async client => {
    const result = await client.query(`
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
        CASE WHEN COALESCE(ps.feedback_coverage, false) THEN 'Sí' ELSE 'No' END AS crm_tiene_historial,
        COALESCE(lf.managed_at, ps.last_feedback_at) AS crm_ultima_gestion,
        lf.outcome AS crm_ultimo_resultado,
        lf.outcome_subtype AS crm_subresultado,
        COALESCE(lf.channel, ps.best_channel) AS crm_ultimo_canal,
        lf.agent_name AS crm_ultimo_agente,
        lf.campaign_name AS crm_ultima_campana,
        ps.total_interactions AS crm_total_gestiones,
        ps.effective_contacts AS crm_contactos_efectivos,
        ps.action_priority AS crm_prioridad,
        ps.best_channel AS crm_canal_sugerido,
        CASE
          WHEN ps.best_contact_hour IS NULL THEN NULL
          ELSE LPAD(ps.best_contact_hour::text, 2, '0') || ':00'
        END AS crm_mejor_hora,
        ps.best_phone AS crm_mejor_telefono,
        ps.best_email AS crm_mejor_email
      FROM public.personas_master pm
      LEFT JOIN public.persona_scores ps
        ON ps.rutid = pm.rutid
      LEFT JOIN latest_feedback lf
        ON lf.target_rutid = pm.rutid
      WHERE ${filters}
      ORDER BY ps.last_feedback_at DESC NULLS LAST, pm.razon_social_empresa ASC
      LIMIT $1
    `, [limit])

    return {
      limit,
      filters: {
        only_with_crm: onlyWithCrm,
        only_valid_contact: onlyValidContact,
      },
      rows: result.rows,
    }
  })
}

function normalizeSegmentCondition(condition: unknown): FilterCondition {
  if (!condition || typeof condition !== 'object') {
    throw new Error('Cada condición del segmento debe ser un objeto.')
  }

  const input = condition as Partial<FilterCondition>
  const field = String(input.field ?? '')
  const operator = String(input.operator ?? '') as FilterOperator

  if (!ALLOWED_SEGMENT_FIELDS.has(field)) {
    throw new Error(`Campo de segmento no permitido: ${field}`)
  }

  if (!ALLOWED_SEGMENT_OPERATORS.has(operator)) {
    throw new Error(`Operador de segmento no permitido: ${operator}`)
  }

  return {
    field,
    operator,
    value: input.value ?? null,
    value2: input.value2 ?? null,
  }
}

async function createSegmentDownload(args: Record<string, unknown>, userId: string, origin: string) {
  const name = String(args.name ?? '').trim()
  const description = typeof args.description === 'string' ? args.description.trim() : null
  const rawFilters = args.filters as Partial<SegmentFilter> | undefined
  const conditions = Array.isArray(rawFilters?.conditions)
    ? rawFilters.conditions.map(normalizeSegmentCondition)
    : []

  if (!name) {
    throw new Error('Debes indicar un nombre para el segmento.')
  }

  if (conditions.length === 0) {
    throw new Error('No puedo generar una descarga sin filtros. Define al menos una condición de segmento.')
  }

  const filters: SegmentFilter = {
    logic: rawFilters?.logic === 'OR' ? 'OR' : 'AND',
    conditions,
  }

  const segmento = await createSegmento(name, description, filters, userId)
  if (!segmento) {
    throw new Error('No se pudo crear el segmento para descarga.')
  }

  const downloadPath = `/api/segmentos/export?segment_id=${encodeURIComponent(segmento.id)}`

  return {
    segment_id: segmento.id,
    name: segmento.name,
    description: segmento.description,
    row_count: segmento.row_count,
    download_url: `${origin}${downloadPath}`,
    download_path: downloadPath,
    format: 'csv',
  }
}

async function executeTool(
  name: string,
  rawArgs: string | undefined,
  context: { userId: string; origin: string }
) {
  const args = rawArgs ? JSON.parse(rawArgs) : {}

  if (name === 'webSearch') {
    const searchResults = await search(args.query, { safeSearch: SafeSearchType.OFF })
    return searchResults.results
      .slice(0, 3)
      .map(r => `Titulo: ${r.title}\nUrl: ${r.url}\nResumen: ${r.description}`)
      .join('\n\n') || 'Sin resultados'
  }

  if (name === 'ensureCrmFresh') {
    return JSON.stringify(await ensureCrmFresh(Number(args.max_fresh_minutes ?? DEFAULT_CRM_FRESH_MINUTES)), null, 2)
  }

  if (name === 'getDatasetCatalog') {
    return JSON.stringify(await getDatasetCatalog(Number(args.limit ?? DEFAULT_DATASET_CATALOG_LIMIT)), null, 2)
  }

  if (name === 'getDatasetProfile') {
    const catalog = await getDatasetCatalog(100)
    const query = String(args.query ?? '')
    const dataset = resolveDatasetFromMessage(query, catalog)
      ?? catalog.find(item => item.slug === args.slug)

    if (!dataset) {
      throw new Error('No encontré una base que coincida con ese nombre o slug.')
    }

    return JSON.stringify(await getDatasetProfile(dataset, Number(args.sample_limit ?? DEFAULT_DATASET_SAMPLE_LIMIT)), null, 2)
  }

  if (name === 'getPymeCrmOverview') {
    return JSON.stringify(await getPymeCrmOverview(), null, 2)
  }

  if (name === 'getPymeCrmSample') {
    return JSON.stringify(await getPymeCrmSample({
      limit: args.limit,
      onlyValidContact: args.only_valid_contact,
      onlyWithCrm: args.only_with_crm,
    }), null, 2)
  }

  if (name === 'createSegmentDownload') {
    return JSON.stringify(await createSegmentDownload(args, context.userId, context.origin), null, 2)
  }

  return `Tool desconocida: ${name}`
}

function shouldLoadBusinessContext(messages: { role: string; content: string }[]) {
  const lastUserMessage = getLastUserMessage(messages)
  return /\b(crm|contact\s*center|contacto|contactos|gestion|gestiones|empresa|empresas|muestra|ejemplos?|adjunto)\b/i
    .test(lastUserMessage)
}

function shouldLoadSample(messages: { role: string; content: string }[]) {
  const lastUserMessage = getLastUserMessage(messages)
  return /\b(muestra|filas|ejemplos?|adjunto|sample|listado|tabla)\b/i.test(lastUserMessage)
}

function shouldSyncCrm(messages: { role: string; content: string }[]) {
  const lastUserMessage = getLastUserMessage(messages)
  return /\b(sincroniza|sincronizar|sync|refresca|actualiza)\b/i.test(lastUserMessage) &&
    /\b(crm|contact\s*center|gestiones?|feedback)\b/i.test(lastUserMessage)
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { messages } = await req.json()

    if (shouldAnswerFastDataQuestion(messages || []) && !shouldSyncCrm(messages || [])) {
      try {
        const message = await answerFastDataQuestion(messages || [])
        return NextResponse.json({ success: true, message, mode: 'fast-data' })
      } catch (fastError) {
        console.warn('[AI fast-data fallback]', fastError)
      }
    }
    
    if (!INCEPTION_KEY) {
      return NextResponse.json({ error: 'INCEPTION_API_KEY no configurada' }, { status: 500 })
    }

    // Obtener contexto de BD real
    const stats = await fetchStats()
    const systemPrompt = `Eres el "Cerebro de Negocios" de la plataforma RUT Intelligence. 
Eres un experto de inteligencia de negocios, venta consultiva y análisis estratégico en Chile.
Tienes acceso al volumen total actualizado del maestro de datos. Usa siempre los KPIs en vivo incluidos abajo, no cifras históricas fijas.
El usuario te pedirá sugerencias sobre industrias, cruces de datos, prospección de clientes, etc.
Tu objetivo es sugerir qué segmentos de la base de datos debería crear o exportar para tener ventas exitosas y justificar el razonamiento.
Puedes buscar en internet libremente usando tu tool webSearch.
También tienes herramientas internas de datos para responder preguntas sobre el universo PyME y CRM.

Reglas obligatorias:
- Si el usuario pregunta por PyME, BDD PyME, empresas, gestiones CRM, contactos CRM, contact center, muestras o ejemplos de datos, usa herramientas internas. No inventes cifras.
- No sincronices CRM automáticamente. Solo llama ensureCrmFresh si el usuario pide explícitamente sincronizar, refrescar o actualizar CRM; para consultas normales usa los datos disponibles y declara el timestamp.
- Para conteos como "cuanta bdd pyme tenemos" o "cuantos tienen contacto con CRM", llama getPymeCrmOverview.
- Para preguntas sobre qué bases/datasets existen, columnas, registros o estructura, llama getDatasetCatalog o getDatasetProfile.
- Si el usuario pide muestra, ejemplos o filas, llama getPymeCrmSample y devuelve una tabla Markdown breve con los campos más útiles.
- Explica de forma clara si los datos vienen de persona_scores/contact_center_feedback sincronizados desde crm_feedback_export_v1.
- Si el usuario pide "descargar", "exportar", "link", "enlace" o "URL" para un segmento inferible, llama createSegmentDownload y entrega el enlace Markdown de descarga. No respondas que no puedes si existen filtros concretos.
- Si pide "base de autos", interpreta el segmento como RUTs con vehículos (tiene_autos = true). Si pide empresas/PyME, usa tiene_empresa = true. Si pide bienes raíces, usa tiene_bienes_raices = true. Combina con región, comuna, score o cantidad cuando el usuario lo indique.
- No generes descarga de la base completa sin filtros. En ese caso pide criterios o propone 2-3 segmentos exportables.
- SIEMPRE usa Markdown. Mantén un tono ejecutivo, preciso y práctico.

STATUS ACTUAL DE LA BASE DE DATOS (KPIs en vivo):
${JSON.stringify(stats, null, 2)}
`

    let currentMessages = [
      { role: 'system', content: systemPrompt },
      ...(messages || [])
    ]

    if (shouldLoadBusinessContext(messages || [])) {
      const contextPayload: Record<string, unknown> = {}

      try {
        contextPayload.crm_freshness = shouldSyncCrm(messages || [])
          ? await ensureCrmFresh()
          : await getCrmFreshness()
      } catch (error) {
        contextPayload.crm_freshness_error = error instanceof Error ? error.message : 'No se pudo validar CRM.'
      }

      try {
        contextPayload.pyme_crm_overview = await getPymeCrmOverview()
      } catch (error) {
        contextPayload.pyme_crm_overview_error = error instanceof Error ? error.message : 'No se pudo consultar overview PyME/CRM.'
      }

      if (shouldLoadSample(messages || [])) {
        try {
          contextPayload.pyme_crm_sample = await getPymeCrmSample({
            limit: 20,
            onlyWithCrm: true,
            onlyValidContact: true,
          })
        } catch (error) {
          contextPayload.pyme_crm_sample_error = error instanceof Error ? error.message : 'No se pudo consultar muestra PyME/CRM.'
        }
      }

      currentMessages.push({
        role: 'system',
        content: `CONTEXTO INTERNO YA CONSULTADO PARA ESTA PREGUNTA. Usa estos datos como fuente principal; no inventes cifras. Si hay errores, decláralos con precisión.\n${JSON.stringify(contextPayload, null, 2)}`
      })
    }

    const tools = [
      {
        type: 'function',
        function: {
          name: 'webSearch',
          description: 'Busca informacion en la web usando DuckDuckGo. Usa esto para buscar datos sobre industrias de alto valor, ventas de autos, bienes raices, etc que ayuden a enriquecer tu sugerencia de negocio.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'La consulta a buscar en internet'
              }
            },
            required: ['query']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'ensureCrmFresh',
          description: 'Valida si el CRM local esta actualizado y, solo cuando el usuario lo pidio explicitamente, ejecuta el sync desde registro_intel/crm_feedback_export_v1 y refresca scoring CRM.',
          parameters: {
            type: 'object',
            properties: {
              max_fresh_minutes: {
                type: 'number',
                description: 'Minutos maximos aceptables desde el ultimo sync. Default 180.'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'getDatasetCatalog',
          description: 'Lista rapidamente las bases/datasets activos: nombre, slug, tabla, filas, estado y ultima carga.',
          parameters: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Cantidad maxima de bases a listar. Default 30, max recomendado 100.'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'getDatasetProfile',
          description: 'Perfila una base especifica por nombre o slug: columnas, tipos y muestra liviana de filas.',
          parameters: {
            type: 'object',
            properties: {
              slug: {
                type: 'string',
                description: 'Slug exacto si se conoce.'
              },
              query: {
                type: 'string',
                description: 'Texto del usuario o nombre aproximado de la base.'
              },
              sample_limit: {
                type: 'number',
                description: 'Filas de muestra. Default 8, max 20.'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'getPymeCrmOverview',
          description: 'Calcula metricas del universo PyME y su cruce CRM/contact center: total PyME, con gestion CRM, con contacto valido, telefonos, emails y freshness.',
          parameters: {
            type: 'object',
            properties: {}
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'getPymeCrmSample',
          description: 'Entrega una muestra de empresas PyME cruzadas con CRM/contact center para responder solicitudes de ejemplos o adjuntos.',
          parameters: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Cantidad de filas a devolver. Maximo 100.'
              },
              only_with_crm: {
                type: 'boolean',
                description: 'Si true, solo trae empresas con historial CRM.'
              },
              only_valid_contact: {
                type: 'boolean',
                description: 'Si true, solo trae empresas con telefono o email recomendado.'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'createSegmentDownload',
          description: 'Crea un segmento filtrado sobre master_personas_view y devuelve una URL directa de descarga CSV. Usar cuando el usuario pide descargar/exportar/link/enlace/URL para una base segmentada. No usar para base completa sin filtros.',
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Nombre ejecutivo del segmento, por ejemplo "Base autos con propietario".'
              },
              description: {
                type: 'string',
                description: 'Descripción breve de los criterios usados.'
              },
              filters: {
                type: 'object',
                description: 'Filtros del segmento. Campos permitidos: region_part, domicilio_region, comuna_part, domicilio_comuna, n_autos, tiene_autos, tiene_empresa, tiene_bienes_raices, uso_propiedad_inferido, n_propiedades_residenciales, n_propiedades_comerciales, n_bienes_raices, totalavaluos, score_patrimonial, cobertura_pct.',
                properties: {
                  logic: {
                    type: 'string',
                    enum: ['AND', 'OR']
                  },
                  conditions: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        field: {
                          type: 'string',
                          enum: [
                            'region_part',
                            'domicilio_region',
                            'comuna_part',
                            'domicilio_comuna',
                            'n_autos',
                            'tiene_autos',
                            'tiene_empresa',
                            'tiene_bienes_raices',
                            'uso_propiedad_inferido',
                            'n_propiedades_residenciales',
                            'n_propiedades_comerciales',
                            'n_bienes_raices',
                            'totalavaluos',
                            'score_patrimonial',
                            'cobertura_pct'
                          ]
                        },
                        operator: {
                          type: 'string',
                          enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'not_in', 'is_null', 'is_not_null', 'contains', 'starts_with']
                        },
                        value: {
                          type: ['string', 'number', 'boolean', 'null'],
                          description: 'Valor primario del filtro. Para booleanos usa true/false; para números usa number; para texto usa string.',
                        },
                        value2: {
                          type: ['string', 'number', 'null'],
                          description: 'Segundo valor solo para between.',
                        }
                      },
                      required: ['field', 'operator']
                    }
                  }
                },
                required: ['logic', 'conditions']
              }
            },
            required: ['name', 'filters']
          }
        }
      }
    ]

    // 1. LLamada a InceptionLabs
    const firstLlmTimeout = withTimeoutSignal()
    let res = await fetch(INCEPTION_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${INCEPTION_KEY}`,
        'Content-Type': 'application/json'
      },
      signal: firstLlmTimeout.signal,
      body: JSON.stringify({
        model: 'mercury-2',
        messages: currentMessages,
        tools: tools,
        tool_choice: 'auto'
      })
    }).finally(firstLlmTimeout.clear)

    let data = await res.json()

    // 2. Ejecutar function calling si lo pide. Permitimos varias rondas para
    // casos como: validar freshness -> consultar overview -> pedir muestra.
    for (let round = 0; round < 4 && data.choices?.[0]?.message?.tool_calls; round += 1) {
      const toolCalls = data.choices[0].message.tool_calls
      currentMessages.push(data.choices[0].message)

      for (const tc of toolCalls as ToolCall[]) {
        try {
          const toolResult = await executeTool(tc.function.name, tc.function.arguments, {
            userId: user.id,
            origin: req.nextUrl.origin,
          })
          currentMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2)
          })
        } catch (toolError) {
          const message = toolError instanceof Error ? toolError.message : 'Error ejecutando herramienta.'
          currentMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `Error ejecutando ${tc.function.name}: ${message}`
          })
        }
      }

      // Volver a llamar al LLM con la data de la tool
      const roundLlmTimeout = withTimeoutSignal()
      res = await fetch(INCEPTION_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${INCEPTION_KEY}`,
          'Content-Type': 'application/json'
        },
        signal: roundLlmTimeout.signal,
        body: JSON.stringify({
          model: 'mercury-2',
          messages: currentMessages,
          tools,
          tool_choice: 'auto'
        })
      }).finally(roundLlmTimeout.clear)
      data = await res.json()
    }

    return NextResponse.json({ success: true, message: data.choices[0].message.content })
  } catch (error) {
    console.error('Error en AI Route:', error)
    return NextResponse.json({ error: 'Error procesando solicitud AI' }, { status: 500 })
  }
}
