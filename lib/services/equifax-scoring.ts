import { db } from '@/lib/db/supabase'
import type {
  EquifaxLeadFeatureSnapshot,
  EquifaxLeadScoreSnapshot,
} from '@/types/equifax'

const FETCH_CHUNK_SIZE = 1000
const UPSERT_CHUNK_SIZE = 500
const FEATURE_VERSION = 'v1'
const HEURISTIC_MODEL_VERSION = 'heuristic-v1'
const MODEL_KEY = 'equifax-lead'
const SCORE_STALE_HOURS = 24

type MasterRow = {
  rutid: string
  razon_social_empresa: string | null
  region_canonica: string | null
  comuna_canonica: string | null
  score_patrimonial: number | null
  cobertura_pct: number | null
  totalavaluos: number | null
  n_autos: number | null
  n_bienes_raices: number | null
}

type PersonaScoreRow = {
  rutid: string
  best_channel: string | null
  best_contact_hour: number | null
  known_phone_count: number | null
  known_email_count: number | null
  best_phone: string | null
  best_email: string | null
}

type CustomerSummaryRow = {
  rutid: string
  sales_count: number | null
  recurrent_sales_count: number | null
  one_time_sales_count: number | null
  total_amount: number | null
  last_sale_at: string | null
}

type FeedbackRecord = {
  id: string
  rutid: string | null
  matched_rutid: string | null
  campaign_name: string | null
  channel: string | null
  outcome: string | null
  managed_at: string | null
  sold_at: string | null
  effective_contact: boolean | null
  interested: boolean | null
  callback_requested: boolean | null
  sale: boolean | null
  mail_opened: boolean | null
  clicked: boolean | null
  is_best_management: boolean | null
}

type AggregatedFeedback = {
  totalInteractions: number
  equifaxInteractions: number
  effectiveContacts: number
  noContactEvents: number
  interestEvents: number
  callbackEvents: number
  salesEvents: number
  openedEvents: number
  clickedEvents: number
  bestManagementEvents: number
  lastFeedbackAt: string | null
  lastContactAt: string | null
  lastInterestAt: string | null
  lastSaleFeedbackAt: string | null
  equifaxEffectiveContacts: number
  equifaxInterestEvents: number
  equifaxCallbackEvents: number
  equifaxSalesEvents: number
  equifaxNoContactEvents: number
}

type HeuristicScore = {
  contact_probability: number
  interest_probability: number
  purchase_probability: number
  lead_score: number
  lead_temperature: 'green' | 'yellow' | 'red'
  reason_tags: string[]
  score_breakdown: Record<string, unknown>
}

type LogisticModelRow = {
  target: 'contact' | 'interest' | 'purchase'
  model_version: string
  model_type: string
  intercept: number | null
  feature_names: string[] | null
  coefficients: Record<string, number> | null
  metrics: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
}

type TrainedModel = {
  target: 'contact' | 'interest' | 'purchase'
  model_version: string
  model_type: string
  intercept: number
  feature_names: string[]
  coefficients: Record<string, number>
  means: Record<string, number>
  stds: Record<string, number>
}

type TrainingRow = EquifaxLeadFeatureSnapshot & {
  feature_payload: Record<string, unknown>
}

type TrainModelResult = {
  version: string
  trained_rows: number
  targets: Array<{
    target: 'contact' | 'interest' | 'purchase'
    log_loss: number
    accuracy: number
    positive_rate: number
  }>
}

function chunk<T>(items: T[], size: number) {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))]
}

function normalizeKeyword(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function safeRate(numerator: number, denominator: number) {
  if (!denominator) return 0
  return numerator / denominator
}

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value))
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function round4(value: number) {
  return round(value, 4)
}

