import { db, hasSupabaseAdminEnv } from '@/lib/db/supabase'
import type { EquifaxProjectionSummary } from '@/types/equifax'

export type EquifaxCrmRole = 'manager' | 'supervisor' | 'executive'

type FeedbackRow = {
  id: string
  rutid: string | null
  matched_rutid: string | null
  campaign_name: string | null
  channel: string | null
  managed_at: string
  effective_contact: boolean | null
  interested: boolean | null
  sale: boolean | null
  callback_requested: boolean | null
  duration_seconds: number | null
  agent_name: string | null
}

type EquifaxLeadScoreRow = {
  rutid: string
  lead_temperature: 'green' | 'yellow' | 'red' | null
}

type MetricTotals = {
  attempts: number
  unique_leads: number
  contacts: number
  interests: number
  purchases: number
  contact_rate: number
  interest_rate: number
  purchase_rate: number
}

export type EquifaxRoleViewGoals = {
  contacts: number
  interests: number
  purchases: number
  source: 'env' | 'projection_top_1000'
}

export type EquifaxRoleAgentRanking = MetricTotals & {
  agent_name: string
}

export type EquifaxRoleViewData = {
  role: EquifaxCrmRole
  generated_at: string
  time_zone: string
  window: {
    start: string
    end: string
    label: string
  }
  agents: string[]
  agent_selected: string | null
  kpis: MetricTotals
  rankings: EquifaxRoleAgentRanking[]
  semaforo: {
    portfolio: { green: number; yellow: number; red: number }
    managed_today: { green: number; yellow: number; red: number; unknown: number }
  }
  projection: EquifaxProjectionSummary | null
  goals: EquifaxRoleViewGoals | null
  actions: string[]
  warnings: string[]
}

const DEFAULT_TIME_ZONE = 'America/Santiago'
const FEEDBACK_FETCH_CHUNK = 5000
const SCORE_FETCH_CHUNK = 500

function safeRate(numerator: number, denominator: number) {
  if (!denominator) return 0
  return (numerator / denominator) * 100
}

function normalizeRutid(value?: string | null): string | null {
  if (!value) return null
  const compact = value.toUpperCase().replace(/[^0-9K]/g, '')
  if (!compact) return null
  const trimmed = compact.replace(/^0+/, '')
  return trimmed || null
}

function parseGmtOffsetMinutes(value: string): number | null {
  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(value.trim())
  if (!match) return null
  const sign = match[1] === '-' ? -1 : 1
  const hours = Number(match[2] ?? 0)
  const minutes = Number(match[3] ?? 0)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  return sign * (hours * 60 + minutes)
}

function getTimeZoneOffsetMinutes(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const label = parts.find(part => part.type === 'timeZoneName')?.value ?? 'GMT+0'
  return parseGmtOffsetMinutes(label) ?? 0
}

function zonedTimeToUtc(
  input: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  timeZone: string
) {
  const hour = input.hour ?? 0
  const minute = input.minute ?? 0
  const second = input.second ?? 0

  let utcMs = Date.UTC(input.year, input.month - 1, input.day, hour, minute, second)
  for (let i = 0; i < 2; i += 1) {
    const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, new Date(utcMs))
    utcMs = Date.UTC(input.year, input.month - 1, input.day, hour, minute, second) - offsetMinutes * 60_000
  }
  return new Date(utcMs)
}

function getZonedYmd(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)

  const year = Number(parts.find(part => part.type === 'year')?.value ?? '')
  const month = Number(parts.find(part => part.type === 'month')?.value ?? '')
  const day = Number(parts.find(part => part.type === 'day')?.value ?? '')
  return { year, month, day }
}

function isEquifaxCampaign(value?: string | null) {
  return Boolean(value && /equifax/i.test(value))
}

function hasPayload(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length > 0)
}

