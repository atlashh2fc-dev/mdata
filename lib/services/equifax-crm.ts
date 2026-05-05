import { createClient } from '@supabase/supabase-js'
import { db } from '@/lib/db/supabase'
import { detectEquifaxNonTargetCompany } from '@/lib/services/equifax-targeting'
import type {
  CampaignActionInstruction,
  CampaignSeverity,
  CommercialActionFeed,
  LeadActionInstruction,
} from '@/types'
import type { EquifaxCrmPushFilters } from '@/types/equifax'

const FETCH_CHUNK_SIZE = 1000
const INSERT_CHUNK_SIZE = 1000
const CRM_FILTER_CHUNK_SIZE = 250

type EquifaxRunRow = {
  id: string
  requested_volume: number | null
  ai_profile: Record<string, unknown> | null
  summary: Record<string, unknown> | null
  created_at: string | null
}

type EquifaxRunItemRow = {
  rutid: string
  company_name: string | null
  region: string | null
  comuna: string | null
  best_phone: string | null
  best_email: string | null
  phone_count: number | null
  email_count: number | null
  contact_probability: number | null
  interest_probability: number | null
  purchase_probability: number | null
  lead_score: number | null
  lead_temperature: 'green' | 'yellow' | 'red' | null
  recommended_channel: string | null
  recommended_hour: number | null
  is_existing_customer: boolean | null
  last_equifax_sale_at: string | null
  reason_tags: string[] | null
}

type PortfolioSummary = {
  total: number
  green: number
  yellow: number
  red: number
  averageLeadScore: number
  averageContactProbability: number
  averagePurchaseProbability: number
}

type CrmActiveTargetRow = {
  rutid: string
  campaign_name: string | null
  current_priority_score: number | null
  updated_at: string | null
}

type CrmRecentPushRow = {
  rutid: string
  created_at: string | null
}

type EquifaxCrmPushContext = {
  cohortLabel: string | null
  cohortTag: string | null
  priorityBoost: number
}

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value))
}

function round(value: number, decimals = 2) {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function safeAverage(values: number[]) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function buildWindowLabel(hour: number | null) {
  if (hour === null || !Number.isFinite(hour)) return 'Sin ventana'
  const normalized = ((Math.round(hour) % 24) + 24) % 24
  const nextHour = (normalized + 1) % 24
  return `${String(normalized).padStart(2, '0')}:00-${String(nextHour).padStart(2, '0')}:00`
}

function mode(values: Array<string | null | undefined>) {
  const counts = new Map<string, number>()
  for (const value of values) {
    const normalized = value?.trim()
    if (!normalized) continue
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
  }

  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
}

function modeHour(values: Array<number | null | undefined>) {
  const counts = new Map<number, number>()
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const normalized = ((Math.round(value) % 24) + 24) % 24
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
  }

  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map(value => value?.trim()).filter((value): value is string => Boolean(value)))]
}