function toNumber(value: unknown) {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

function parseDate(value?: string | null) {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function diffDays(date?: string | null) {
  const parsed = parseDate(date)
  if (!parsed) return null
  return Math.max(0, Math.floor((Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24)))
}

function looksLikeEquifaxCampaign(value?: string | null) {
  const normalized = normalizeKeyword(value ?? '')
  if (!normalized) return false
  return (
    normalized.includes('equifax') ||
    normalized.includes('dicom') ||
    normalized.includes('riesgo comercial') ||
    normalized.includes('verificacion comercial') ||
    normalized.includes('informe comercial')
  )
}

function isScoreFresh(scoredAt?: string | null) {
  const parsed = parseDate(scoredAt)
  if (!parsed) return false
  return (Date.now() - parsed.getTime()) / (1000 * 60 * 60) <= SCORE_STALE_HOURS
}

function getFeatureValue(feature: TrainingRow, featureName: string) {
  switch (featureName) {
    case 'known_phone_count':
      return feature.known_phone_count
    case 'known_email_count':
      return feature.known_email_count
    case 'contact_rate':
      return feature.contact_rate
    case 'interest_rate':
      return feature.interest_rate
    case 'callback_rate':
      return feature.callback_rate
    case 'sale_rate':
      return feature.sale_rate
    case 'no_contact_rate':
      return feature.no_contact_rate
    case 'email_open_rate':
      return toNumber(feature.feature_payload.email_open_rate)
    case 'email_click_rate':
      return toNumber(feature.feature_payload.email_click_rate)
    case 'equifax_contact_share':
      return toNumber(feature.feature_payload.equifax_contact_share)
    case 'feedback_total_interactions':
      return feature.feedback_total_interactions
    case 'feedback_equifax_interactions':
      return feature.feedback_equifax_interactions
    case 'effective_contacts':
      return feature.effective_contacts
    case 'interest_events':
      return feature.interest_events
    case 'callback_events':
      return feature.callback_events
    case 'sales_events':
      return feature.sales_events
    case 'score_patrimonial':
      return toNumber(feature.feature_payload.score_patrimonial)
    case 'cobertura_pct':
      return toNumber(feature.feature_payload.cobertura_pct)
    case 'equifax_sales_count':
      return feature.equifax_sales_count
    case 'equifax_total_amount':
      return feature.equifax_total_amount
    case 'is_existing_customer':
      return feature.is_existing_customer ? 1 : 0
    case 'days_since_last_feedback':
      return toNumber(feature.feature_payload.days_since_last_feedback)
    case 'days_since_last_contact':
      return toNumber(feature.feature_payload.days_since_last_contact)
    case 'days_since_last_interest':
      return toNumber(feature.feature_payload.days_since_last_interest)
    case 'days_since_last_sale_feedback':
      return toNumber(feature.feature_payload.days_since_last_sale_feedback)
    default:
      return toNumber(feature.feature_payload[featureName])
  }
}

function resolveTemperature(contactProbability: number, purchaseProbability: number, leadScore: number) {
  if (contactProbability >= 60 && purchaseProbability >= 35 && leadScore >= 65) return 'green'
  if (contactProbability >= 35 && leadScore >= 42) return 'yellow'
  return 'red'
}

function buildReasonTags(feature: EquifaxLeadFeatureSnapshot, score: HeuristicScore) {
  const tags: string[] = []

  if (feature.known_phone_count > 0 && feature.known_email_count > 0) tags.push('telefono-email')
  else if (feature.known_phone_count > 0) tags.push('solo-telefono')
  else if (feature.known_email_count > 0) tags.push('solo-email')

  if (feature.feedback_equifax_interactions > 0) tags.push('feedback-equifax')
  if (feature.is_existing_customer) tags.push('cliente-equifax')
  if (feature.contact_rate >= 0.35) tags.push('contacta-bien')
  if (feature.interest_rate >= 0.12) tags.push('muestra-interes')
  if (feature.sale_rate >= 0.05) tags.push('historial-conversion')
  if (feature.no_contact_rate >= 0.55) tags.push('dificil-contacto')
  if (score.lead_temperature === 'green') tags.push('semaforo-verde')
  if (score.lead_temperature === 'yellow') tags.push('semaforo-amarillo')
  if (score.lead_temperature === 'red') tags.push('semaforo-rojo')

  return uniqueStrings(tags).slice(0, 8)
}

function deriveContactLabel(params: {
  totalInteractions: number
  effectiveContacts: number
  noContactEvents: number
  interestEvents: number
  callbackEvents: number
  salesEvents: number
  openedEvents: number
  clickedEvents: number
}) {
  const contactRate = safeRate(params.effectiveContacts, Math.max(params.totalInteractions, 1))
  const noContactRate = safeRate(params.noContactEvents, Math.max(params.totalInteractions, 1))

  if (params.salesEvents > 0) return true
  if (params.interestEvents > 0 || params.callbackEvents > 0) return true
  if (params.effectiveContacts >= 2) return true
  if (params.effectiveContacts >= 1 && params.totalInteractions <= 2) return true
  if (params.effectiveContacts >= 1 && noContactRate < 0.7) return true
  if (params.clickedEvents > 0 && params.openedEvents > 0) return true
  if (contactRate >= 0.4 && params.totalInteractions >= 2) return true

  return false
}

function deriveInterestLabel(params: {
  interestEvents: number
  callbackEvents: number
  clickedEvents: number
  bestManagementEvents: number
  effectiveContacts: number
}) {
  if (params.interestEvents > 0 || params.callbackEvents > 0) return true
  if (params.clickedEvents > 0 && params.effectiveContacts > 0) return true
  if (params.bestManagementEvents > 0 && params.effectiveContacts > 0) return true
  return false
}

function derivePurchaseLabel(params: {
  salesEvents: number
  interestEvents: number
  callbackEvents: number
  clickedEvents: number
  bestManagementEvents: number
  effectiveContacts: number
  equifaxSalesCount: number
  isExistingCustomer: boolean
}) {
  if (params.salesEvents > 0) return true
  if (params.interestEvents > 0 && params.callbackEvents > 0) return true
  if (params.interestEvents > 0 && params.bestManagementEvents > 0) return true
  if (params.callbackEvents > 0 && params.effectiveContacts >= 2) return true
  if (params.clickedEvents > 0 && params.interestEvents > 0) return true
  if (params.isExistingCustomer && params.equifaxSalesCount >= 2 && params.interestEvents > 0) return true
  return false
}

async function fetchRowsInChunks<T>(
  table: string,
  columns: string,
  rutids: string[],
  field: 'rutid' | 'matched_rutid' = 'rutid'
) {
  const rows: T[] = []

  for (const subset of chunk(rutids, FETCH_CHUNK_SIZE)) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .in(field, subset)

    if (error) {
      console.error(`[fetchRowsInChunks:${table}]`, error)
      throw new Error(`No se pudo consultar ${table}.`)
    }

    rows.push(...((data ?? []) as T[]))
  }

  return rows
}

async function fetchMasterRowsMap(rutids: string[]) {
  const rows = await fetchRowsInChunks<MasterRow>(
    'master_personas_view',
    'rutid,razon_social_empresa,region_canonica,comuna_canonica,score_patrimonial,cobertura_pct,totalavaluos,n_autos,n_bienes_raices',
    rutids
  )

  return new Map(rows.map(row => [row.rutid, row]))
}

async function fetchPersonaScoresMap(rutids: string[]) {
  const rows = await fetchRowsInChunks<PersonaScoreRow>(
    'persona_scores',
    'rutid,best_channel,best_contact_hour,known_phone_count,known_email_count,best_phone,best_email',
    rutids
  )

  return new Map(rows.map(row => [row.rutid, row]))
}

async function fetchCustomerSummaryMap(rutids: string[]) {
  const rows = await fetchRowsInChunks<CustomerSummaryRow>(
    'equifax_sales_company_summary',
    'rutid,sales_count,recurrent_sales_count,one_time_sales_count,total_amount,last_sale_at',
    rutids
  )

  return new Map(rows.map(row => [row.rutid, row]))
}

async function fetchFeedbackRecords(rutids: string[]) {
  const deduped = new Map<string, FeedbackRecord>()

  for (const subset of chunk(rutids, FETCH_CHUNK_SIZE)) {
    const [directRows, matchedRows] = await Promise.all([
      db
        .from('contact_center_feedback')
        .select('id,rutid,matched_rutid,campaign_name,channel,outcome,managed_at,sold_at,effective_contact,interested,callback_requested,sale,mail_opened,clicked,is_best_management')
        .in('rutid', subset),
      db
        .from('contact_center_feedback')
        .select('id,rutid,matched_rutid,campaign_name,channel,outcome,managed_at,sold_at,effective_contact,interested,callback_requested,sale,mail_opened,clicked,is_best_management')
        .in('matched_rutid', subset),
    ])

    if (directRows.error) {
      console.error('[fetchFeedbackRecords:direct]', directRows.error)
      throw new Error('No se pudo consultar feedback del CRM.')
    }

    if (matchedRows.error) {
      console.error('[fetchFeedbackRecords:matched]', matchedRows.error)
      throw new Error('No se pudo consultar feedback del CRM.')
    }

    for (const row of [...(directRows.data ?? []), ...(matchedRows.data ?? [])] as FeedbackRecord[]) {
      deduped.set(String(row.id), row)
    }
  }

  return [...deduped.values()]
}

function aggregateFeedbackByRutid(records: FeedbackRecord[]) {
  const map = new Map<string, AggregatedFeedback>()

  for (const record of records) {
    const rutid = String(record.matched_rutid ?? record.rutid ?? '').trim()
    if (!rutid) continue

    const current = map.get(rutid) ?? {
      totalInteractions: 0,
      equifaxInteractions: 0,
      effectiveContacts: 0,
      noContactEvents: 0,
      interestEvents: 0,
      callbackEvents: 0,
      salesEvents: 0,
      openedEvents: 0,
      clickedEvents: 0,
      bestManagementEvents: 0,
      lastFeedbackAt: null,
      lastContactAt: null,
      lastInterestAt: null,
      lastSaleFeedbackAt: null,
      equifaxEffectiveContacts: 0,
      equifaxInterestEvents: 0,
      equifaxCallbackEvents: 0,
      equifaxSalesEvents: 0,
      equifaxNoContactEvents: 0,
    }

    const isEquifax = looksLikeEquifaxCampaign(record.campaign_name)
    current.totalInteractions += 1
    if (isEquifax) current.equifaxInteractions += 1
    if (record.effective_contact) {
      current.effectiveContacts += 1
      current.lastContactAt = !current.lastContactAt || (record.managed_at ?? '') > current.lastContactAt
        ? record.managed_at
        : current.lastContactAt
      if (isEquifax) current.equifaxEffectiveContacts += 1
    }
    if (record.outcome === 'no_contact') {
      current.noContactEvents += 1
      if (isEquifax) current.equifaxNoContactEvents += 1
    }
    if (record.interested || record.outcome === 'interested') {
      current.interestEvents += 1
      current.lastInterestAt = !current.lastInterestAt || (record.managed_at ?? '') > current.lastInterestAt
        ? record.managed_at
        : current.lastInterestAt
      if (isEquifax) current.equifaxInterestEvents += 1
    }
    if (record.callback_requested || record.outcome === 'callback') {
      current.callbackEvents += 1
      if (isEquifax) current.equifaxCallbackEvents += 1
    }
    if (record.sale || record.outcome === 'sale') {
      current.salesEvents += 1
      current.lastSaleFeedbackAt = !current.lastSaleFeedbackAt || (record.sold_at ?? record.managed_at ?? '') > current.lastSaleFeedbackAt
        ? (record.sold_at ?? record.managed_at)
        : current.lastSaleFeedbackAt
      if (isEquifax) current.equifaxSalesEvents += 1
    }
    if (record.mail_opened || record.outcome === 'opened') current.openedEvents += 1
    if (record.clicked || record.outcome === 'clicked') current.clickedEvents += 1
    if (record.is_best_management) current.bestManagementEvents += 1

    current.lastFeedbackAt = !current.lastFeedbackAt || (record.managed_at ?? '') > current.lastFeedbackAt
      ? record.managed_at
      : current.lastFeedbackAt

    map.set(rutid, current)
  }

  return map
}

function buildFeatureRow(params: {
  rutid: string
  master?: MasterRow
  persona?: PersonaScoreRow
  customer?: CustomerSummaryRow
  feedback?: AggregatedFeedback
}) {
  const { rutid, master, persona, customer, feedback } = params
  const totalInteractions = feedback?.totalInteractions ?? 0
  const equifaxInteractions = feedback?.equifaxInteractions ?? 0
  const contactBase = equifaxInteractions > 0 ? equifaxInteractions : totalInteractions
  const effectiveContacts = equifaxInteractions > 0
    ? (feedback?.equifaxEffectiveContacts ?? 0)
    : (feedback?.effectiveContacts ?? 0)
  const interestEvents = equifaxInteractions > 0
    ? (feedback?.equifaxInterestEvents ?? 0)
    : (feedback?.interestEvents ?? 0)
  const callbackEvents = equifaxInteractions > 0
    ? (feedback?.equifaxCallbackEvents ?? 0)
    : (feedback?.callbackEvents ?? 0)
  const salesEvents = equifaxInteractions > 0
    ? (feedback?.equifaxSalesEvents ?? 0)
    : (feedback?.salesEvents ?? 0)
  const noContactEvents = equifaxInteractions > 0
    ? (feedback?.equifaxNoContactEvents ?? 0)
    : (feedback?.noContactEvents ?? 0)
  const emailOpenRate = safeRate(feedback?.openedEvents ?? 0, totalInteractions)
  const emailClickRate = safeRate(feedback?.clickedEvents ?? 0, totalInteractions)
  const equifaxContactShare = safeRate(equifaxInteractions, totalInteractions)

  const featurePayload: Record<string, unknown> = {
    score_patrimonial: toNumber(master?.score_patrimonial),
    cobertura_pct: toNumber(master?.cobertura_pct),
    totalavaluos: toNumber(master?.totalavaluos),
    n_autos: toNumber(master?.n_autos),
    n_bienes_raices: toNumber(master?.n_bienes_raices),
    email_open_rate: round4(emailOpenRate),
    email_click_rate: round4(emailClickRate),
    equifax_contact_share: round4(equifaxContactShare),
    days_since_last_feedback: diffDays(feedback?.lastFeedbackAt),
    days_since_last_contact: diffDays(feedback?.lastContactAt),
    days_since_last_interest: diffDays(feedback?.lastInterestAt),
    days_since_last_sale_feedback: diffDays(feedback?.lastSaleFeedbackAt),
    best_phone: persona?.best_phone ?? null,
    best_email: persona?.best_email ?? null,
  }

  const labelContact = deriveContactLabel({
    totalInteractions: contactBase,
    effectiveContacts,
    noContactEvents,
    interestEvents,
    callbackEvents,
    salesEvents,
    openedEvents: feedback?.openedEvents ?? 0,
    clickedEvents: feedback?.clickedEvents ?? 0,
  })

  const labelInterest = deriveInterestLabel({
    interestEvents,
    callbackEvents,
    clickedEvents: feedback?.clickedEvents ?? 0,
    bestManagementEvents: feedback?.bestManagementEvents ?? 0,
    effectiveContacts,
  })

  const labelPurchase = derivePurchaseLabel({
    salesEvents,
    interestEvents,
    callbackEvents,
    clickedEvents: feedback?.clickedEvents ?? 0,
    bestManagementEvents: feedback?.bestManagementEvents ?? 0,
    effectiveContacts,
    equifaxSalesCount: toNumber(customer?.sales_count),
    isExistingCustomer: Boolean(customer),
  })

  const row: EquifaxLeadFeatureSnapshot = {
    rutid,
    company_name: master?.razon_social_empresa ?? null,
    region: master?.region_canonica ?? null,
    comuna: master?.comuna_canonica ?? null,
    is_existing_customer: Boolean(customer),
    equifax_sales_count: toNumber(customer?.sales_count),
    equifax_recurrent_sales_count: toNumber(customer?.recurrent_sales_count),
    equifax_one_time_sales_count: toNumber(customer?.one_time_sales_count),
    equifax_total_amount: round(toNumber(customer?.total_amount), 2),
    known_phone_count: toNumber(persona?.known_phone_count),
    known_email_count: toNumber(persona?.known_email_count),
    feedback_total_interactions: totalInteractions,
    feedback_equifax_interactions: equifaxInteractions,
    effective_contacts: effectiveContacts,
    no_contact_events: noContactEvents,
    interest_events: interestEvents,
    callback_events: callbackEvents,
    sales_events: salesEvents,
    opened_events: feedback?.openedEvents ?? 0,
    clicked_events: feedback?.clickedEvents ?? 0,
    best_management_events: feedback?.bestManagementEvents ?? 0,
    contact_rate: round4(safeRate(effectiveContacts, contactBase)),
    interest_rate: round4(safeRate(interestEvents, contactBase)),
    callback_rate: round4(safeRate(callbackEvents, contactBase)),
    sale_rate: round4(safeRate(salesEvents, contactBase)),
    no_contact_rate: round4(safeRate(noContactEvents, contactBase)),
    best_channel: persona?.best_channel ?? null,
    best_contact_hour: persona?.best_contact_hour ?? null,
    feature_payload: {
      ...featurePayload,
      last_equifax_sale_at: customer?.last_sale_at ?? null,
      last_feedback_at: feedback?.lastFeedbackAt ?? null,
      last_contact_at: feedback?.lastContactAt ?? null,
      last_interest_at: feedback?.lastInterestAt ?? null,
      last_sale_feedback_at: feedback?.lastSaleFeedbackAt ?? null,
    },
    label_contact: labelContact,
    label_interest: labelInterest,
    label_purchase: labelPurchase,
    refreshed_at: new Date().toISOString(),
  }

  return row
}

async function upsertFeatureRows(rows: EquifaxLeadFeatureSnapshot[]) {
  for (const subset of chunk(rows, UPSERT_CHUNK_SIZE)) {
    const payload = subset.map(row => ({
      rutid: row.rutid,
      company_name: row.company_name,
      region: row.region,
      comuna: row.comuna,
      is_existing_customer: row.is_existing_customer,
      equifax_sales_count: row.equifax_sales_count,
      equifax_recurrent_sales_count: row.equifax_recurrent_sales_count,
      equifax_one_time_sales_count: row.equifax_one_time_sales_count,
      equifax_total_amount: row.equifax_total_amount,
      last_equifax_sale_at: row.feature_payload.last_equifax_sale_at ?? null,
      known_phone_count: row.known_phone_count,
      known_email_count: row.known_email_count,
      best_channel: row.best_channel,
      best_contact_hour: row.best_contact_hour,
      feedback_total_interactions: row.feedback_total_interactions,
      feedback_equifax_interactions: row.feedback_equifax_interactions,
      effective_contacts: row.effective_contacts,
      no_contact_events: row.no_contact_events,
      interest_events: row.interest_events,
      callback_events: row.callback_events,
      sales_events: row.sales_events,
      opened_events: row.opened_events,
      clicked_events: row.clicked_events,
      best_management_events: row.best_management_events,
      last_feedback_at: row.feature_payload.last_feedback_at ?? null,
      last_contact_at: row.feature_payload.last_contact_at ?? null,
      last_interest_at: row.feature_payload.last_interest_at ?? null,
      last_sale_feedback_at: row.feature_payload.last_sale_feedback_at ?? null,
      days_since_last_feedback: row.feature_payload.days_since_last_feedback ?? null,
      days_since_last_contact: row.feature_payload.days_since_last_contact ?? null,
      days_since_last_interest: row.feature_payload.days_since_last_interest ?? null,
      days_since_last_sale_feedback: row.feature_payload.days_since_last_sale_feedback ?? null,
      score_patrimonial: row.feature_payload.score_patrimonial ?? 0,
      cobertura_pct: row.feature_payload.cobertura_pct ?? 0,
      totalavaluos: row.feature_payload.totalavaluos ?? 0,
      n_autos: row.feature_payload.n_autos ?? 0,
      n_bienes_raices: row.feature_payload.n_bienes_raices ?? 0,
      contact_rate: row.contact_rate,
      interest_rate: row.interest_rate,
      callback_rate: row.callback_rate,
      sale_rate: row.sale_rate,
      no_contact_rate: row.no_contact_rate,
      email_open_rate: row.feature_payload.email_open_rate ?? 0,
      email_click_rate: row.feature_payload.email_click_rate ?? 0,
      equifax_contact_share: row.feature_payload.equifax_contact_share ?? 0,
      feature_payload: row.feature_payload,
      label_contact: row.label_contact,
      label_interest: row.label_interest,
      label_purchase: row.label_purchase,
      feature_version: FEATURE_VERSION,
      refreshed_at: row.refreshed_at,
      updated_at: new Date().toISOString(),
    }))

    const { error } = await db
      .from('equifax_lead_features')
      .upsert(payload, { onConflict: 'rutid' })

    if (error) {
      console.error('[upsertFeatureRows]', error)
      throw new Error('No se pudieron guardar los features de leads Equifax.')
    }
  }
}

function buildHeuristicScore(feature: EquifaxLeadFeatureSnapshot): HeuristicScore {
  const patrimonial = toNumber(feature.feature_payload.score_patrimonial)
  const coverage = toNumber(feature.feature_payload.cobertura_pct)
  const daysSinceLastFeedback = toNumber(feature.feature_payload.days_since_last_feedback)
  const recencyBoost = daysSinceLastFeedback > 0 ? clamp(20 - daysSinceLastFeedback * 0.25, 0, 20) : 0
  const dataQualityScore = clamp(
    feature.known_phone_count * 18 +
    feature.known_email_count * 14 +
    coverage * 0.18,
    0,
    100
  )

  const contactProbability = clamp(
    dataQualityScore * 0.35 +
    feature.contact_rate * 100 * 0.38 +
    toNumber(feature.feature_payload.email_open_rate) * 100 * 0.08 +
    feature.callback_rate * 100 * 0.1 +
    recencyBoost -
    feature.no_contact_rate * 100 * 0.2,
    0,
    100
  )

  const interestProbability = clamp(
    feature.interest_rate * 100 * 0.42 +
    feature.callback_rate * 100 * 0.22 +
    toNumber(feature.feature_payload.email_click_rate) * 100 * 0.12 +
    feature.contact_rate * 100 * 0.12 +
    feature.best_management_events * 2.5 +
    (feature.is_existing_customer ? 8 : 0),
    0,
    100
  )

  const purchaseProbability = clamp(
    feature.sale_rate * 100 * 0.46 +
    feature.interest_rate * 100 * 0.18 +
    feature.callback_rate * 100 * 0.1 +
    patrimonial * 0.22 +
    coverage * 0.08 +
    Math.min(feature.equifax_sales_count, 6) * 2.5 +
    (feature.is_existing_customer ? 10 : 0),
    0,
    100
  )

  const leadScore = clamp(
    contactProbability * 0.45 +
    interestProbability * 0.25 +
    purchaseProbability * 0.3,
    0,
    100
  )

  const leadTemperature = resolveTemperature(contactProbability, purchaseProbability, leadScore)
  const score: HeuristicScore = {
    contact_probability: round(contactProbability, 2),
    interest_probability: round(interestProbability, 2),
    purchase_probability: round(purchaseProbability, 2),
    lead_score: round(leadScore, 2),
    lead_temperature: leadTemperature,
    reason_tags: [],
    score_breakdown: {
      heuristic: {
        data_quality_score: round(dataQualityScore, 2),
        recency_boost: round(recencyBoost, 2),
        contact_rate: feature.contact_rate,
        interest_rate: feature.interest_rate,
        sale_rate: feature.sale_rate,
        no_contact_rate: feature.no_contact_rate,
      },
    },
  }

  score.reason_tags = buildReasonTags(feature, score)
  return score
}

async function loadActiveLogisticModels() {
  const { data, error } = await db
    .from('equifax_scoring_models')
    .select('target,model_version,model_type,intercept,feature_names,coefficients,metrics,metadata')
    .eq('model_key', MODEL_KEY)
    .eq('is_active', true)

  if (error) {
    console.error('[loadActiveLogisticModels]', error)
    return new Map<'contact' | 'interest' | 'purchase', TrainedModel>()
  }

  const models = new Map<'contact' | 'interest' | 'purchase', TrainedModel>()

  for (const row of (data ?? []) as LogisticModelRow[]) {
    const means = (row.metadata?.means ?? {}) as Record<string, number>
    const stds = (row.metadata?.stds ?? {}) as Record<string, number>

    models.set(row.target, {
      target: row.target,
      model_version: row.model_version,
      model_type: row.model_type,
      intercept: toNumber(row.intercept),
      feature_names: Array.isArray(row.feature_names) ? row.feature_names : [],
      coefficients: (row.coefficients ?? {}) as Record<string, number>,
      means,
      stds,
    })
  }

  return models
}

async function ensureActiveLogisticModels() {
  let models = await loadActiveLogisticModels()
  if (models.size > 0) return models

  try {
    const trainingRows = await fetchTrainingRows()
    if (trainingRows.length >= 80) {
      await trainEquifaxLogisticModels({
        activate: true,
      })
      models = await loadActiveLogisticModels()
    }
  } catch (error) {
    console.warn('[ensureActiveLogisticModels]', error instanceof Error ? error.message : error)
  }

  return models
}

function predictWithLogisticModel(model: TrainedModel, feature: TrainingRow) {
  let value = model.intercept

  for (const featureName of model.feature_names) {
    const raw = getFeatureValue(feature, featureName)
    const mean = toNumber(model.means[featureName])
    const std = Math.max(toNumber(model.stds[featureName]), 1e-6)
    const standardized = (raw - mean) / std
    value += standardized * toNumber(model.coefficients[featureName])
  }

  const probability = 1 / (1 + Math.exp(-value))
  return clamp(probability * 100, 0, 100)
}

function combineScores(
  feature: EquifaxLeadFeatureSnapshot,
  heuristic: HeuristicScore,
  models: Map<'contact' | 'interest' | 'purchase', TrainedModel>
): {
  model_version: string
  model_type: string
  contact_probability: number
  interest_probability: number
  purchase_probability: number
  lead_score: number
  lead_temperature: 'green' | 'yellow' | 'red'
  reason_tags: string[]
  score_breakdown: Record<string, unknown>
} {
  const trainingRow = feature as TrainingRow
  const contactModel = models.get('contact')
  const interestModel = models.get('interest')
  const purchaseModel = models.get('purchase')

  const logisticContact = contactModel ? predictWithLogisticModel(contactModel, trainingRow) : null
  const logisticInterest = interestModel ? predictWithLogisticModel(interestModel, trainingRow) : null
  const logisticPurchase = purchaseModel ? predictWithLogisticModel(purchaseModel, trainingRow) : null

  const contactProbability = logisticContact === null
    ? heuristic.contact_probability
    : round(logisticContact * 0.65 + heuristic.contact_probability * 0.35, 2)
  const interestProbability = logisticInterest === null
    ? heuristic.interest_probability
    : round(logisticInterest * 0.65 + heuristic.interest_probability * 0.35, 2)
  const purchaseProbability = logisticPurchase === null
    ? heuristic.purchase_probability
    : round(logisticPurchase * 0.65 + heuristic.purchase_probability * 0.35, 2)

  const leadScore = round(
    clamp(contactProbability * 0.45 + interestProbability * 0.25 + purchaseProbability * 0.3, 0, 100),
    2
  )

  const leadTemperature = resolveTemperature(contactProbability, purchaseProbability, leadScore)
  const reasonTags = uniqueStrings([
    ...heuristic.reason_tags,
    logisticContact !== null ? 'modelo-logit-contacto' : null,
    logisticInterest !== null ? 'modelo-logit-interes' : null,
    logisticPurchase !== null ? 'modelo-logit-compra' : null,
  ]).slice(0, 10)

  return {
    model_version: uniqueStrings([
      contactModel?.model_version,
      interestModel?.model_version,
      purchaseModel?.model_version,
      HEURISTIC_MODEL_VERSION,
    ]).join('+'),
    model_type: contactModel || interestModel || purchaseModel ? 'hybrid' : 'heuristic',
    contact_probability: contactProbability,
    interest_probability: interestProbability,
    purchase_probability: purchaseProbability,
    lead_score: leadScore,
    lead_temperature: leadTemperature,
    reason_tags: reasonTags,
    score_breakdown: {
      ...heuristic.score_breakdown,
      logistic: {
        contact_probability: logisticContact === null ? null : round(logisticContact, 2),
        interest_probability: logisticInterest === null ? null : round(logisticInterest, 2),
        purchase_probability: logisticPurchase === null ? null : round(logisticPurchase, 2),
      },
    },
  }
}

async function upsertScoreRows(rows: EquifaxLeadScoreSnapshot[]) {
  for (const subset of chunk(rows, UPSERT_CHUNK_SIZE)) {
    const payload = subset.map(row => ({
      rutid: row.rutid,
      company_name: row.score_breakdown.company_name ?? null,
      model_version: row.model_version,
      model_type: row.model_type,
      contact_probability: row.contact_probability,
      interest_probability: row.interest_probability,
      purchase_probability: row.purchase_probability,
      fit_score: row.fit_score,
      lead_score: row.lead_score,
      lead_temperature: row.lead_temperature,
      recommended_channel: row.recommended_channel,
      recommended_hour: row.recommended_hour,
      reason_tags: row.reason_tags,
      score_breakdown: row.score_breakdown,
      feature_snapshot: row.score_breakdown.feature_snapshot ?? {},
      scored_at: row.scored_at,
      updated_at: new Date().toISOString(),
    }))

    const { error } = await db
      .from('equifax_lead_scores')
      .upsert(payload, { onConflict: 'rutid' })

    if (error) {
      console.error('[upsertScoreRows]', error)
      throw new Error('No se pudieron guardar los scores de leads Equifax.')
    }
  }
}

export async function getEquifaxLeadScoresMap(
  rutids: string[],
  options?: { refreshIfMissing?: boolean }
) {
  const uniqueRutids = uniqueStrings(rutids)
  const map = new Map<string, EquifaxLeadScoreSnapshot>()
  if (!uniqueRutids.length) return map

  const rows = await fetchRowsInChunks<EquifaxLeadScoreSnapshot>(
    'equifax_lead_scores',
    'rutid,model_version,model_type,contact_probability,interest_probability,purchase_probability,fit_score,lead_score,lead_temperature,recommended_channel,recommended_hour,reason_tags,score_breakdown,scored_at',
    uniqueRutids
  )

  for (const row of rows) {
    map.set(row.rutid, row)
  }

  const missingOrStale = uniqueRutids.filter(rutid => {
    const row = map.get(rutid)
    return !row || !isScoreFresh(row.scored_at)
  })

  if (options?.refreshIfMissing !== false && missingOrStale.length > 0) {
    const refreshed = await refreshEquifaxLeadScoresForRutids(missingOrStale)
    for (const [rutid, row] of refreshed.entries()) {
      map.set(rutid, row)
    }
  }

  return map
}

export async function refreshEquifaxLeadScoresForRutids(rutids: string[]) {
  const uniqueRutids = uniqueStrings(rutids)
  const map = new Map<string, EquifaxLeadScoreSnapshot>()
  if (!uniqueRutids.length) return map

  const [masterMap, personaMap, customerMap, feedbackRecords] = await Promise.all([
    fetchMasterRowsMap(uniqueRutids),
    fetchPersonaScoresMap(uniqueRutids),
    fetchCustomerSummaryMap(uniqueRutids),
    fetchFeedbackRecords(uniqueRutids),
  ])

  const feedbackMap = aggregateFeedbackByRutid(feedbackRecords)
  const features = uniqueRutids.map(rutid => buildFeatureRow({
    rutid,
    master: masterMap.get(rutid),
    persona: personaMap.get(rutid),
    customer: customerMap.get(rutid),
    feedback: feedbackMap.get(rutid),
  }))

  await upsertFeatureRows(features)
  const models = await ensureActiveLogisticModels()

  const scores = features.map<EquifaxLeadScoreSnapshot>(feature => {
    const heuristic = buildHeuristicScore(feature)
    const combined = combineScores(feature, heuristic, models)
    const recommendedChannel = feature.best_channel
      ?? (feature.known_phone_count > 0 ? 'phone' : feature.known_email_count > 0 ? 'email' : null)

    return {
      rutid: feature.rutid,
      model_version: combined.model_version,
      model_type: combined.model_type,
      contact_probability: combined.contact_probability,
      interest_probability: combined.interest_probability,
      purchase_probability: combined.purchase_probability,
      lead_score: combined.lead_score,
      lead_temperature: combined.lead_temperature,
      fit_score: round(feature.is_existing_customer ? 70 + Math.min(feature.equifax_sales_count * 4, 20) : 45, 2),
      recommended_channel: recommendedChannel,
      recommended_hour: feature.best_contact_hour,
      reason_tags: combined.reason_tags,
      score_breakdown: {
        ...combined.score_breakdown,
        company_name: feature.company_name,
        feature_snapshot: feature,
      },
      scored_at: new Date().toISOString(),
    }
  })

  await upsertScoreRows(scores)

  for (const row of scores) {
    map.set(row.rutid, row)
  }

  return map
}

const TRAINING_FEATURES = [
  'known_phone_count',
  'known_email_count',
  'contact_rate',
  'interest_rate',
  'callback_rate',
  'sale_rate',
  'no_contact_rate',
  'email_open_rate',
  'email_click_rate',
  'equifax_contact_share',
  'feedback_total_interactions',
  'feedback_equifax_interactions',
  'effective_contacts',
  'interest_events',
  'callback_events',
  'sales_events',
  'score_patrimonial',
  'cobertura_pct',
  'equifax_sales_count',
  'equifax_total_amount',
  'is_existing_customer',
  'days_since_last_feedback',
  'days_since_last_contact',
  'days_since_last_interest',
  'days_since_last_sale_feedback',
] as const

function sigmoid(value: number) {
  if (value >= 0) {
    const z = Math.exp(-value)
    return 1 / (1 + z)
  }

  const z = Math.exp(value)
  return z / (1 + z)
}

function trainBinaryLogisticModel(
  rows: TrainingRow[],
  target: 'contact' | 'interest' | 'purchase'
) {
  const labels: number[] = rows.map(row => {
    if (target === 'contact') return row.label_contact ? 1 : 0
    if (target === 'interest') return row.label_interest ? 1 : 0
    return row.label_purchase ? 1 : 0
  })

  const positiveRate = safeRate(labels.reduce((sum, item) => sum + item, 0), labels.length)
  const means: Record<string, number> = {}
  const stds: Record<string, number> = {}
  const matrix = rows.map(row => TRAINING_FEATURES.map(featureName => getFeatureValue(row, featureName)))

  for (let featureIndex = 0; featureIndex < TRAINING_FEATURES.length; featureIndex += 1) {
    const featureName = TRAINING_FEATURES[featureIndex]
    const column = matrix.map(item => item[featureIndex])
    const mean = column.reduce((sum, value) => sum + value, 0) / Math.max(column.length, 1)
    const variance = column.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(column.length, 1)
    const std = Math.sqrt(variance) || 1
    means[featureName] = mean
    stds[featureName] = std
  }

  const standardized = matrix.map(row =>
    row.map((value, featureIndex) => {
      const featureName = TRAINING_FEATURES[featureIndex]
      return (value - means[featureName]) / stds[featureName]
    })
  )

  const weights = new Array(TRAINING_FEATURES.length).fill(0)
  let bias = Math.log((positiveRate + 1e-4) / Math.max(1 - positiveRate, 1e-4))
  const learningRate = 0.08
  const regularization = 0.002
  const epochs = 450

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradient = new Array(TRAINING_FEATURES.length).fill(0)
    let biasGradient = 0

    for (let rowIndex = 0; rowIndex < standardized.length; rowIndex += 1) {
      const row = standardized[rowIndex]
      const linear = row.reduce((sum, value, index) => sum + value * weights[index], bias)
      const prediction = sigmoid(linear)
      const error = prediction - labels[rowIndex]

      for (let featureIndex = 0; featureIndex < row.length; featureIndex += 1) {
        gradient[featureIndex] += error * row[featureIndex]
      }
      biasGradient += error
    }

    for (let featureIndex = 0; featureIndex < weights.length; featureIndex += 1) {
      weights[featureIndex] -= learningRate * ((gradient[featureIndex] / standardized.length) + regularization * weights[featureIndex])
    }
    bias -= learningRate * (biasGradient / standardized.length)
  }

  let logLoss = 0
  let correct = 0
  for (let rowIndex = 0; rowIndex < standardized.length; rowIndex += 1) {
    const row = standardized[rowIndex]
    const prediction = sigmoid(row.reduce((sum, value, index) => sum + value * weights[index], bias))
    const label = labels[rowIndex]
    logLoss += -(
      label * Math.log(Math.max(prediction, 1e-6)) +
      (1 - label) * Math.log(Math.max(1 - prediction, 1e-6))
    )
    if ((prediction >= 0.5 ? 1 : 0) === label) correct += 1
  }

  const coefficients = Object.fromEntries(
    TRAINING_FEATURES.map((featureName, index) => [featureName, round(weights[index], 6)])
  )

  return {
    coefficients,
    intercept: round(bias, 6),
    means: Object.fromEntries(Object.entries(means).map(([key, value]) => [key, round(value, 6)])),
    stds: Object.fromEntries(Object.entries(stds).map(([key, value]) => [key, round(value, 6)])),
    metrics: {
      log_loss: round(logLoss / standardized.length, 6),
      accuracy: round(correct / standardized.length, 6),
      positive_rate: round(positiveRate, 6),
    },
  }
}