async function loadLatestEquifaxProjectionSummary(): Promise<EquifaxProjectionSummary | null> {
  if (!hasSupabaseAdminEnv) return null

  const { data: latest, error: latestError } = await db
    .from('equifax_scoring_pipeline_runs')
    .select('status,projection_payload,started_at')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latestError) {
    throw new Error(`No pude leer la última corrida Equifax: ${latestError.message}`)
  }

  const latestPayload = hasPayload(latest?.projection_payload) ? latest.projection_payload : null
  if (latestPayload) return latestPayload as unknown as EquifaxProjectionSummary

  const { data: latestSuccess, error: successError } = await db
    .from('equifax_scoring_pipeline_runs')
    .select('projection_payload,started_at')
    .eq('status', 'success')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (successError) {
    throw new Error(`No pude leer la última corrida Equifax exitosa: ${successError.message}`)
  }

  const successPayload = hasPayload(latestSuccess?.projection_payload) ? latestSuccess.projection_payload : null
  return successPayload ? (successPayload as unknown as EquifaxProjectionSummary) : null
}

function readGoalsFromEnv(role: EquifaxCrmRole): EquifaxRoleViewGoals | null {
  const raw = process.env.EQUIFAX_CRM_GOALS_JSON
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const candidate = (parsed[role] ?? parsed.default) as Record<string, unknown> | undefined
    if (!candidate) return null

    const contacts = Number(candidate.contacts)
    const interests = Number(candidate.interests)
    const purchases = Number(candidate.purchases)
    if (![contacts, interests, purchases].every(Number.isFinite)) return null

    return {
      contacts: Math.max(0, Math.round(contacts)),
      interests: Math.max(0, Math.round(interests)),
      purchases: Math.max(0, Math.round(purchases)),
      source: 'env',
    }
  } catch {
    return null
  }
}

function buildGoalFallbackFromProjection(projection: EquifaxProjectionSummary | null): EquifaxRoleViewGoals | null {
  if (!projection) return null

  return {
    contacts: Math.max(0, Math.round(Number(projection.top_1000.expected_contacts ?? 0))),
    interests: Math.max(0, Math.round(Number(projection.top_1000.expected_interests ?? 0))),
    purchases: Math.max(0, Math.round(Number(projection.top_1000.expected_purchases ?? 0))),
    source: 'projection_top_1000',
  }
}

async function fetchEquifaxFeedbackRows(
  windowStartIso: string,
  windowEndIso: string,
  agentName?: string | null
) {
  const rows: FeedbackRow[] = []

  for (let start = 0; ; start += FEEDBACK_FETCH_CHUNK) {
    let query = db
      .from('contact_center_feedback')
      .select('id,rutid,matched_rutid,campaign_name,channel,managed_at,effective_contact,interested,sale,callback_requested,duration_seconds,agent_name')
      .ilike('campaign_name', '%equifax%')
      .gte('managed_at', windowStartIso)
      .lt('managed_at', windowEndIso)
      .order('managed_at', { ascending: false })
      .range(start, start + FEEDBACK_FETCH_CHUNK - 1)

    if (agentName) {
      query = query.eq('agent_name', agentName)
    }

    const { data, error } = await query

    if (error) {
      throw new Error(`No se pudo leer el feedback CRM para Equifax: ${error.message}`)
    }

    const chunk = (data ?? []) as FeedbackRow[]
    rows.push(...chunk)
    if (chunk.length < FEEDBACK_FETCH_CHUNK) break
  }

  return rows.filter(row => isEquifaxCampaign(row.campaign_name))
}

async function fetchLeadTemperatures(rutids: string[]) {
  const map = new Map<string, EquifaxLeadScoreRow['lead_temperature']>()
  const unique = [...new Set(rutids.map(normalizeRutid).filter((value): value is string => Boolean(value)))]
  if (!unique.length) return map

  for (let start = 0; start < unique.length; start += SCORE_FETCH_CHUNK) {
    const subset = unique.slice(start, start + SCORE_FETCH_CHUNK)
    const { data, error } = await db
      .from('equifax_lead_scores')
      .select('rutid,lead_temperature')
      .in('rutid', subset)

    if (error) {
      throw new Error(`No se pudieron leer los semáforos Equifax: ${error.message}`)
    }

    for (const row of (data ?? []) as EquifaxLeadScoreRow[]) {
      map.set(row.rutid, row.lead_temperature ?? null)
    }
  }

  return map
}

