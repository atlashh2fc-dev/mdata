'use server'

import { createClient } from '@supabase/supabase-js'
import { db, hasSupabaseAdminEnv } from '@/lib/db/supabase'
import { analyzeWithAI } from '@/lib/services/ai'
import type {
  CampaignHealthCard,
  CommercialActionFeed,
  CommercialBrainOverview,
  CommercialHealthSnapshot,
  FeedbackChannel,
  LeadActionItem,
  PersonaScoreCard,
  SegmentHealthInsight,
  TacticalRecommendation,
  WindowPerformance,
} from '@/types'

const ACTIVE_WINDOW_HOURS = 72
const SEGMENT_WINDOW_DAYS = 7
const BASELINE_WINDOW_DAYS = 28
const ALERT_STREAK_HOURS = 3
const RECENT_EVENT_LIMIT = 18000
const BASELINE_EVENT_LIMIT = 50000
const ACTIVE_CAMPAIGN_LIMIT = 8
const LEAD_LIMIT = 18
const TOP_SCORE_CANDIDATES = 48
const CRM_ACTIONABLE_TARGET_LIMIT = 200

type FeedbackRow = {
  id: string
  rutid: string | null
  matched_rutid: string | null
  campaign_name: string | null
  channel: FeedbackChannel | null
  managed_at: string
  outcome: string | null
  effective_contact: boolean
  sale: boolean
  interested: boolean
  callback_requested: boolean
  duration_seconds: number | null
  agent_name: string | null
}

type FeedbackEvent = {
  id: string
  rutid: string | null
  campaignName: string
  channel: string
  managedAt: string
  managedAtDate: Date
  hourKey: string
  hour: number
  outcome: string
  effectiveContact: boolean
  sale: boolean
  interested: boolean
  callbackRequested: boolean
  durationSeconds: number | null
  agentName: string | null
}

type MetricBucket = {
  attempts: number
  effectiveContacts: number
  sales: number
  interests: number
  callbacks: number
  uniqueLeads: number
  uniqueAgents: number
  avgDurationSeconds: number
  contactRate: number
  saleRate: number
  interestRate: number
}

type PersonaLite = {
  rutid: string
  nombre_completo: string | null
  region_canonica: string | null
  comuna_canonica: string | null
}

type CrmActiveTargetRow = {
  rutid: string
  campaign_name: string | null
  current_priority_score: number | null
  updated_at: string | null
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000)
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

function toHourKey(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  const hour = String(value.getHours()).padStart(2, '0')
  return `${year}-${month}-${day}T${hour}:00`
}

function normalizeCampaignName(value?: string | null): string {
  return value?.trim() || 'Sin campaña'
}

function normalizeRutid(value?: string | null): string | null {
  if (!value) return null

  const compact = value.toUpperCase().replace(/[^0-9K]/g, '')
  if (!compact) return null

  const trimmed = compact.replace(/^0+/, '')
  return trimmed || null
}

function normalizeChannel(value?: string | null): string {
  return value?.trim() || 'other'
}