async function fetchTrainingRows() {
  const rows: TrainingRow[] = []
  let from = 0

  while (true) {
    const { data, error } = await db
      .from('equifax_lead_features')
      .select('*')
      .gt('feedback_total_interactions', 0)
      .order('refreshed_at', { ascending: false })
      .range(from, from + FETCH_CHUNK_SIZE - 1)

    if (error) {
      console.error('[fetchTrainingRows]', error)
      throw new Error('No se pudieron leer los features Equifax para entrenamiento.')
    }

    const chunkRows = (data ?? []) as TrainingRow[]
    rows.push(...chunkRows)
    if (chunkRows.length < FETCH_CHUNK_SIZE) break
    from += FETCH_CHUNK_SIZE
  }

  return rows
}

export async function trainEquifaxLogisticModels(options?: {
  activate?: boolean
  version?: string
}) {
  const rows = await fetchTrainingRows()
  if (rows.length < 80) {
    throw new Error('Aún no hay suficientes features con feedback para entrenar modelos Equifax.')
  }

  const version = options?.version ?? `logistic-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const trainedTargets: TrainModelResult['targets'] = []
  const targetsToInsert: Array<{
    target: 'contact' | 'interest' | 'purchase'
    model: ReturnType<typeof trainBinaryLogisticModel>
  }> = []

  for (const target of ['contact', 'interest', 'purchase'] as const) {
    const labels: number[] = rows.map(row => {
      if (target === 'contact') return row.label_contact ? 1 : 0
      if (target === 'interest') return row.label_interest ? 1 : 0
      return row.label_purchase ? 1 : 0
    })
    const positiveCount = labels.reduce((sum, value) => sum + value, 0)
    const negativeCount = labels.length - positiveCount
    const positiveRate = safeRate(labels.reduce((sum, value) => sum + value, 0), labels.length)
    if (positiveRate <= 0.02 || positiveRate >= 0.98 || positiveCount < 40 || negativeCount < 40) {
      continue
    }

    const model = trainBinaryLogisticModel(rows, target)
    targetsToInsert.push({ target, model })
  }

  if (targetsToInsert.length === 0) {
    throw new Error('Aún no hay suficiente variabilidad en labels para entrenar modelos logísticos Equifax.')
  }

  if (options?.activate !== false) {
    await db
      .from('equifax_scoring_models')
      .update({ is_active: false })
      .eq('model_key', MODEL_KEY)
  }

  for (const item of targetsToInsert) {
    const { error } = await db
      .from('equifax_scoring_models')
      .insert({
        model_key: MODEL_KEY,
        model_version: version,
        model_type: 'logistic',
        target: item.target,
        is_active: options?.activate !== false,
        trained_rows: rows.length,
        feature_names: [...TRAINING_FEATURES],
        coefficients: item.model.coefficients,
        intercept: item.model.intercept,
        metrics: item.model.metrics,
        metadata: {
          means: item.model.means,
          stds: item.model.stds,
        },
      })

    if (error) {
      console.error('[trainEquifaxLogisticModels]', error)
      throw new Error('No se pudo guardar el modelo logístico Equifax.')
    }

    trainedTargets.push({
      target: item.target,
      log_loss: toNumber(item.model.metrics.log_loss),
      accuracy: toNumber(item.model.metrics.accuracy),
      positive_rate: toNumber(item.model.metrics.positive_rate),
    })
  }

  return {
    version,
    trained_rows: rows.length,
    targets: trainedTargets,
  } satisfies TrainModelResult
}