function chunk<T>(items: T[], size: number) {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

function normalizeRutid(value?: string | null) {
  if (!value) return null

  const compact = value.toUpperCase().replace(/[^0-9K]/g, '')
  if (!compact) return null

  const trimmed = compact.replace(/^0+/, '')
  return trimmed || null
}

function normalizeTag(value?: string | null) {
  if (!value) return null
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || null
}

function getPushContext(run: EquifaxRunRow): EquifaxCrmPushContext {
  const rawLabel = typeof run.ai_profile?.crm_cohort_label === 'string'
    ? run.ai_profile.crm_cohort_label.trim()
    : null
  const rawTag = typeof run.ai_profile?.crm_reason_tag === 'string'
    ? run.ai_profile.crm_reason_tag.trim()
    : null
  const priorityBoost = Math.max(0, Math.min(30, Number(run.ai_profile?.crm_priority_boost ?? 0)))

  return {
    cohortLabel: rawLabel || null,
    cohortTag: rawTag || normalizeTag(rawLabel),
    priorityBoost: Number.isFinite(priorityBoost) ? priorityBoost : 0,
  }
}

function subtractDays(days: number) {
  return new Date(Date.now() - Math.max(0, days) * 24 * 60 * 60 * 1000).toISOString()
}

const DEFAULT_PUSH_FILTERS: EquifaxCrmPushFilters = {
  allowed_temperatures: ['green', 'yellow'],
  min_lead_score: 35,
  min_contact_probability: 35,
  min_purchase_probability: 10,
  exclude_existing_customers: false,
  exclude_active_crm_targets: true,
  exclude_recent_crm_days: 7,
  max_leads: null,
}

function normalizePushFilters(filters?: Partial<EquifaxCrmPushFilters>): EquifaxCrmPushFilters {
  const temperatures = Array.isArray(filters?.allowed_temperatures) && filters?.allowed_temperatures.length
    ? filters.allowed_temperatures.filter(item => item === 'green' || item === 'yellow' || item === 'red')
    : DEFAULT_PUSH_FILTERS.allowed_temperatures

  return {
    allowed_temperatures: temperatures.length ? temperatures : DEFAULT_PUSH_FILTERS.allowed_temperatures,
    min_lead_score: Math.max(0, Number(filters?.min_lead_score ?? DEFAULT_PUSH_FILTERS.min_lead_score)),
    min_contact_probability: Math.max(0, Number(filters?.min_contact_probability ?? DEFAULT_PUSH_FILTERS.min_contact_probability)),
    min_purchase_probability: Math.max(0, Number(filters?.min_purchase_probability ?? DEFAULT_PUSH_FILTERS.min_purchase_probability)),
    exclude_existing_customers: filters?.exclude_existing_customers === true,
    exclude_active_crm_targets: filters?.exclude_active_crm_targets !== false,
    exclude_recent_crm_days: Math.max(0, Math.round(Number(filters?.exclude_recent_crm_days ?? DEFAULT_PUSH_FILTERS.exclude_recent_crm_days))),
    max_leads: filters?.max_leads === null || filters?.max_leads === undefined
      ? DEFAULT_PUSH_FILTERS.max_leads
      : Math.max(1, Math.round(Number(filters.max_leads))),
  }
}

function getCrmOperationalClient() {
  const url = process.env.REGISTRO_INTEL_SUPABASE_URL
  const key =
    process.env.REGISTRO_INTEL_SERVICE_ROLE_KEY ||
    process.env.REGISTRO_INTEL_SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('Faltan REGISTRO_INTEL_SUPABASE_URL o REGISTRO_INTEL_SERVICE_ROLE_KEY para exportar al CRM.')
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

async function fetchCrmActiveTargets(
  crm: ReturnType<typeof getCrmOperationalClient>,
  rutids: string[]
) {
  const normalizedRutids = [...new Set(
    rutids
      .map(rutid => normalizeRutid(rutid))
      .filter((rutid): rutid is string => Boolean(rutid))
  )]

  if (!normalizedRutids.length) return new Map<string, CrmActiveTargetRow>()

  const map = new Map<string, CrmActiveTargetRow>()
  for (const subset of chunk(normalizedRutids, CRM_FILTER_CHUNK_SIZE)) {
    const { data, error } = await crm
      .from('commercial_brain_active_targets_v1')
      .select('rutid,campaign_name,current_priority_score,updated_at')
      .in('rutid', subset)
      .order('current_priority_score', { ascending: false })
      .order('updated_at', { ascending: false })

    if (error) {
      throw new Error(`No pude leer los leads activos del CRM: ${error.message}`)
    }

    for (const row of (data ?? []) as CrmActiveTargetRow[]) {
      const normalized = normalizeRutid(row.rutid)
      if (normalized && !map.has(normalized)) {
        map.set(normalized, row)
      }
    }
  }

  return map
}

async function fetchRecentCrmPushes(
  crm: ReturnType<typeof getCrmOperationalClient>,
  rutids: string[],
  lookbackDays: number
) {
  const normalizedRutids = [...new Set(
    rutids
      .map(rutid => normalizeRutid(rutid))
      .filter((rutid): rutid is string => Boolean(rutid))
  )]

  if (!normalizedRutids.length || lookbackDays <= 0) return new Map<string, CrmRecentPushRow>()

  const map = new Map<string, CrmRecentPushRow>()
  for (const subset of chunk(normalizedRutids, CRM_FILTER_CHUNK_SIZE)) {
    const { data, error } = await crm
      .from('commercial_brain_lead_actions')
      .select('rutid,created_at')
      .in('rutid', subset)
      .gte('created_at', subtractDays(lookbackDays))
      .order('created_at', { ascending: false })

    if (error) {
      throw new Error(`No pude leer pushes recientes del CRM: ${error.message}`)
    }

    for (const row of (data ?? []) as CrmRecentPushRow[]) {
      const normalized = normalizeRutid(row.rutid)
      if (normalized && !map.has(normalized)) {
        map.set(normalized, row)
      }
    }
  }

  return map
}

async function fetchRun(runId: string): Promise<EquifaxRunRow> {
  const { data, error } = await db
    .from('equifax_generation_runs')
    .select('id,requested_volume,ai_profile,summary,created_at')
    .eq('id', runId)
    .single()

  if (error || !data) {
    throw new Error('No encontré la corrida Equifax indicada.')
  }

  return data as EquifaxRunRow
}

async function fetchRunItems(runId: string): Promise<EquifaxRunItemRow[]> {
  const rows: EquifaxRunItemRow[] = []

  for (let start = 0; ; start += FETCH_CHUNK_SIZE) {
    const { data, error } = await db
      .from('equifax_generation_run_items')
      .select(`
        rutid,
        company_name,
        region,
        comuna,
        best_phone,
        best_email,
        phone_count,
        email_count,
        contact_probability,
        interest_probability,
        purchase_probability,
        lead_score,
        lead_temperature,
        recommended_channel,
        recommended_hour,
        is_existing_customer,
        last_equifax_sale_at,
        reason_tags
      `)
      .eq('run_id', runId)
      .order('lead_score', { ascending: false })
      .range(start, start + FETCH_CHUNK_SIZE - 1)

    if (error) {
      throw new Error(`No pude leer los leads del run Equifax: ${error.message}`)
    }

    const chunk = (data ?? []) as EquifaxRunItemRow[]
    rows.push(...chunk)

    if (chunk.length < FETCH_CHUNK_SIZE) break
  }

  return rows
}

function getScenarioTitle(run: EquifaxRunRow) {
  const candidate = run.ai_profile?.selected_scenario_title
  return typeof candidate === 'string' && candidate.trim()
    ? candidate.trim()
    : 'Base priorizada Equifax'
}

function getScenarioKey(run: EquifaxRunRow) {
  const candidate = run.ai_profile?.selected_scenario_key
  return typeof candidate === 'string' && candidate.trim()
    ? candidate.trim()
    : 'equifax-prioritized'
}

function getCrmCampaignName() {
  return 'Equifax'
}

function getCampaignDisplayLabel(run: EquifaxRunRow) {
  return `${getCrmCampaignName()} | ${getScenarioTitle(run)}`
}

function summarizePortfolio(rows: EquifaxRunItemRow[]): PortfolioSummary {
  const green = rows.filter(row => row.lead_temperature === 'green').length
  const yellow = rows.filter(row => row.lead_temperature === 'yellow').length
  const red = rows.filter(row => row.lead_temperature === 'red').length

  return {
    total: rows.length,
    green,
    yellow,
    red,
    averageLeadScore: round(safeAverage(rows.map(row => Number(row.lead_score ?? 0))), 2),
    averageContactProbability: round(safeAverage(rows.map(row => Number(row.contact_probability ?? 0))), 2),
    averagePurchaseProbability: round(safeAverage(rows.map(row => Number(row.purchase_probability ?? 0))), 2),
  }
}

function deriveSeverity(summary: PortfolioSummary): CampaignSeverity {
  if (!summary.total) return 'critical'

  const greenShare = summary.green / summary.total
  const redShare = summary.red / summary.total

  if (greenShare >= 0.55 && redShare <= 0.15) return 'healthy'
  if (greenShare >= 0.35 && redShare <= 0.25) return 'watch'
  if (greenShare >= 0.2 && redShare <= 0.4) return 'risk'
  return 'critical'
}

function deriveCampaignAction(summary: PortfolioSummary) {
  if (!summary.total) {
    return 'No hay leads listos para exportar; recalcula escenarios o ajusta filtros.'
  }

  if (summary.green >= summary.yellow && summary.green >= summary.red) {
    return 'Inyectar la base verde al CRM y ejecutar contacto inmediato con foco en cierre rápido.'
  }

  if (summary.yellow > summary.green) {
    return 'Trabajar primero una secuencia mixta llamada + email para madurar la base antes de escalar volumen.'
  }

  return 'Reducir fatiga comercial, enriquecer datos y reanalizar antes de presionar fuerte sobre la base.'
}

function deriveCampaignAdjustments(rows: EquifaxRunItemRow[], summary: PortfolioSummary) {
  const adjustments: string[] = []
  const withPhone = rows.filter(row => Number(row.phone_count ?? 0) > 0).length
  const withEmail = rows.filter(row => Number(row.email_count ?? 0) > 0).length

  if (summary.red > 0) {
    adjustments.push('Separar los rojos para enriquecimiento de datos antes de inyección masiva.')
  }
  if (withPhone < rows.length) {
    adjustments.push('Privilegiar llamadas en los leads con teléfono disponible y reservar email para cobertura secundaria.')
  }
  if (withEmail < rows.length) {
    adjustments.push('Preparar secuencia de email solo para registros con correo válido y evitar cadencias ciegas.')
  }
  if (!adjustments.length) {
    adjustments.push('Mantener cadencia corta y derivar rápido a ejecutivo cuando haya señal de interés.')
  }

  return adjustments.slice(0, 3)
}

function deriveCampaignCauses(rows: EquifaxRunItemRow[], summary: PortfolioSummary) {
  const causes: string[] = []
  if (summary.red > 0) causes.push('parte de la base requiere enriquecimiento o menor presión comercial')
  if (rows.some(row => Boolean(row.is_existing_customer))) causes.push('hay espacio de upsell y cross-sell sobre clientes históricos')
  if (rows.some(row => !row.is_existing_customer)) causes.push('existe expansión hacia prospectos nuevos similares al histórico ganador')
  if (rows.some(row => Number(row.phone_count ?? 0) > 0 && Number(row.email_count ?? 0) > 0)) {
    causes.push('la base tiene cobertura multicanal suficiente para gestión inmediata')
  }
  return uniqueStrings(causes).slice(0, 4)
}

function deriveFatigueScore(row: EquifaxRunItemRow) {
  const phoneCount = Number(row.phone_count ?? 0)
  const emailCount = Number(row.email_count ?? 0)
  const contactProbability = Number(row.contact_probability ?? 0)
  const purchaseProbability = Number(row.purchase_probability ?? 0)

  let score =
    (100 - contactProbability) * 0.28 +
    (100 - purchaseProbability) * 0.12

  if (phoneCount === 0) score += 18
  if (emailCount === 0) score += 12
  if (row.lead_temperature === 'yellow') score += 8
  if (row.lead_temperature === 'red') score += 18

  if (row.last_equifax_sale_at) {
    const saleDate = new Date(row.last_equifax_sale_at)
    if (!Number.isNaN(saleDate.getTime())) {
      const daysSinceSale = (Date.now() - saleDate.getTime()) / (1000 * 60 * 60 * 24)
      if (daysSinceSale <= 30) score += 25
      else if (daysSinceSale <= 90) score += 12
    }
  }

  return clamp(round(score, 1))
}

function deriveRecommendedChannel(row: EquifaxRunItemRow) {
  if (row.recommended_channel?.trim()) return row.recommended_channel.trim()
  if (Number(row.phone_count ?? 0) > 0) return 'call'
  if (Number(row.email_count ?? 0) > 0) return 'email'
  return 'other'
}

function deriveNextBestAction(row: EquifaxRunItemRow) {
  const hasPhone = Number(row.phone_count ?? 0) > 0
  const hasEmail = Number(row.email_count ?? 0) > 0

  if (row.lead_temperature === 'green') {
    if (row.is_existing_customer) return 'Llamar hoy para upsell/cross-sell Equifax'
    if (hasPhone) return 'Llamar hoy y buscar agenda comercial inmediata'
    if (hasEmail) return 'Enviar propuesta hoy y seguimiento comercial en la misma jornada'
    return 'Validar datos de contacto y pasar a ejecutivo para enriquecimiento rápido'
  }

  if (row.lead_temperature === 'yellow') {
    if (hasPhone && hasEmail) return 'Secuencia mixta: llamada prioritaria y email de respaldo'
    if (hasPhone) return 'Llamar con guion corto y reintentar en mejor ventana'
    if (hasEmail) return 'Enviar correo de apertura y medir interacción antes de llamar'
    return 'Completar contacto antes de entrar en cadencia comercial'
  }

  return 'Enriquecer contacto y recalibrar prioridad antes de presionar venta'
}

function buildLeadInstruction(
  row: EquifaxRunItemRow,
  campaignName: string,
  scenarioKey: string,
  context?: EquifaxCrmPushContext
): LeadActionInstruction {
  const priorityBoost = Number(context?.priorityBoost ?? 0)
  const reasonTags = uniqueStrings([
    ...(row.reason_tags ?? []),
    `equifax-${scenarioKey}`,
    row.lead_temperature ? `temp-${row.lead_temperature}` : null,
    row.is_existing_customer ? 'equifax-cliente' : 'equifax-prospecto',
    context?.cohortTag ? `cohorte-${context.cohortTag}` : null,
  ])

  return {
    rutid: row.rutid,
    campaign_name: campaignName,
    dynamic_priority_score: clamp(round(Number(row.lead_score ?? 0) + priorityBoost, 2)),
    contact_probability: round(Number(row.contact_probability ?? 0), 2),
    conversion_probability: round(Number(row.purchase_probability ?? 0), 2),
    fatigue_score: deriveFatigueScore(row),
    optimal_window: buildWindowLabel(row.recommended_hour),
    recommended_channel: deriveRecommendedChannel(row),
    next_best_action: context?.cohortLabel
      ? `${deriveNextBestAction(row)} · cohorte ${context.cohortLabel}`
      : deriveNextBestAction(row),
    reason_tags: reasonTags.slice(0, 10),
  }
}

function buildCampaignInstruction(
  run: EquifaxRunRow,
  rows: EquifaxRunItemRow[],
  summary: PortfolioSummary,
  campaignName: string
): CampaignActionInstruction {
  const dominantChannel = mode(rows.map(row => deriveRecommendedChannel(row)))
  const dominantHour = modeHour(rows.map(row => row.recommended_hour))
  const severity = deriveSeverity(summary)

  return {
    campaign_name: campaignName,
    severity,
    health_score: round(summary.averageLeadScore, 2),
    underperformance_hours: 0,
    recommended_action: deriveCampaignAction(summary),
    recommended_adjustments: deriveCampaignAdjustments(rows, summary),
    best_next_window: buildWindowLabel(dominantHour),
    top_channel: dominantChannel,
    probable_causes: deriveCampaignCauses(rows, summary),
  }
}

function buildExecutiveSummary(
  run: EquifaxRunRow,
  summary: PortfolioSummary,
  campaignLabel: string
) {
  const requestedVolume = Number(run.requested_volume ?? summary.total)
  return `${campaignLabel}: ${summary.total} leads listos sobre ${requestedVolume} solicitados, con ${summary.green} verdes, ${summary.yellow} amarillos y ${summary.red} rojos. Lead score promedio ${round(summary.averageLeadScore, 1)}%, contacto ${round(summary.averageContactProbability, 1)}% y compra ${round(summary.averagePurchaseProbability, 1)}%.`
}

export async function getEquifaxRunActionFeed(runId: string): Promise<CommercialActionFeed> {
  const run = await fetchRun(runId)
  const rows = (await fetchRunItems(runId)).filter(row => !detectEquifaxNonTargetCompany(row.company_name))
  const summary = summarizePortfolio(rows)
  const campaignLabel = getCampaignDisplayLabel(run)
  const scenarioKey = getScenarioKey(run)
  const campaignName = getCrmCampaignName()

  return {
    source_system: 'rut_intelligence_equifax',
    generated_at: new Date().toISOString(),
    portfolio_status: {
      overall_health_score: round(summary.averageLeadScore, 2),
      campaigns_at_risk: summary.red > 0 ? 1 : 0,
      critical_campaigns: deriveSeverity(summary) === 'critical' ? 1 : 0,
      anomaly_count: summary.red,
    },
    executive_summary: buildExecutiveSummary(run, summary, campaignLabel),
    campaign_instructions: [
      buildCampaignInstruction(run, rows, summary, campaignName),
    ],
    lead_instructions: rows.map(row => buildLeadInstruction(row, campaignName, scenarioKey)),
    recommendations: [],
  }
}

async function filterRowsForCrmPush(
  crm: ReturnType<typeof getCrmOperationalClient>,
  rows: EquifaxRunItemRow[],
  filters?: Partial<EquifaxCrmPushFilters>
) {
  const normalizedFilters = normalizePushFilters(filters)
  let skippedActiveTargets = 0
  let skippedNonTargetEntities = 0
  let skippedRecentPushes = 0

  const rutids = rows.map(row => row.rutid)
  const [activeTargets, recentPushes] = await Promise.all([
    normalizedFilters.exclude_active_crm_targets
      ? fetchCrmActiveTargets(crm, rutids)
      : Promise.resolve(new Map<string, CrmActiveTargetRow>()),
    normalizedFilters.exclude_recent_crm_days > 0
      ? fetchRecentCrmPushes(crm, rutids, normalizedFilters.exclude_recent_crm_days)
      : Promise.resolve(new Map<string, CrmRecentPushRow>()),
  ])

  const filtered = rows.filter(row => {
    if (detectEquifaxNonTargetCompany(row.company_name)) {
      skippedNonTargetEntities += 1
      return false
    }
    if (!normalizedFilters.allowed_temperatures.includes(row.lead_temperature ?? 'red')) return false
    if (Number(row.lead_score ?? 0) < normalizedFilters.min_lead_score) return false
    if (Number(row.contact_probability ?? 0) < normalizedFilters.min_contact_probability) return false
    if (Number(row.purchase_probability ?? 0) < normalizedFilters.min_purchase_probability) return false
    if (normalizedFilters.exclude_existing_customers && row.is_existing_customer) return false

    const normalizedRutid = normalizeRutid(row.rutid)
    if (normalizedRutid && activeTargets.has(normalizedRutid)) {
      skippedActiveTargets += 1
      return false
    }

    if (normalizedRutid && recentPushes.has(normalizedRutid)) {
      skippedRecentPushes += 1
      return false
    }

    return true
  })

  const limited = normalizedFilters.max_leads
    ? filtered.slice(0, normalizedFilters.max_leads)
    : filtered

  return {
    filters: normalizedFilters,
    rows: limited,
    attempted_leads: rows.length,
    eligible_leads: limited.length,
    skipped_active_targets: skippedActiveTargets,
    skipped_non_target_entities: skippedNonTargetEntities,
    skipped_recent_pushes: skippedRecentPushes,
  }
}

function buildCleanupLeadInstruction(
  row: EquifaxRunItemRow,
  campaignName: string
): LeadActionInstruction {
  const nonTargetMatch = detectEquifaxNonTargetCompany(row.company_name)
  const reasonTags = uniqueStrings([
    ...(row.reason_tags ?? []),
    'equifax-cleanup',
    'equifax-no-target',
    nonTargetMatch?.tag ?? null,
  ])

  return {
    rutid: row.rutid,
    campaign_name: campaignName,
    dynamic_priority_score: 0,
    contact_probability: 0,
    conversion_probability: 0,
    fatigue_score: 100,
    optimal_window: 'Sin ventana',
    recommended_channel: 'other',
    next_best_action: 'Excluir del playbook Equifax: entidad no target',
    reason_tags: reasonTags.slice(0, 10),
  }
}

async function insertCampaignActions(
  crm: ReturnType<typeof getCrmOperationalClient>,
  runId: string,
  actions: CampaignActionInstruction[]
) {
  if (!actions.length) return 0

  const { error } = await crm
    .from('commercial_brain_campaign_actions')
    .insert(actions.map(item => ({
      run_id: runId,
      campaign_name: item.campaign_name,
      severity: item.severity,
      health_score: item.health_score,
      underperformance_hours: item.underperformance_hours,
      recommended_action: item.recommended_action,
      recommended_adjustments: item.recommended_adjustments ?? [],
      best_next_window: item.best_next_window ?? null,
      top_channel: item.top_channel ?? null,
      probable_causes: item.probable_causes ?? [],
    })))

  if (error) {
    throw new Error(`No pude insertar campaign actions Equifax: ${error.message}`)
  }

  return actions.length
}

async function insertLeadActions(
  crm: ReturnType<typeof getCrmOperationalClient>,
  runId: string,
  actions: LeadActionInstruction[]
) {
  let inserted = 0

  for (let start = 0; start < actions.length; start += INSERT_CHUNK_SIZE) {
    const chunk = actions.slice(start, start + INSERT_CHUNK_SIZE)
    const { error } = await crm
      .from('commercial_brain_lead_actions')
      .insert(chunk.map(item => ({
        run_id: runId,
        rutid: item.rutid,
        campaign_name: item.campaign_name ?? null,
        dynamic_priority_score: item.dynamic_priority_score,
        contact_probability: item.contact_probability,
        conversion_probability: item.conversion_probability,
        fatigue_score: item.fatigue_score,
        optimal_window: item.optimal_window ?? null,
        recommended_channel: item.recommended_channel ?? null,
        next_best_action: item.next_best_action ?? null,
        reason_tags: item.reason_tags ?? [],
      })))

    if (error) {
      throw new Error(`No pude insertar lead actions Equifax: ${error.message}`)
    }

    inserted += chunk.length
  }

  return inserted
}

export async function pushEquifaxRunToCrm(runId: string, filters?: Partial<EquifaxCrmPushFilters>) {
  const crm = getCrmOperationalClient()
  const run = await fetchRun(runId)
  const allRows = await fetchRunItems(runId)
  const filtered = await filterRowsForCrmPush(crm, allRows, filters)
  const summary = summarizePortfolio(filtered.rows)
  const campaignLabel = getCampaignDisplayLabel(run)
  const scenarioKey = getScenarioKey(run)
  const campaignName = getCrmCampaignName()
  const pushContext = getPushContext(run)

  const feed: CommercialActionFeed = {
    source_system: 'rut_intelligence_equifax',
    generated_at: new Date().toISOString(),
    portfolio_status: {
      overall_health_score: round(summary.averageLeadScore, 2),
      campaigns_at_risk: summary.red > 0 ? 1 : 0,
      critical_campaigns: deriveSeverity(summary) === 'critical' ? 1 : 0,
      anomaly_count: summary.red,
    },
    executive_summary: buildExecutiveSummary(run, summary, campaignLabel),
    campaign_instructions: [
      buildCampaignInstruction(run, filtered.rows, summary, campaignName),
    ],
    lead_instructions: filtered.rows.map(row => buildLeadInstruction(row, campaignName, scenarioKey, pushContext)),
    recommendations: [],
  }

  const { data: insertedRun, error: runError } = await crm
    .from('commercial_brain_action_runs')
    .insert({
      source_system: feed.source_system,
      generated_at: feed.generated_at,
      portfolio_status: feed.portfolio_status,
      executive_summary: feed.executive_summary ?? null,
      metadata: {
        source_module: 'equifax-bdd',
        equifax_run_id: runId,
        push_filters: filtered.filters,
        attempted_leads: filtered.attempted_leads,
        eligible_leads: filtered.eligible_leads,
        skipped_active_targets: filtered.skipped_active_targets,
        skipped_non_target_entities: filtered.skipped_non_target_entities,
        skipped_recent_pushes: filtered.skipped_recent_pushes,
        campaign_instructions: feed.campaign_instructions.length,
        lead_instructions: feed.lead_instructions.length,
        summary,
        campaign_label: campaignLabel,
        cohort_label: pushContext.cohortLabel,
        cohort_tag: pushContext.cohortTag,
        priority_boost: pushContext.priorityBoost,
      },
    })
    .select('id')
    .single()

  if (runError || !insertedRun?.id) {
    throw new Error(`No pude crear el run CRM para Equifax: ${runError?.message ?? 'sin id'}`)
  }

  const crmRunId = String(insertedRun.id)
  const campaignCount = await insertCampaignActions(crm, crmRunId, feed.campaign_instructions)
  const leadCount = await insertLeadActions(crm, crmRunId, feed.lead_instructions)

  const { data: applyResult, error: applyError } = await crm.rpc('apply_commercial_brain_run', {
    p_run_id: crmRunId,
  })

  if (applyError) {
    throw new Error(`No pude aplicar el run Equifax al CRM: ${applyError.message}`)
  }

  return {
    run_id: runId,
    crm_run_id: crmRunId,
    source_system: feed.source_system,
    attempted_leads: filtered.attempted_leads,
    eligible_leads: filtered.eligible_leads,
    campaign_instructions: campaignCount,
    lead_instructions: leadCount,
    skipped_active_targets: filtered.skipped_active_targets,
    skipped_non_target_entities: filtered.skipped_non_target_entities,
    skipped_recent_pushes: filtered.skipped_recent_pushes,
    pushed_at: new Date().toISOString(),
    apply_result: applyResult ?? null,
  }
}

export async function deprioritizeNonTargetEquifaxRunInCrm(runId: string) {
  const crm = getCrmOperationalClient()
  const sourceRun = await fetchRun(runId)
  const campaignName = getCrmCampaignName()
  const allRows = await fetchRunItems(runId)
  const nonTargetRows = allRows.filter(row => detectEquifaxNonTargetCompany(row.company_name))

  if (!nonTargetRows.length) {
    return {
      run_id: runId,
      crm_run_id: null,
      source_system: 'rut_intelligence_equifax_cleanup',
      attempted_leads: allRows.length,
      non_target_leads: 0,
      lead_instructions: 0,
      pushed_at: new Date().toISOString(),
      apply_result: null,
    }
  }

  const feed: CommercialActionFeed = {
    source_system: 'rut_intelligence_equifax_cleanup',
    generated_at: new Date().toISOString(),
    portfolio_status: {
      overall_health_score: 0,
      campaigns_at_risk: 0,
      critical_campaigns: 0,
      anomaly_count: nonTargetRows.length,
    },
    executive_summary: `${campaignName}: depuracion de ${nonTargetRows.length} entidades no target detectadas en run ${runId}.`,
    campaign_instructions: [],
    lead_instructions: nonTargetRows.map(row => buildCleanupLeadInstruction(row, campaignName)),
    recommendations: [],
  }

  const { data: insertedRun, error: runError } = await crm
    .from('commercial_brain_action_runs')
    .insert({
      source_system: feed.source_system,
      generated_at: feed.generated_at,
      portfolio_status: feed.portfolio_status,
      executive_summary: feed.executive_summary,
      metadata: {
        source_module: 'equifax-bdd',
        cleanup_type: 'deprioritize_non_target',
        source_equifax_run_id: runId,
        source_run_created_at: sourceRun.created_at,
        attempted_leads: allRows.length,
        non_target_leads: nonTargetRows.length,
        lead_instructions: feed.lead_instructions.length,
      },
    })
    .select('id')
    .single()

  if (runError || !insertedRun?.id) {
    throw new Error(`No pude crear el run CRM de limpieza Equifax: ${runError?.message ?? 'sin id'}`)
  }

  const crmRunId = String(insertedRun.id)
  const leadCount = await insertLeadActions(crm, crmRunId, feed.lead_instructions)

  const { data: applyResult, error: applyError } = await crm.rpc('apply_commercial_brain_run', {
    p_run_id: crmRunId,
  })

  if (applyError) {
    throw new Error(`No pude aplicar el run de limpieza Equifax al CRM: ${applyError.message}`)
  }

  return {
    run_id: runId,
    crm_run_id: crmRunId,
    source_system: feed.source_system,
    attempted_leads: allRows.length,
    non_target_leads: nonTargetRows.length,
    lead_instructions: leadCount,
    pushed_at: new Date().toISOString(),
    apply_result: applyResult ?? null,
  }
}