function normalizeFeedbackEvent(row: FeedbackRow): FeedbackEvent | null {
  const managedAtDate = new Date(row.managed_at)
  if (Number.isNaN(managedAtDate.getTime())) return null

  return {
    id: row.id,
    rutid: row.matched_rutid ?? row.rutid,
    campaignName: normalizeCampaignName(row.campaign_name),
    channel: normalizeChannel(row.channel),
    managedAt: row.managed_at,
    managedAtDate,
    hourKey: toHourKey(managedAtDate),
    hour: managedAtDate.getHours(),
    outcome: row.outcome ?? 'unknown',
    effectiveContact: Boolean(row.effective_contact),
    sale: Boolean(row.sale),
    interested: Boolean(row.interested),
    callbackRequested: Boolean(row.callback_requested),
    durationSeconds: row.duration_seconds,
    agentName: row.agent_name,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function safeRate(numerator: number, denominator: number): number {
  if (!denominator) return 0
  return (numerator / denominator) * 100
}

function aggregateMetrics(events: FeedbackEvent[]): MetricBucket {
  const uniqueLeads = new Set<string>()
  const uniqueAgents = new Set<string>()
  let attempts = 0
  let effectiveContacts = 0
  let sales = 0
  let interests = 0
  let callbacks = 0
  let durationSum = 0
  let durationCount = 0

  for (const event of events) {
    attempts += 1
    if (event.rutid) uniqueLeads.add(event.rutid)
    if (event.agentName) uniqueAgents.add(event.agentName)
    if (event.effectiveContact) effectiveContacts += 1
    if (event.sale) sales += 1
    if (event.interested) interests += 1
    if (event.callbackRequested) callbacks += 1
    if (typeof event.durationSeconds === 'number' && Number.isFinite(event.durationSeconds)) {
      durationSum += event.durationSeconds
      durationCount += 1
    }
  }

  return {
    attempts,
    effectiveContacts,
    sales,
    interests,
    callbacks,
    uniqueLeads: uniqueLeads.size,
    uniqueAgents: uniqueAgents.size,
    avgDurationSeconds: durationCount > 0 ? round(durationSum / durationCount, 0) : 0,
    contactRate: round(safeRate(effectiveContacts, attempts)),
    saleRate: round(safeRate(sales, attempts)),
    interestRate: round(safeRate(interests, attempts)),
  }
}

function buildHourlyMap(events: FeedbackEvent[]): Map<string, MetricBucket> {
  const grouped = new Map<string, FeedbackEvent[]>()
  for (const event of events) {
    const list = grouped.get(event.hourKey) ?? []
    list.push(event)
    grouped.set(event.hourKey, list)
  }

  const metrics = new Map<string, MetricBucket>()
  for (const [key, group] of grouped.entries()) {
    metrics.set(key, aggregateMetrics(group))
  }

  return metrics
}

function buildHourOfDayBaseline(events: FeedbackEvent[]): Map<number, MetricBucket> {
  const grouped = new Map<number, FeedbackEvent[]>()
  for (const event of events) {
    const list = grouped.get(event.hour) ?? []
    list.push(event)
    grouped.set(event.hour, list)
  }

  const metrics = new Map<number, MetricBucket>()
  for (const [key, group] of grouped.entries()) {
    metrics.set(key, aggregateMetrics(group))
  }

  return metrics
}

function getLastHourKeys(hours: number): string[] {
  const keys: string[] = []
  const reference = new Date()
  reference.setMinutes(0, 0, 0)
  for (let index = hours - 1; index >= 0; index -= 1) {
    const hour = new Date(reference.getTime() - index * 60 * 60 * 1000)
    keys.push(toHourKey(hour))
  }
  return keys
}

function buildWindowLabel(hour: number): string {
  const nextHour = (hour + 1) % 24
  return `${String(hour).padStart(2, '0')}:00-${String(nextHour).padStart(2, '0')}:00`
}

function metricScore(bucket: MetricBucket): number {
  return round(
    bucket.contactRate * 0.55 +
    bucket.saleRate * 2.4 +
    bucket.interestRate * 0.7,
    1
  )
}

function severityFromHealth(healthScore: number, underperformanceHours: number): CampaignHealthCard['severity'] {
  if (underperformanceHours >= 3 || healthScore < 40) return 'critical'
  if (underperformanceHours >= 2 || healthScore < 55) return 'risk'
  if (healthScore < 70) return 'watch'
  return 'healthy'
}

function determineTopChannel(events: FeedbackEvent[]): string | null {
  const perChannel = new Map<string, FeedbackEvent[]>()
  for (const event of events) {
    const list = perChannel.get(event.channel) ?? []
    list.push(event)
    perChannel.set(event.channel, list)
  }

  let topChannel: string | null = null
  let topScore = -Infinity

  for (const [channel, channelEvents] of perChannel.entries()) {
    const score = metricScore(aggregateMetrics(channelEvents))
    if (score > topScore) {
      topChannel = channel
      topScore = score
    }
  }

  return topChannel
}

function buildProbableCauses(args: {
  current: MetricBucket
  baseline: MetricBucket
  attemptsPerLead: number
  noContactRate: number
  currentHour: number
  bestHour: number | null
  worstChannelDelta: number
  worstChannel: string | null
}): { causes: string[]; action: string; adjustments: string[] } {
  const causes: string[] = []
  const adjustments: string[] = []

  if (args.attemptsPerLead >= 2.2 && args.noContactRate >= 55) {
    causes.push('Fatiga de base: demasiados intentos sobre los mismos leads con alto no-contact.')
    adjustments.push('Bajar intensidad sobre leads golpeados y recalcular prioridad excluyendo no-contact recientes.')
  }

  if (args.bestHour !== null && args.bestHour !== args.currentHour) {
    causes.push(`Desalineación horaria: el histórico rinde mejor cerca de las ${String(args.bestHour).padStart(2, '0')}:00.`)
    adjustments.push(`Mover prioridad hacia ${buildWindowLabel(args.bestHour)} y proteger el bloque actual.`)
  }

  if (args.worstChannel && args.worstChannelDelta <= -8) {
    causes.push(`Deterioro por canal: ${args.worstChannel} está cayendo fuerte contra su baseline.`)
    adjustments.push(`Reducir presión en ${args.worstChannel} y redistribuir volumen al mejor canal disponible.`)
  }

  if (
    args.current.contactRate >= args.baseline.contactRate * 0.9 &&
    args.current.saleRate < args.baseline.saleRate * 0.7
  ) {
    causes.push('Quiebre de conversión: se está logrando contacto, pero no se capitaliza en interés o venta.')
    adjustments.push('Mantener volumen, pero reasignar mejores leads/agentes y revisar argumento comercial.')
  }

  if (args.current.contactRate < args.baseline.contactRate * 0.75 && args.noContactRate < 50) {
    causes.push('Dilución del mix: entraron cohortes menos contactables que el baseline esperado.')
    adjustments.push('Reordenar segmentos y subir primero cohorts de mayor score y mejor dato presente.')
  }

  if (!causes.length) {
    causes.push('Desviación temprana no concluyente: se observa caída relativa versus baseline operativo.')
    adjustments.push('Monitorear próxima hora y corregir prioridad si la tendencia persiste.')
  }

  const primaryAction = adjustments[0] ?? 'Recalcular ranking táctico y revisar mezcla de campaña.'

  return {
    causes,
    action: primaryAction,
    adjustments,
  }
}

function compareAgainstBaseline(current: MetricBucket, baseline: MetricBucket): number {
  const contactDelta = current.contactRate - baseline.contactRate
  const saleDelta = current.saleRate - baseline.saleRate
  const interestDelta = current.interestRate - baseline.interestRate
  const attemptsPerLead = current.uniqueLeads > 0 ? current.attempts / current.uniqueLeads : 0
  const fatiguePenalty = clamp((attemptsPerLead - 1) * 15, 0, 30)

  return clamp(
    round(68 + contactDelta * 0.9 + saleDelta * 2.2 + interestDelta * 1.1 - fatiguePenalty),
    0,
    100
  )
}

function pickBestHour(hourlyBaseline: Map<number, MetricBucket>): number | null {
  let bestHour: number | null = null
  let bestScore = -Infinity

  for (const [hour, metrics] of hourlyBaseline.entries()) {
    const score = metricScore(metrics)
    if (metrics.attempts >= 12 && score > bestScore) {
      bestHour = hour
      bestScore = score
    }
  }

  return bestHour
}

function buildCampaignCard(campaignName: string, recentEvents: FeedbackEvent[], baselineEvents: FeedbackEvent[]): CampaignHealthCard {
  const recent3hCutoff = hoursAgo(ALERT_STREAK_HOURS)
  const recent24hCutoff = hoursAgo(24)
  const recent3hEvents = recentEvents.filter(event => event.managedAtDate >= recent3hCutoff)
  const recent24hEvents = recentEvents.filter(event => event.managedAtDate >= recent24hCutoff)
  const recent3hMetrics = aggregateMetrics(recent3hEvents)
  const recent24hMetrics = aggregateMetrics(recent24hEvents)
  const baselineMetrics = aggregateMetrics(baselineEvents)
  const hourlyCurrent = buildHourlyMap(recentEvents)
  const hourlyBaseline = buildHourOfDayBaseline(baselineEvents)
  const trailingKeys = getLastHourKeys(ALERT_STREAK_HOURS)
  const bucketComparisons = trailingKeys.map(key => {
    const current = hourlyCurrent.get(key) ?? aggregateMetrics([])
    const currentDate = new Date(`${key}:00`)
    const baseline = hourlyBaseline.get(currentDate.getHours()) ?? baselineMetrics
    const underperforming = current.attempts >= 8 &&
      baseline.attempts >= 20 &&
      (
        current.contactRate < baseline.contactRate * 0.82 ||
        current.saleRate < baseline.saleRate * 0.75
      )

    return { current, baseline, underperforming }
  })

  let underperformanceHours = 0
  for (let index = bucketComparisons.length - 1; index >= 0; index -= 1) {
    if (bucketComparisons[index]?.underperforming) {
      underperformanceHours += 1
    } else {
      break
    }
  }

  const topChannel = determineTopChannel(recent24hEvents) ?? determineTopChannel(baselineEvents)
  const bestHour = pickBestHour(hourlyBaseline)
  const hasBaseline = baselineMetrics.attempts >= 20
  const noContactRate = safeRate(
    recent24hEvents.filter(event => event.outcome === 'no_contact').length,
    recent24hMetrics.attempts
  )
  const attemptsPerLead = recent24hMetrics.uniqueLeads > 0
    ? recent24hMetrics.attempts / recent24hMetrics.uniqueLeads
    : 0

  const currentChannelMetrics = new Map<string, MetricBucket>()
  const baselineChannelMetrics = new Map<string, MetricBucket>()

  for (const channel of new Set([...recent24hEvents.map(event => event.channel), ...baselineEvents.map(event => event.channel)])) {
    currentChannelMetrics.set(channel, aggregateMetrics(recent24hEvents.filter(event => event.channel === channel)))
    baselineChannelMetrics.set(channel, aggregateMetrics(baselineEvents.filter(event => event.channel === channel)))
  }

  let worstChannel: string | null = null
  let worstChannelDelta = 0
  for (const [channel, metrics] of currentChannelMetrics.entries()) {
    const baseline = baselineChannelMetrics.get(channel) ?? baselineMetrics
    const delta = metrics.contactRate - baseline.contactRate
    if (delta < worstChannelDelta) {
      worstChannel = channel
      worstChannelDelta = delta
    }
  }

  const healthScore = hasBaseline
    ? compareAgainstBaseline(recent3hMetrics, baselineMetrics)
    : clamp(round(55 + recent3hMetrics.contactRate * 0.2 + recent3hMetrics.saleRate * 1.6), 35, 82)
  const fatigueScore = clamp(round((attemptsPerLead - 1) * 35 + noContactRate * 0.55), 0, 100)
  const severity = hasBaseline
    ? severityFromHealth(healthScore, underperformanceHours)
    : recent3hMetrics.attempts >= 18 ? 'watch' : 'healthy'
  const diagnosis = hasBaseline
    ? buildProbableCauses({
        current: recent3hMetrics,
        baseline: baselineMetrics,
        attemptsPerLead: round(attemptsPerLead, 2),
        noContactRate: round(noContactRate),
        currentHour: new Date().getHours(),
        bestHour,
        worstChannelDelta: round(worstChannelDelta),
        worstChannel,
      })
    : {
        causes: ['Histórico insuficiente para baseline robusto: la campaña aún está en fase de aprendizaje local.'],
        action: 'Usar baseline de portafolio, vigilar 2 bloques más y capturar feedback antes de endurecer la estrategia.',
        adjustments: ['Monitorear hora a hora y evitar sobrerreaccionar antes de consolidar señal.', 'Aprovechar esta fase para enriquecer cohortes y medir respuesta por canal.'],
      }

  return {
    campaign_name: campaignName,
    attempts_3h: recent3hMetrics.attempts,
    unique_leads_3h: recent3hMetrics.uniqueLeads,
    effective_contacts_3h: recent3hMetrics.effectiveContacts,
    sales_3h: recent3hMetrics.sales,
    interest_3h: recent3hMetrics.interests,
    current_contact_rate: recent3hMetrics.contactRate,
    baseline_contact_rate: baselineMetrics.contactRate,
    current_conversion_rate: recent3hMetrics.saleRate,
    baseline_conversion_rate: baselineMetrics.saleRate,
    current_interest_rate: recent3hMetrics.interestRate,
    baseline_interest_rate: baselineMetrics.interestRate,
    fatigue_score: fatigueScore,
    health_score: healthScore,
    severity,
    underperformance_hours: underperformanceHours,
    probable_causes: diagnosis.causes,
    recommended_action: diagnosis.action,
    recommended_adjustments: diagnosis.adjustments,
    top_channel: topChannel,
    best_next_window: bestHour === null ? 'Sin señal suficiente' : buildWindowLabel(bestHour),
    ai_summary: null,
    supporting_signals: {
      attempts_24h: recent24hMetrics.attempts,
      unique_leads_24h: recent24hMetrics.uniqueLeads,
      attempts_per_lead_24h: round(attemptsPerLead, 2),
      no_contact_rate_24h: round(noContactRate),
      avg_duration_seconds_24h: recent24hMetrics.avgDurationSeconds,
      unique_agents_24h: recent24hMetrics.uniqueAgents,
    },
  }
}

function buildSnapshot(campaigns: CampaignHealthCard[], recentEvents: FeedbackEvent[], baselineEvents: FeedbackEvent[]): CommercialHealthSnapshot {
  const current3h = aggregateMetrics(recentEvents.filter(event => event.managedAtDate >= hoursAgo(ALERT_STREAK_HOURS)))
  const baseline = aggregateMetrics(baselineEvents)
  const totalAttempts = campaigns.reduce((sum, campaign) => sum + campaign.attempts_3h, 0)
  const weightedHealth = campaigns.reduce((sum, campaign) => sum + campaign.health_score * Math.max(campaign.attempts_3h, 1), 0)

  return {
    overall_health_score: campaigns.length ? round(weightedHealth / Math.max(totalAttempts, campaigns.length)) : 0,
    active_campaigns: campaigns.length,
    campaigns_at_risk: campaigns.filter(campaign => campaign.severity === 'risk' || campaign.severity === 'critical').length,
    critical_campaigns: campaigns.filter(campaign => campaign.severity === 'critical').length,
    anomaly_count: campaigns.filter(campaign => campaign.underperformance_hours >= 2).length,
    current_contact_rate: current3h.contactRate,
    expected_contact_rate: baseline.contactRate,
    current_conversion_rate: current3h.saleRate,
    expected_conversion_rate: baseline.saleRate,
    current_interest_rate: current3h.interestRate,
    expected_interest_rate: baseline.interestRate,
    monitored_window_hours: ALERT_STREAK_HOURS,
    last_feedback_at: recentEvents[0]?.managedAt ?? null,
  }
}

async function fetchPersonas(rutids: string[]): Promise<Map<string, PersonaLite>> {
  if (!rutids.length) return new Map()

  const { data } = await db
    .from('master_personas_view')
    .select('rutid,nombre_completo,region_canonica,comuna_canonica')
    .in('rutid', rutids)

  const personas = new Map<string, PersonaLite>()
  for (const row of (data ?? []) as PersonaLite[]) {
    personas.set(row.rutid, row)
  }

  return personas
}

function getCrmOperationalClient() {
  const url = process.env.REGISTRO_INTEL_SUPABASE_URL
  const key =
    process.env.REGISTRO_INTEL_SERVICE_ROLE_KEY ||
    process.env.REGISTRO_INTEL_SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) return null

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

async function fetchCrmActiveTargets(rutids: string[]): Promise<Map<string, CrmActiveTargetRow>> {
  const normalizedRutids = [...new Set(
    rutids
      .map(rutid => normalizeRutid(rutid))
      .filter((rutid): rutid is string => Boolean(rutid))
  )]

  if (!normalizedRutids.length) return new Map()

  const crm = getCrmOperationalClient()
  if (!crm) return new Map()

  const { data, error } = await crm
    .from('commercial_brain_active_targets_v1')
    .select('rutid,campaign_name,current_priority_score,updated_at')
    .in('rutid', normalizedRutids)
    .order('current_priority_score', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(CRM_ACTIONABLE_TARGET_LIMIT)

  if (error) {
    console.error('[fetchCrmActiveTargets]', error)
    return new Map()
  }

  const targetMap = new Map<string, CrmActiveTargetRow>()
  for (const row of (data ?? []) as CrmActiveTargetRow[]) {
    const normalizedRutid = normalizeRutid(row.rutid)
    if (!normalizedRutid || targetMap.has(normalizedRutid)) continue
    targetMap.set(normalizedRutid, row)
  }

  return targetMap
}

function buildSegmentInsights(
  events: FeedbackEvent[],
  personas: Map<string, PersonaLite>,
  type: 'region' | 'comuna'
): SegmentHealthInsight[] {
  const grouped = new Map<string, FeedbackEvent[]>()

  for (const event of events) {
    if (!event.rutid) continue
    const persona = personas.get(event.rutid)
    const label = type === 'region' ? persona?.region_canonica : persona?.comuna_canonica
    if (!label) continue
    const list = grouped.get(label) ?? []
    list.push(event)
    grouped.set(label, list)
  }

  const globalMetrics = aggregateMetrics(events)
  const insights: SegmentHealthInsight[] = []

  for (const [label, group] of grouped.entries()) {
    const metrics = aggregateMetrics(group)
    if (metrics.attempts < 18) continue
    const score = metricScore(metrics)
    const baselineScore = metricScore(globalMetrics)
    const delta = round(score - baselineScore, 1)
    insights.push({
      segment_label: label,
      segment_type: type,
      volume: metrics.attempts,
      current_contact_rate: metrics.contactRate,
      baseline_contact_rate: globalMetrics.contactRate,
      current_conversion_rate: metrics.saleRate,
      baseline_conversion_rate: globalMetrics.saleRate,
      health_delta: delta,
      recommendation: delta >= 0
        ? 'Subir prioridad relativa y aprovechar este segmento mientras conserva respuesta.'
        : 'Bajar presión y revisar mezcla, dato presente y ventana antes de seguir empujando.',
    })
  }

  return insights.sort((left, right) => right.health_delta - left.health_delta)
}

function buildOptimalWindows(events: FeedbackEvent[]): WindowPerformance[] {
  const perHour = buildHourOfDayBaseline(events)
  const windows: WindowPerformance[] = []

  for (const [hour, metrics] of perHour.entries()) {
    if (metrics.attempts < 12) continue
    const score = metricScore(metrics)
    windows.push({
      hour,
      label: buildWindowLabel(hour),
      attempts: metrics.attempts,
      contact_rate: metrics.contactRate,
      conversion_rate: metrics.saleRate,
      interest_rate: metrics.interestRate,
      score,
      recommendation: score >= 45
        ? 'Bloque premium para cohorts de alta prioridad.'
        : score >= 32
          ? 'Bloque estable para operación estándar.'
          : 'Usar con menor intensidad o dejar para recuperación.',
    })
  }

  return windows.sort((left, right) => right.score - left.score).slice(0, 5)
}

async function buildLeadActions(activeCampaigns: CampaignHealthCard[]): Promise<LeadActionItem[]> {
  const { data: topScores } = await db
    .from('persona_scores')
    .select(`
      rutid,
      contactability_score,
      purchase_propensity_score,
      priority_score,
      best_channel,
      best_contact_hour,
      next_best_action,
      action_priority,
      last_contact_at,
      last_sale_at,
      no_contact_events,
      interest_events,
      sales_events,
      feedback_coverage
    `)
    .eq('should_contact', true)
    .order('priority_score', { ascending: false })
    .limit(TOP_SCORE_CANDIDATES)

  const scoreRows = (topScores ?? []) as (PersonaScoreCard & {
    action_priority?: string
    last_contact_at?: string | null
    last_sale_at?: string | null
  })[]

  if (!scoreRows.length) return []

  const rutids = scoreRows.map(row => row.rutid)
  const [personas, crmTargets] = await Promise.all([
    fetchPersonas(rutids),
    fetchCrmActiveTargets(rutids),
  ])
  const actionableMode = crmTargets.size > 0

  const [matchedHistory, directHistory] = await Promise.all([
    db
      .from('contact_center_feedback')
      .select('id,rutid,matched_rutid,campaign_name,channel,managed_at,outcome,effective_contact,sale,interested,callback_requested,duration_seconds,agent_name')
      .in('matched_rutid', rutids)
      .order('managed_at', { ascending: false })
      .limit(3000),
    db
      .from('contact_center_feedback')
      .select('id,rutid,matched_rutid,campaign_name,channel,managed_at,outcome,effective_contact,sale,interested,callback_requested,duration_seconds,agent_name')
      .in('rutid', rutids)
      .order('managed_at', { ascending: false })
      .limit(3000),
  ])

  const historyMap = new Map<string, FeedbackEvent[]>()
  const seenEventIds = new Set<string>()
  for (const row of [...(matchedHistory.data ?? []), ...(directHistory.data ?? [])] as FeedbackRow[]) {
    if (seenEventIds.has(row.id)) continue
    seenEventIds.add(row.id)
    const event = normalizeFeedbackEvent(row)
    if (!event?.rutid) continue
    const list = historyMap.get(event.rutid) ?? []
    list.push(event)
    historyMap.set(event.rutid, list)
  }

  const healthiestCampaign = activeCampaigns.find(campaign => campaign.severity === 'healthy') ?? activeCampaigns[0] ?? null

  const leads: Array<LeadActionItem | null> = scoreRows.map(score => {
    const normalizedRutid = normalizeRutid(score.rutid)
    const crmTarget = normalizedRutid ? crmTargets.get(normalizedRutid) : null
    if (actionableMode && !crmTarget) return null

    const persona = personas.get(score.rutid)
    const history = historyMap.get(score.rutid) ?? []
    const recentAttempts = history.filter(event => event.managedAtDate >= hoursAgo(72)).length
    const recentNoContact = history.filter(
      event => event.managedAtDate >= daysAgo(7) && event.outcome === 'no_contact'
    ).length
    const positiveEvents = history.filter(event => event.effectiveContact || event.interested || event.sale)
    const lastCampaign = crmTarget?.campaign_name
      ?? positiveEvents[0]?.campaignName
      ?? history[0]?.campaignName
      ?? healthiestCampaign?.campaign_name
      ?? null
    const fatigueScore = clamp(round(recentAttempts * 12 + recentNoContact * 18 + (score.last_sale_at ? 25 : 0)), 0, 100)
    const operationalAffinity = clamp(round(
      (score.best_channel === healthiestCampaign?.top_channel ? 20 : 0) +
      (history.length ? safeRate(positiveEvents.length, history.length) : 15) +
      (healthiestCampaign?.severity === 'healthy' ? 15 : 0) +
      (score.best_contact_hour === new Date().getHours() ? 10 : 0) +
      (crmTarget ? 12 : 0)
    ), 0, 100)
    const contactProbability = clamp(round(score.contactability_score - fatigueScore * 0.18 + operationalAffinity * 0.12), 0, 100)
    const conversionProbability = clamp(round(score.purchase_propensity_score - fatigueScore * 0.1 + operationalAffinity * 0.08), 0, 100)
    const dynamicPriorityScore = clamp(round(
      score.priority_score * 0.48 +
      contactProbability * 0.2 +
      conversionProbability * 0.2 +
      operationalAffinity * 0.16 -
      fatigueScore * 0.12
    ), 0, 100)

    const reasonTags = [
      contactProbability >= 70 ? 'alto-contacto' : 'contacto-fragil',
      conversionProbability >= 65 ? 'conversion-alta' : 'conversion-media',
      fatigueScore >= 55 ? 'fatiga-alta' : 'fatiga-controlada',
      score.feedback_coverage ? 'feedback-real' : 'sin-feedback',
      crmTarget ? 'crm-activo' : 'crm-pendiente',
    ]

    return {
      rutid: score.rutid,
      nombre_completo: persona?.nombre_completo ?? null,
      campaign_name: lastCampaign,
      region: persona?.region_canonica ?? null,
      comuna: persona?.comuna_canonica ?? null,
      priority_score: score.priority_score,
      dynamic_priority_score: dynamicPriorityScore,
      contact_probability: contactProbability,
      conversion_probability: conversionProbability,
      fatigue_score: fatigueScore,
      operational_affinity: operationalAffinity,
      optimal_window: score.best_contact_hour === null ? 'Sin ventana' : buildWindowLabel(score.best_contact_hour),
      recommended_channel: score.best_channel,
      next_best_action: score.next_best_action,
      reason_tags: reasonTags,
    }
  })

  return leads
    .filter((lead): lead is LeadActionItem => lead !== null)
    .sort((left, right) => right.dynamic_priority_score - left.dynamic_priority_score)
    .slice(0, LEAD_LIMIT)
}

function buildRecommendations(
  snapshot: CommercialHealthSnapshot,
  campaigns: CampaignHealthCard[],
  weakSegments: SegmentHealthInsight[],
  windows: WindowPerformance[]
): TacticalRecommendation[] {
  const recommendations: TacticalRecommendation[] = []

  for (const campaign of campaigns.filter(item => item.severity === 'critical' || item.severity === 'risk').slice(0, 3)) {
    recommendations.push({
      title: `${campaign.campaign_name} está fuera de baseline`,
      scope: 'campaign',
      rationale: `${campaign.underperformance_hours} hora(s) seguidas por debajo de su expectativa, con ${campaign.current_contact_rate}% vs ${campaign.baseline_contact_rate}% en contacto.`,
      action: campaign.recommended_action,
      impact: 'Recuperar el bloque operativo antes de perder el día.',
      priority: campaign.severity === 'critical' ? 'high' : 'medium',
    })
  }

  const weakest = weakSegments[0]
  if (weakest) {
    recommendations.push({
      title: `Ajustar presión en ${weakest.segment_label}`,
      scope: 'segment',
      rationale: `El segmento está ${Math.abs(weakest.health_delta)} puntos por debajo del portafolio en salud táctica.`,
      action: weakest.recommendation,
      impact: 'Evitar desperdicio de intentos sobre cohorts débiles.',
      priority: 'medium',
    })
  }

  const bestWindow = windows[0]
  if (bestWindow) {
    recommendations.push({
      title: `Concentrar high value en ${bestWindow.label}`,
      scope: 'window',
      rationale: `Es la mejor ventana reciente por score combinado de contacto, interés y conversión.`,
      action: 'Mover leads top y callbacks sensibles a este bloque horario.',
      impact: 'Mejorar hit-rate sin aumentar volumen bruto.',
      priority: 'medium',
    })
  }

  recommendations.push({
    title: 'Recalcular ranking dinámico cada bloque',
    scope: 'portfolio',
    rationale: `Hay ${snapshot.anomaly_count} desviaciones tempranas y ${snapshot.campaigns_at_risk} campañas en vigilancia.`,
    action: 'Enviar al CRM scores, alertas y secuencias sugeridas por bloque horario, no solo un score estático diario.',
    impact: 'Cerrar el loop entre aprendizaje histórico y ejecución operativa.',
    priority: snapshot.campaigns_at_risk > 0 ? 'high' : 'low',
  })

  return recommendations.slice(0, 6)
}

async function buildAiExecutiveSummary(payload: {
  snapshot: CommercialHealthSnapshot
  campaigns: CampaignHealthCard[]
  weak_segments: SegmentHealthInsight[]
  optimal_windows: WindowPerformance[]
  recommendations: TacticalRecommendation[]
}): Promise<string | null> {
  try {
    const result = await analyzeWithAI({
      type: 'campaign_strategy',
      data: payload as unknown as Record<string, unknown>,
      context: 'Diagnostica un contact center comercial chileno y propone acciones concretas para recuperar desempeño sin cargar al CRM transaccional.',
    })

    const summary = result.result.executive_summary
    return typeof summary === 'string' ? summary : null
  } catch (error) {
    console.error('[buildAiExecutiveSummary]', error)
    return null
  }
}

export async function getCommercialBrainOverview(): Promise<CommercialBrainOverview> {
  if (!hasSupabaseAdminEnv) {
    return {
      snapshot: {
        overall_health_score: 0,
        active_campaigns: 0,
        campaigns_at_risk: 0,
        critical_campaigns: 0,
        anomaly_count: 0,
        current_contact_rate: 0,
        expected_contact_rate: 0,
        current_conversion_rate: 0,
        expected_conversion_rate: 0,
        current_interest_rate: 0,
        expected_interest_rate: 0,
        monitored_window_hours: ALERT_STREAK_HOURS,
        last_feedback_at: null,
      },
      campaigns: [],
      recommendations: [],
      strong_segments: [],
      weak_segments: [],
      optimal_windows: [],
      lead_actions: [],
      ai_executive_summary: null,
      generated_at: new Date().toISOString(),
    }
  }

  const { data: recentRows, error } = await db
    .from('contact_center_feedback')
    .select('id,rutid,matched_rutid,campaign_name,channel,managed_at,outcome,effective_contact,sale,interested,callback_requested,duration_seconds,agent_name')
    .order('managed_at', { ascending: false })
    .limit(RECENT_EVENT_LIMIT)

  if (error) {
    console.error('[getCommercialBrainOverview:recentRows]', error)
    throw new Error('No fue posible construir la inteligencia comercial táctica.')
  }

  const recentCutoff = hoursAgo(ACTIVE_WINDOW_HOURS)
  const segmentCutoff = daysAgo(SEGMENT_WINDOW_DAYS)
  const recentEvents = ((recentRows ?? []) as FeedbackRow[])
    .map(normalizeFeedbackEvent)
    .filter((event): event is FeedbackEvent => Boolean(event && event.managedAtDate >= recentCutoff))

  const campaignVolume = new Map<string, number>()
  for (const event of recentEvents.filter(item => item.managedAtDate >= hoursAgo(24))) {
    campaignVolume.set(event.campaignName, (campaignVolume.get(event.campaignName) ?? 0) + 1)
  }

  const activeCampaigns = [...campaignVolume.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, ACTIVE_CAMPAIGN_LIMIT)
    .map(([campaignName]) => campaignName)

  let baselineEvents: FeedbackEvent[] = []

  if (activeCampaigns.length) {
    const { data: baselineRows } = await db
      .from('contact_center_feedback')
      .select('id,rutid,matched_rutid,campaign_name,channel,managed_at,outcome,effective_contact,sale,interested,callback_requested,duration_seconds,agent_name')
      .in('campaign_name', activeCampaigns)
      .gte('managed_at', daysAgo(BASELINE_WINDOW_DAYS).toISOString())
      .lt('managed_at', hoursAgo(6).toISOString())
      .order('managed_at', { ascending: false })
      .limit(BASELINE_EVENT_LIMIT)

    baselineEvents = ((baselineRows ?? []) as FeedbackRow[])
      .map(normalizeFeedbackEvent)
      .filter((event): event is FeedbackEvent => Boolean(event))
  }

  const campaignCards = activeCampaigns.map(campaignName =>
    buildCampaignCard(
      campaignName,
      recentEvents.filter(event => event.campaignName === campaignName),
      baselineEvents.filter(event => event.campaignName === campaignName)
    )
  )
    .sort((left, right) => right.attempts_3h - left.attempts_3h)

  const snapshot = buildSnapshot(campaignCards, recentEvents, baselineEvents)
  const segmentEvents = recentEvents.filter(event => event.managedAtDate >= segmentCutoff)
  const segmentRutids = [...new Set(segmentEvents.map(event => event.rutid).filter((value): value is string => Boolean(value))).values()].slice(0, 1500)
  const personas = await fetchPersonas(segmentRutids)
  const regionInsights = buildSegmentInsights(segmentEvents, personas, 'region')
  const comunaInsights = buildSegmentInsights(segmentEvents, personas, 'comuna')
  const segmentInsights = [...regionInsights, ...comunaInsights]
    .sort((left, right) => right.volume - left.volume)

  const strongSegments = [...segmentInsights]
    .sort((left, right) => right.health_delta - left.health_delta)
    .slice(0, 4)

  const weakSegments = [...segmentInsights]
    .sort((left, right) => left.health_delta - right.health_delta)
    .slice(0, 4)

  const optimalWindows = buildOptimalWindows(baselineEvents.length ? baselineEvents : recentEvents)
  const leadActions = await buildLeadActions(campaignCards)
  const recommendations = buildRecommendations(snapshot, campaignCards, weakSegments, optimalWindows)
  const aiExecutiveSummary = campaignCards.length
    ? await buildAiExecutiveSummary({
        snapshot,
        campaigns: campaignCards.slice(0, 4),
        weak_segments: weakSegments,
        optimal_windows: optimalWindows,
        recommendations,
      })
    : null

  return {
    snapshot,
    campaigns: campaignCards,
    recommendations,
    strong_segments: strongSegments,
    weak_segments: weakSegments,
    optimal_windows: optimalWindows,
    lead_actions: leadActions,
    ai_executive_summary: aiExecutiveSummary,
    generated_at: new Date().toISOString(),
  }
}

export async function getCommercialActionFeed(): Promise<CommercialActionFeed> {
  const brain = await getCommercialBrainOverview()

  return {
    source_system: 'rut_intelligence_brain',
    generated_at: brain.generated_at,
    portfolio_status: {
      overall_health_score: brain.snapshot.overall_health_score,
      campaigns_at_risk: brain.snapshot.campaigns_at_risk,
      critical_campaigns: brain.snapshot.critical_campaigns,
      anomaly_count: brain.snapshot.anomaly_count,
    },
    executive_summary: brain.ai_executive_summary,
    campaign_instructions: brain.campaigns.map(campaign => ({
      campaign_name: campaign.campaign_name,
      severity: campaign.severity,
      health_score: campaign.health_score,
      underperformance_hours: campaign.underperformance_hours,
      recommended_action: campaign.recommended_action,
      recommended_adjustments: campaign.recommended_adjustments,
      best_next_window: campaign.best_next_window,
      top_channel: campaign.top_channel,
      probable_causes: campaign.probable_causes,
    })),
    lead_instructions: brain.lead_actions.map(lead => ({
      rutid: lead.rutid,
      campaign_name: lead.campaign_name,
      dynamic_priority_score: lead.dynamic_priority_score,
      contact_probability: lead.contact_probability,
      conversion_probability: lead.conversion_probability,
      fatigue_score: lead.fatigue_score,
      optimal_window: lead.optimal_window,
      recommended_channel: lead.recommended_channel,
      next_best_action: lead.next_best_action,
      reason_tags: lead.reason_tags,
    })),
    recommendations: brain.recommendations,
  }
}