function aggregateTotals(rows: FeedbackRow[]) {
  let attempts = 0
  let contacts = 0
  let interests = 0
  let purchases = 0
  const uniqueLeads = new Set<string>()

  for (const row of rows) {
    attempts += 1
    const rutid = normalizeRutid(row.matched_rutid ?? row.rutid)
    if (rutid) uniqueLeads.add(rutid)
    if (row.effective_contact) contacts += 1
    if (row.interested) interests += 1
    if (row.sale) purchases += 1
  }

  return {
    attempts,
    unique_leads: uniqueLeads.size,
    contacts,
    interests,
    purchases,
    contact_rate: safeRate(contacts, attempts),
    interest_rate: safeRate(interests, attempts),
    purchase_rate: safeRate(purchases, attempts),
  }
}

function buildRankings(rows: FeedbackRow[]) {
  const buckets = new Map<string, { rows: FeedbackRow[]; uniqueLeads: Set<string> }>()

  for (const row of rows) {
    const agentName = row.agent_name?.trim() || 'Sin agente'
    const bucket = buckets.get(agentName) ?? { rows: [], uniqueLeads: new Set<string>() }
    bucket.rows.push(row)
    const rutid = normalizeRutid(row.matched_rutid ?? row.rutid)
    if (rutid) bucket.uniqueLeads.add(rutid)
    buckets.set(agentName, bucket)
  }

  const rankings: EquifaxRoleAgentRanking[] = []
  for (const [agent_name, bucket] of buckets.entries()) {
    const totals = aggregateTotals(bucket.rows)
    rankings.push({
      agent_name,
      ...totals,
      unique_leads: bucket.uniqueLeads.size,
    })
  }

  return rankings
    .sort((left, right) => {
      const byPurchases = right.purchases - left.purchases
      if (byPurchases) return byPurchases
      const byContacts = right.contacts - left.contacts
      if (byContacts) return byContacts
      return right.attempts - left.attempts
    })
    .slice(0, 40)
}

function buildActions(payload: {
  kpis: MetricTotals
  projection: EquifaxProjectionSummary | null
  goals: EquifaxRoleViewGoals | null
}) {
  const actions: string[] = []
  const warnings: string[] = []

  if (payload.kpis.attempts < 50) {
    actions.push('Subir cadencia: aumentar intentos y reasignar leads sin contacto.')
  }

  if (payload.kpis.contact_rate < 25) {
    actions.push('Contacto bajo: priorizar ventanas recomendadas y concentrar en phone-first.')
  }

  if (payload.kpis.purchase_rate < 2) {
    actions.push('Compra baja: reforzar guión de cierre y priorizar leads verdes con fit alto.')
  }

  if (payload.goals && payload.goals.source === 'projection_top_1000') {
    warnings.push('Metas no configuradas: usando fallback sugerido desde proyección top_1000.')
  }

  if (!payload.goals) {
    warnings.push('Metas no configuradas: define EQUIFAX_CRM_GOALS_JSON para brechas reales.')
  }

  if (!payload.projection) {
    warnings.push('Sin proyección Equifax disponible (pipeline no ha generado payload).')
  }

  if (!actions.length) {
    actions.push('Operación en rango: mantener mezcla verde/amarillo y revisar outliers rojos.')
  }

  return { actions, warnings }
}

export async function loadEquifaxRoleViewData(input: {
  role: EquifaxCrmRole
  agentName?: string | null
  timeZone?: string
}): Promise<EquifaxRoleViewData> {
  const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE
  const now = new Date()
  const { year, month, day } = getZonedYmd(now, timeZone)
  const windowStart = zonedTimeToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone)
  const windowEnd = now
  const warnings: string[] = []

  if (!hasSupabaseAdminEnv) {
    warnings.push('Falta SUPABASE_SERVICE_ROLE_KEY: vista CRM Equifax en modo vacío.')
    return {
      role: input.role,
      generated_at: new Date().toISOString(),
      time_zone: timeZone,
      window: {
        start: windowStart.toISOString(),
        end: windowEnd.toISOString(),
        label: 'Hoy',
      },
      agents: [],
      agent_selected: null,
      kpis: {
        attempts: 0,
        unique_leads: 0,
        contacts: 0,
        interests: 0,
        purchases: 0,
        contact_rate: 0,
        interest_rate: 0,
        purchase_rate: 0,
      },
      rankings: [],
      semaforo: {
        portfolio: { green: 0, yellow: 0, red: 0 },
        managed_today: { green: 0, yellow: 0, red: 0, unknown: 0 },
      },
      projection: null,
      goals: null,
      actions: [],
      warnings,
    }
  }

  const [projection, allRows] = await Promise.all([
    loadLatestEquifaxProjectionSummary().catch(error => {
      const message = error instanceof Error ? error.message : 'No pude cargar la proyección Equifax.'
      warnings.push(message)
      return null
    }),
    fetchEquifaxFeedbackRows(windowStart.toISOString(), windowEnd.toISOString()).catch(error => {
      const message = error instanceof Error ? error.message : 'No pude leer el feedback Equifax.'
      warnings.push(message)
      return [] as FeedbackRow[]
    }),
  ])

  const availableAgents = [...new Set(allRows.map(row => row.agent_name?.trim()).filter((value): value is string => Boolean(value)))]
    .sort((left, right) => left.localeCompare(right, 'es'))

  const agentSelected = input.agentName && availableAgents.includes(input.agentName) ? input.agentName : null
  const filteredRows = agentSelected
    ? allRows.filter(row => (row.agent_name?.trim() ?? '') === agentSelected)
    : allRows

  const kpis = aggregateTotals(filteredRows)
  const rankings = buildRankings(allRows)

  const uniqueRutids = [...new Set(filteredRows.map(row => normalizeRutid(row.matched_rutid ?? row.rutid)).filter((value): value is string => Boolean(value)))]
    .slice(0, 2000)
  const temperatureMap = await fetchLeadTemperatures(uniqueRutids).catch(error => {
    const message = error instanceof Error ? error.message : 'No pude cargar los semáforos Equifax.'
    warnings.push(message)
    return new Map<string, EquifaxLeadScoreRow['lead_temperature']>()
  })

  let managedGreen = 0
  let managedYellow = 0
  let managedRed = 0
  let managedUnknown = 0
  for (const rutid of uniqueRutids) {
    const temperature = temperatureMap.get(rutid) ?? null
    if (temperature === 'green') managedGreen += 1
    else if (temperature === 'yellow') managedYellow += 1
    else if (temperature === 'red') managedRed += 1
    else managedUnknown += 1
  }

  const portfolioBucket = projection?.portfolio ?? null
  const portfolioSemaforo = {
    green: Math.max(0, Math.round(Number(portfolioBucket?.green ?? 0))),
    yellow: Math.max(0, Math.round(Number(portfolioBucket?.yellow ?? 0))),
    red: Math.max(0, Math.round(Number(portfolioBucket?.red ?? 0))),
  }

  const envGoals = readGoalsFromEnv(input.role)
  const goals = envGoals ?? buildGoalFallbackFromProjection(projection)
  const { actions, warnings: actionWarnings } = buildActions({ kpis, projection, goals })
  warnings.push(...actionWarnings)

  return {
    role: input.role,
    generated_at: new Date().toISOString(),
    time_zone: timeZone,
    window: {
      start: windowStart.toISOString(),
      end: windowEnd.toISOString(),
      label: 'Hoy',
    },
    agents: availableAgents,
    agent_selected: agentSelected,
    kpis,
    rankings,
    semaforo: {
      portfolio: portfolioSemaforo,
      managed_today: {
        green: managedGreen,
        yellow: managedYellow,
        red: managedRed,
        unknown: managedUnknown,
      },
    },
    projection,
    goals,
    actions,
    warnings,
  }
}

