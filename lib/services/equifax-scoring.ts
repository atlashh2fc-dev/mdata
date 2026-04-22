import { db } from '@/lib/db/supabase'
import type {
  EquifaxLeadFeatureSnapshot,
  EquifaxLeadScoreSnapshot,
} from '@/types/equifax'

const FETCH_CHUNK_SIZE = 1000
const UPSERT_CHUNK_SIZE = 500
const FEATURE_VERSION = 'v3'
const HEURISTIC_MODEL_VERSION = 'heuristic-v3'
const MODEL_KEY = 'equifax-lead'
const SCORE_STALE_HOURS = 24
const PYME_LEGAL_SIGNAL_PATTERN = /\b(SPA|S P A|LTDA|LIMITADA|EIRL|E I R L)\b/
const LARGE_COMPANY_LEGAL_PATTERN = /\b(SA|S A|SOCIEDAD ANONIMA|CONCESIONARIA)\b/
const NON_TARGET_COMPANY_PATTERN = /\b(MUNICIPALIDAD|GOBIERNO|MINISTERIO|SERVICIO DE SALUD|HOSPITAL|UNIVERSIDAD|COLEGIO|ESCUELA|LICEO|BANCO|BANCARIA|FINANCIERA|SEGUROS|HOLDING|CORPORACION|FUNDACION|IGLESIA|PARROQUIA|DIOCESIS|RELIGIOSA|SINDICATO|ASOCIACION GREMIAL|COOPERATIVA|CAJA DE COMPENSACION)\b/
const PERSON_NAME_START_PATTERN = /^(JUAN|JOSE|MARIA|LUIS|CARLOS|PEDRO|SERGIO|MIGUEL|JORGE|CLAUDIO|RODRIGO|PATRICIO|FRANCISCO|FERNANDO|ANDRES|DANIEL|RAUL|RICARDO|VICTOR|GLADYS|MARCELA|PAOLA|ANA|ROSA|ELENA|HUGO|OSCAR|ALEJANDRO|MAURICIO|CRISTIAN|SEBASTIAN)\b/

type MasterRow = {
  rutid: string
  razon_social_empresa: string | null
  region_canonica: string | null
  comuna_canonica: string | null
  email: string | null
  fono_cel: string | null
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
  contact_phone: string | null
  contact_email: string | null
  campaign_name: string | null
  channel: string | null
  outcome: string | null
  outcome_subtype: string | null
  outcome_reason: string | null
  managed_at: string | null
  sold_at: string | null
  duration_seconds: number | null
  talk_seconds: number | null
  value_amount: number | null
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
  rejectedEvents: number
  negativeIntentEvents: number
  mediumCallEvents: number
  longCallEvents: number
  totalDurationSeconds: number
  durationSampleCount: number
  totalTalkSeconds: number
  talkSampleCount: number
  totalValueAmount: number
  maxValueAmount: number
  effectiveContacts30d: number
  interestEvents30d: number
  callbackEvents30d: number
  openedEvents30d: number
  clickedEvents30d: number
  bestManagement30d: number
  salesEvents90d: number
  negativeEvents90d: number
  bestEmail: string | null
  bestPhone: string | null
  lastFeedbackAt: string | null
  lastContactAt: string | null
  lastInterestAt: string | null
  lastCallbackAt: string | null
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
  train_rows: number
  validation_rows: number
  activation_mode: 'safe' | 'force' | 'dry-run'
  activated_targets: Array<'contact' | 'interest' | 'purchase'>
  targets: Array<{
    target: 'contact' | 'interest' | 'purchase'
    activated: boolean
    activation_reason: string
    log_loss: number
    accuracy: number
    positive_rate: number
    validation_log_loss: number
    validation_accuracy: number
    validation_brier_score: number
    validation_top_decile_precision: number
    heuristic_validation_log_loss: number
    heuristic_validation_accuracy: number
    heuristic_validation_brier_score: number
    heuristic_validation_top_decile_precision: number
  }>
}

type EvaluationMetrics = {
  log_loss: number
  accuracy: number
  brier_score: number
  top_decile_precision: number
  positive_rate: number
  sample_size: number
}

type ProjectionBucket = {
  total_leads: number
  avg_lead_score: number
  avg_contact_probability: number
  avg_interest_probability: number
  avg_purchase_probability: number
  expected_contacts: number
  expected_interests: number
  expected_purchases: number
  green: number
  yellow: number
  red: number
}

type ProjectionSummary = {
  generated_at: string
  portfolio: ProjectionBucket
  top_1000: ProjectionBucket
  top_3000: ProjectionBucket
  top_10000: ProjectionBucket
}

type CrosscheckTemperature = 'all' | 'green' | 'yellow' | 'red'

type CrosscheckBucket = {
  temperature: CrosscheckTemperature
  sample_size: number
  share: number
  avg_lead_score: number
  avg_contact_probability: number
  avg_interest_probability: number
  avg_purchase_probability: number
  actual_contact_rate: number
  actual_interest_rate: number
  actual_purchase_rate: number
  actual_contact_and_purchase_rate: number
  avg_phone_count: number
  avg_email_count: number
  avg_coverage_pct: number
}

type CrosscheckSummary = {
  generated_at: string
  model_version: string
  model_type: string
  sample_size: number
  thresholds: {
    green: {
      min_contact_probability: number
      min_purchase_probability: number
      min_lead_score: number
    }
    yellow: {
      min_contact_probability: number
      min_lead_score: number
    }
  }
  overall: CrosscheckBucket
  by_temperature: CrosscheckBucket[]
}

type EquifaxPipelineRunResult = {
  run_id: string
  trigger_source: string
  trigger_mode: 'safe' | 'force' | 'dry-run'
  refreshed_rutids: number
  refreshed_batches: number
  training: TrainModelResult | null
  projections: ProjectionSummary
  crosscheck: CrosscheckSummary | null
  finished_at: string
}

type RefreshUniverseOptions = {
  limit?: number | null
  regions?: string[]
  requireContact?: 'any' | 'phone' | 'email' | 'none'
  batchSize?: number
  orderBy?: 'score_patrimonial' | 'cobertura_pct' | 'rutid'
  dryRun?: boolean
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

function safeAverage(values: number[]) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
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

function hashString(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash)
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

function buildPymeFitScore(companyName?: string | null) {
  const normalized = normalizeKeyword(companyName ?? '').toUpperCase()
  if (!normalized) return 0
  if (NON_TARGET_COMPANY_PATTERN.test(normalized) || PERSON_NAME_START_PATTERN.test(normalized)) return 0

  let score = 18
  const hasStrictPymeLegalSignal = PYME_LEGAL_SIGNAL_PATTERN.test(normalized)
  if (!hasStrictPymeLegalSignal && LARGE_COMPANY_LEGAL_PATTERN.test(normalized)) return 0

  if (hasStrictPymeLegalSignal) score += 42
  if (/\b(COMERCIAL|SERVICIOS|TRANSPORTES|CONSTRUCTORA|INGENIERIA|AGRICOLA|INDUSTRIAL|DISTRIBUIDORA|IMPORTADORA|EXPORTADORA|ASESORIAS|CONSULTORA|RENT A CAR|LOGISTICA|TECNOLOGIA)\b/.test(normalized)) {
    score += 18
  }
  if (/\b(CHILE|SPA|LTDA|LIMITADA|EIRL|SOCIEDAD)\b/.test(normalized)) score += 8
  if (normalized.split(/\s+/).length >= 3) score += 8

  return round(clamp(score, 0, 100), 2)
}

function buildEmailEngagementScore(params: {
  openedEvents: number
  clickedEvents: number
  totalInteractions: number
  daysSinceLastFeedback?: number | null
}) {
  const hasEmailEngagement = params.openedEvents > 0 || params.clickedEvents > 0
  if (!hasEmailEngagement) return 0

  const openRate = safeRate(params.openedEvents, params.totalInteractions)
  const clickRate = safeRate(params.clickedEvents, params.totalInteractions)
  const recencyBoost = params.daysSinceLastFeedback && params.daysSinceLastFeedback > 0
    ? clamp(14 - params.daysSinceLastFeedback * 0.35, 0, 14)
    : 10

  return round(clamp(
    openRate * 100 * 0.24 +
    clickRate * 100 * 0.45 +
    Math.min(params.openedEvents, 5) * 3.5 +
    Math.min(params.clickedEvents, 3) * 12 +
    (params.clickedEvents > 0 ? 10 : 0) +
    recencyBoost,
    0,
    100
  ), 2)
}

function buildPymeIntentScore(params: {
  pymeFitScore: number
  emailEngagementScore: number
  crmSequenceScore: number
  knownPhoneCount: number
  knownEmailCount: number
  coverage: number
}) {
  const contactDataScore = clamp(
    params.knownPhoneCount * 14 +
    params.knownEmailCount * 14 +
    params.coverage * 0.16,
    0,
    100
  )

  return round(clamp(
    params.emailEngagementScore * 0.34 +
    params.crmSequenceScore * 0.3 +
    params.pymeFitScore * 0.22 +
    contactDataScore * 0.14,
    0,
    100
  ), 2)
}

function includesNegativePhrase(value?: string | null) {
  const normalized = normalizeKeyword(value ?? '')
  if (!normalized) return false

  return (
    normalized.includes('not interested') ||
    normalized.includes('no interesado') ||
    normalized.includes('no interes') ||
    normalized.includes('sin interes') ||
    normalized.includes('no le interesa') ||
    normalized.includes('no requiere') ||
    normalized.includes('no necesita') ||
    normalized.includes('rechaza') ||
    normalized.includes('rechazado') ||
    normalized.includes('declina') ||
    normalized.includes('no llamar') ||
    normalized.includes('fuera de perfil') ||
    normalized.includes('fuera de foco')
  )
}

function isRejectedFeedback(record: FeedbackRecord) {
  return (
    normalizeKeyword(record.outcome ?? '') === 'rejected' ||
    includesNegativePhrase(record.outcome) ||
    includesNegativePhrase(record.outcome_subtype) ||
    includesNegativePhrase(record.outcome_reason)
  )
}

function isMediumCall(record: FeedbackRecord) {
  return toNumber(record.duration_seconds) >= 45 || toNumber(record.talk_seconds) >= 20
}

function isLongCall(record: FeedbackRecord) {
  return toNumber(record.duration_seconds) >= 120 || toNumber(record.talk_seconds) >= 60
}

function buildCrmSequenceScore(params: {
  effectiveContacts30d: number
  interestEvents30d: number
  callbackEvents30d: number
  openedEvents30d: number
  clickedEvents30d: number
  bestManagement30d: number
  salesEvents90d: number
  negativeEvents90d: number
  rejectedEvents: number
  avgDurationSeconds: number
  avgTalkSeconds: number
  longCallEvents: number
  totalValueAmount: number
  daysSinceLastInterest: number | null
  daysSinceLastCallback: number | null
}) {
  const interestRecencyBoost = params.daysSinceLastInterest && params.daysSinceLastInterest > 0
    ? clamp(16 - params.daysSinceLastInterest * 0.4, 0, 16)
    : params.interestEvents30d > 0
      ? 12
      : 0
  const callbackRecencyBoost = params.daysSinceLastCallback && params.daysSinceLastCallback > 0
    ? clamp(18 - params.daysSinceLastCallback * 0.45, 0, 18)
    : params.callbackEvents30d > 0
      ? 14
      : 0
  const valueSignal = Math.min(params.totalValueAmount, 500000) / 500000 * 18

  return round(clamp(
    params.effectiveContacts30d * 8 +
    params.interestEvents30d * 16 +
    params.callbackEvents30d * 18 +
    params.clickedEvents30d * 10 +
    params.openedEvents30d * 2 +
    params.bestManagement30d * 8 +
    params.salesEvents90d * 14 +
    params.longCallEvents * 6 +
    params.avgDurationSeconds * 0.06 +
    params.avgTalkSeconds * 0.12 +
    valueSignal +
    interestRecencyBoost +
    callbackRecencyBoost -
    params.negativeEvents90d * 10 -
    params.rejectedEvents * 12,
    0,
    100
  ), 2)
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
  if (toNumber(feature.feature_payload.email_engagement_score) >= 32) tags.push('intencion-email')
  if (toNumber(feature.feature_payload.crm_sequence_score) >= 35) tags.push('secuencia-crm')
  if (toNumber(feature.feature_payload.callback_events_30d) > 0) tags.push('callback-reciente')
  if (toNumber(feature.feature_payload.avg_talk_seconds) >= 45) tags.push('conversacion-larga')
  if (toNumber(feature.feature_payload.negative_intent_events) > 0) tags.push('senal-negativa')
  if (feature.clicked_events > 0) tags.push('click-email')
  else if (feature.opened_events >= 2) tags.push('aperturas-email')
  if (toNumber(feature.feature_payload.pyme_fit_score) >= 55) tags.push('fit-pyme')
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

  if (params.totalInteractions <= 0) return false
  if (params.salesEvents > 0) return true
  if (params.interestEvents > 0 || params.callbackEvents > 0) return true
  if (params.effectiveContacts <= 0) return false
  if (params.noContactEvents === 0) return true
  if (params.effectiveContacts >= 3) return true
  if (params.effectiveContacts >= 2 && noContactRate <= 0.35) return true
  if (contactRate >= 0.75 && noContactRate <= 0.25 && params.totalInteractions >= 2) return true
  if (params.clickedEvents > 0 && params.openedEvents > 0 && noContactRate <= 0.2) return true

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
  if (params.clickedEvents > 0 && params.effectiveContacts > 0 && params.bestManagementEvents > 0) return true
  return false
}

function derivePurchaseLabel(params: {
  salesEvents: number
  interestEvents: number
  callbackEvents: number
  clickedEvents: number
  openedEvents: number
  bestManagementEvents: number
  effectiveContacts: number
  effectiveContacts30d: number
  interestEvents30d: number
  callbackEvents30d: number
  openedEvents30d: number
  clickedEvents30d: number
  bestManagement30d: number
  salesEvents90d: number
  rejectedEvents: number
  negativeIntentEvents: number
  mediumCallEvents: number
  longCallEvents: number
  avgDurationSeconds: number
  avgTalkSeconds: number
  totalValueAmount: number
  equifaxSalesCount: number
  isExistingCustomer: boolean
}) {
  const strongConversation =
    params.longCallEvents > 0 ||
    params.avgDurationSeconds >= 120 ||
    params.avgTalkSeconds >= 60
  const recentMomentum =
    params.interestEvents30d > 0 ||
    params.callbackEvents30d > 0 ||
    params.clickedEvents30d > 0 ||
    (params.effectiveContacts30d >= 2 && (params.mediumCallEvents > 0 || strongConversation))
  const hardNegative =
    (params.rejectedEvents >= 2 || params.negativeIntentEvents >= 3) &&
    params.interestEvents30d <= 0 &&
    params.callbackEvents30d <= 0 &&
    params.clickedEvents30d <= 0 &&
    params.salesEvents90d <= 0

  if (params.salesEvents > 0 || params.salesEvents90d > 0 || params.totalValueAmount > 0) return true
  if (hardNegative) return false
  if (params.interestEvents > 0 && params.callbackEvents > 0) return true
  if (params.interestEvents > 0 && params.bestManagementEvents > 0) return true
  if (params.callbackEvents > 0 && params.effectiveContacts >= 2) return true
  if (params.clickedEvents > 0 && params.openedEvents > 0 && params.effectiveContacts > 0 && params.negativeIntentEvents <= 0) return true
  if (params.clickedEvents > 0 && (params.interestEvents > 0 || (params.effectiveContacts30d >= 2 && params.bestManagementEvents > 0))) return true
  if (params.interestEvents30d > 0 && params.effectiveContacts30d >= 2) return true
  if (params.callbackEvents30d > 0 && (params.effectiveContacts30d > 0 || params.mediumCallEvents > 0)) return true
  if (params.clickedEvents30d > 0 && (params.callbackEvents30d > 0 || params.interestEvents30d > 0 || params.effectiveContacts30d > 0)) return true
  if (params.bestManagement30d > 0 && (params.callbackEvents30d > 0 || params.clickedEvents30d > 0 || strongConversation)) return true
  if (params.openedEvents30d >= 2 && params.effectiveContacts30d >= 2 && strongConversation && params.negativeIntentEvents <= 0) return true
  if (recentMomentum && strongConversation && params.bestManagementEvents > 0) return true
  if (params.isExistingCustomer && params.equifaxSalesCount >= 2 && (params.interestEvents > 0 || params.callbackEvents30d > 0)) return true
  if (params.negativeIntentEvents > 0 && !recentMomentum) return false
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
    'rutid,razon_social_empresa,region_canonica,comuna_canonica,email,fono_cel,score_patrimonial,cobertura_pct,totalavaluos,n_autos,n_bienes_raices',
    rutids
  )

  return new Map(rows.map(row => [row.rutid, row]))
}

async function collectUniverseRutidsForRefresh(options?: RefreshUniverseOptions) {
  const limit = options?.limit && options.limit > 0
    ? Math.round(options.limit)
    : Number.MAX_SAFE_INTEGER
  const regions = uniqueStrings(options?.regions ?? [])
  const requireContact = options?.requireContact ?? 'any'
  const orderBy = options?.orderBy ?? 'score_patrimonial'
  const rutids: string[] = []

  for (let from = 0; rutids.length < limit; from += FETCH_CHUNK_SIZE) {
    let query = db
      .from('master_personas_view')
      .select('rutid')
      .not('razon_social_empresa', 'is', null)
      .order(orderBy, {
        ascending: orderBy === 'rutid',
        nullsFirst: orderBy === 'rutid',
      })
      .range(from, from + FETCH_CHUNK_SIZE - 1)

    if (regions.length > 0) {
      query = query.in('region_canonica', regions)
    }

    if (requireContact === 'phone') {
      query = query.not('fono_cel', 'is', null)
    } else if (requireContact === 'email') {
      query = query.not('email', 'is', null)
    } else if (requireContact === 'any') {
      query = query.or('email.not.is.null,fono_cel.not.is.null')
    }

    const { data, error } = await query
    if (error) {
      console.error('[collectUniverseRutidsForRefresh]', error)
      throw new Error('No se pudo leer el universo de empresas para scoring masivo.')
    }

    const chunkRows = (data ?? []) as Array<{ rutid: string | null }>
    const chunkRutids = uniqueStrings(chunkRows.map(row => row.rutid))
    rutids.push(...chunkRutids)

    if (chunkRows.length < FETCH_CHUNK_SIZE) break
  }

  return uniqueStrings(rutids).slice(0, limit)
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
        .select('id,rutid,matched_rutid,contact_phone,contact_email,campaign_name,channel,outcome,outcome_subtype,outcome_reason,managed_at,sold_at,duration_seconds,talk_seconds,value_amount,effective_contact,interested,callback_requested,sale,mail_opened,clicked,is_best_management')
        .in('rutid', subset),
      db
        .from('contact_center_feedback')
        .select('id,rutid,matched_rutid,contact_phone,contact_email,campaign_name,channel,outcome,outcome_subtype,outcome_reason,managed_at,sold_at,duration_seconds,talk_seconds,value_amount,effective_contact,interested,callback_requested,sale,mail_opened,clicked,is_best_management')
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
  const now = Date.now()
  const dayMs = 1000 * 60 * 60 * 24

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
      rejectedEvents: 0,
      negativeIntentEvents: 0,
      mediumCallEvents: 0,
      longCallEvents: 0,
      totalDurationSeconds: 0,
      durationSampleCount: 0,
      totalTalkSeconds: 0,
      talkSampleCount: 0,
      totalValueAmount: 0,
      maxValueAmount: 0,
      effectiveContacts30d: 0,
      interestEvents30d: 0,
      callbackEvents30d: 0,
      openedEvents30d: 0,
      clickedEvents30d: 0,
      bestManagement30d: 0,
      salesEvents90d: 0,
      negativeEvents90d: 0,
      bestEmail: null,
      bestPhone: null,
      lastFeedbackAt: null,
      lastContactAt: null,
      lastInterestAt: null,
      lastCallbackAt: null,
      lastSaleFeedbackAt: null,
      equifaxEffectiveContacts: 0,
      equifaxInterestEvents: 0,
      equifaxCallbackEvents: 0,
      equifaxSalesEvents: 0,
      equifaxNoContactEvents: 0,
    }

    const isEquifax = looksLikeEquifaxCampaign(record.campaign_name)
    const managedAt = parseDate(record.managed_at)
    const daysAgo = managedAt ? Math.max(0, (now - managedAt.getTime()) / dayMs) : null
    const isLast30d = daysAgo !== null && daysAgo <= 30
    const isLast90d = daysAgo !== null && daysAgo <= 90
    const isRejected = isRejectedFeedback(record)
    const mediumCall = isMediumCall(record)
    const longCall = isLongCall(record)
    current.totalInteractions += 1
    if (isEquifax) current.equifaxInteractions += 1
    if (record.effective_contact) {
      current.effectiveContacts += 1
      if (isLast30d) current.effectiveContacts30d += 1
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
      if (isLast30d) current.interestEvents30d += 1
      current.lastInterestAt = !current.lastInterestAt || (record.managed_at ?? '') > current.lastInterestAt
        ? record.managed_at
        : current.lastInterestAt
      if (isEquifax) current.equifaxInterestEvents += 1
    }
    if (record.callback_requested || record.outcome === 'callback') {
      current.callbackEvents += 1
      if (isLast30d) current.callbackEvents30d += 1
      current.lastCallbackAt = !current.lastCallbackAt || (record.managed_at ?? '') > current.lastCallbackAt
        ? record.managed_at
        : current.lastCallbackAt
      if (isEquifax) current.equifaxCallbackEvents += 1
    }
    if (record.sale || record.outcome === 'sale') {
      current.salesEvents += 1
      if (isLast90d) current.salesEvents90d += 1
      current.lastSaleFeedbackAt = !current.lastSaleFeedbackAt || (record.sold_at ?? record.managed_at ?? '') > current.lastSaleFeedbackAt
        ? (record.sold_at ?? record.managed_at)
        : current.lastSaleFeedbackAt
      if (isEquifax) current.equifaxSalesEvents += 1
    }
    if (record.mail_opened || record.outcome === 'opened') {
      current.openedEvents += 1
      if (isLast30d) current.openedEvents30d += 1
    }
    if (record.clicked || record.outcome === 'clicked') {
      current.clickedEvents += 1
      if (isLast30d) current.clickedEvents30d += 1
    }
    if (record.is_best_management) {
      current.bestManagementEvents += 1
      if (isLast30d) current.bestManagement30d += 1
    }
    if (isRejected) current.rejectedEvents += 1
    if (isRejected || normalizeKeyword(record.outcome ?? '') === 'rejected') current.negativeIntentEvents += 1
    if (isLast90d && (isRejected || normalizeKeyword(record.outcome ?? '') === 'rejected')) current.negativeEvents90d += 1
    if (mediumCall) current.mediumCallEvents += 1
    if (longCall) current.longCallEvents += 1
    if (toNumber(record.duration_seconds) > 0) {
      current.totalDurationSeconds += toNumber(record.duration_seconds)
      current.durationSampleCount += 1
    }
    if (toNumber(record.talk_seconds) > 0) {
      current.totalTalkSeconds += toNumber(record.talk_seconds)
      current.talkSampleCount += 1
    }
    if (toNumber(record.value_amount) > 0) {
      current.totalValueAmount += toNumber(record.value_amount)
      current.maxValueAmount = Math.max(current.maxValueAmount, toNumber(record.value_amount))
    }
    if (record.contact_email && (record.mail_opened || record.clicked || record.channel === 'email')) {
      current.bestEmail = record.contact_email
    }
    if (record.contact_phone && (record.effective_contact || record.sale || record.callback_requested)) {
      current.bestPhone = record.contact_phone
    }

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
  const feedbackHasEmail = Boolean(feedback?.bestEmail || (feedback?.openedEvents ?? 0) > 0 || (feedback?.clickedEvents ?? 0) > 0)
  const knownPhoneCount = Math.max(toNumber(persona?.known_phone_count), master?.fono_cel ? 1 : 0, feedback?.bestPhone ? 1 : 0)
  const knownEmailCount = Math.max(toNumber(persona?.known_email_count), master?.email ? 1 : 0, feedbackHasEmail ? 1 : 0)
  const bestPhone = persona?.best_phone ?? feedback?.bestPhone ?? master?.fono_cel ?? null
  const bestEmail = persona?.best_email ?? feedback?.bestEmail ?? master?.email ?? null
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
  const avgDurationSeconds = round(
    safeRate(feedback?.totalDurationSeconds ?? 0, Math.max(feedback?.durationSampleCount ?? 0, 1)),
    2
  )
  const avgTalkSeconds = round(
    safeRate(feedback?.totalTalkSeconds ?? 0, Math.max(feedback?.talkSampleCount ?? 0, 1)),
    2
  )
  const emailOpenRate = safeRate(feedback?.openedEvents ?? 0, totalInteractions)
  const emailClickRate = safeRate(feedback?.clickedEvents ?? 0, totalInteractions)
  const equifaxContactShare = safeRate(equifaxInteractions, totalInteractions)
  const pymeFitScore = buildPymeFitScore(master?.razon_social_empresa)
  const daysSinceLastFeedback = diffDays(feedback?.lastFeedbackAt)
  const daysSinceLastInterest = diffDays(feedback?.lastInterestAt)
  const daysSinceLastCallback = diffDays(feedback?.lastCallbackAt)
  const emailEngagementScore = buildEmailEngagementScore({
    openedEvents: feedback?.openedEvents ?? 0,
    clickedEvents: feedback?.clickedEvents ?? 0,
    totalInteractions,
    daysSinceLastFeedback,
  })
  const crmSequenceScore = buildCrmSequenceScore({
    effectiveContacts30d: feedback?.effectiveContacts30d ?? 0,
    interestEvents30d: feedback?.interestEvents30d ?? 0,
    callbackEvents30d: feedback?.callbackEvents30d ?? 0,
    openedEvents30d: feedback?.openedEvents30d ?? 0,
    clickedEvents30d: feedback?.clickedEvents30d ?? 0,
    bestManagement30d: feedback?.bestManagement30d ?? 0,
    salesEvents90d: feedback?.salesEvents90d ?? 0,
    negativeEvents90d: feedback?.negativeEvents90d ?? 0,
    rejectedEvents: feedback?.rejectedEvents ?? 0,
    avgDurationSeconds,
    avgTalkSeconds,
    longCallEvents: feedback?.longCallEvents ?? 0,
    totalValueAmount: feedback?.totalValueAmount ?? 0,
    daysSinceLastInterest,
    daysSinceLastCallback,
  })
  const pymeIntentScore = buildPymeIntentScore({
    pymeFitScore,
    emailEngagementScore,
    crmSequenceScore,
    knownPhoneCount,
    knownEmailCount,
    coverage: toNumber(master?.cobertura_pct),
  })
  const bestManagementRate = round4(safeRate(feedback?.bestManagementEvents ?? 0, Math.max(totalInteractions, 1)))
  const mediumCallRate = round4(safeRate(feedback?.mediumCallEvents ?? 0, Math.max(totalInteractions, 1)))
  const longCallRate = round4(safeRate(feedback?.longCallEvents ?? 0, Math.max(totalInteractions, 1)))
  const negativeIntentRate = round4(safeRate(feedback?.negativeIntentEvents ?? 0, Math.max(totalInteractions, 1)))
  const rejectedRate = round4(safeRate(feedback?.rejectedEvents ?? 0, Math.max(totalInteractions, 1)))

  const featurePayload: Record<string, unknown> = {
    score_patrimonial: toNumber(master?.score_patrimonial),
    cobertura_pct: toNumber(master?.cobertura_pct),
    totalavaluos: toNumber(master?.totalavaluos),
    n_autos: toNumber(master?.n_autos),
    n_bienes_raices: toNumber(master?.n_bienes_raices),
    email_open_rate: round4(emailOpenRate),
    email_click_rate: round4(emailClickRate),
    email_engagement_score: emailEngagementScore,
    pyme_fit_score: pymeFitScore,
    pyme_intent_score: pymeIntentScore,
    crm_sequence_score: crmSequenceScore,
    equifax_contact_share: round4(equifaxContactShare),
    days_since_last_feedback: daysSinceLastFeedback,
    days_since_last_contact: diffDays(feedback?.lastContactAt),
    days_since_last_interest: daysSinceLastInterest,
    days_since_last_callback: daysSinceLastCallback,
    days_since_last_sale_feedback: diffDays(feedback?.lastSaleFeedbackAt),
    avg_duration_seconds: avgDurationSeconds,
    avg_talk_seconds: avgTalkSeconds,
    medium_call_rate: mediumCallRate,
    long_call_rate: longCallRate,
    best_management_rate: bestManagementRate,
    negative_intent_rate: negativeIntentRate,
    rejected_rate: rejectedRate,
    effective_contacts_30d: feedback?.effectiveContacts30d ?? 0,
    interest_events_30d: feedback?.interestEvents30d ?? 0,
    callback_events_30d: feedback?.callbackEvents30d ?? 0,
    opened_events_30d: feedback?.openedEvents30d ?? 0,
    clicked_events_30d: feedback?.clickedEvents30d ?? 0,
    best_management_30d: feedback?.bestManagement30d ?? 0,
    sales_events_90d: feedback?.salesEvents90d ?? 0,
    negative_events_90d: feedback?.negativeEvents90d ?? 0,
    rejected_events: feedback?.rejectedEvents ?? 0,
    negative_intent_events: feedback?.negativeIntentEvents ?? 0,
    medium_call_events: feedback?.mediumCallEvents ?? 0,
    long_call_events: feedback?.longCallEvents ?? 0,
    total_value_amount: round(feedback?.totalValueAmount ?? 0, 2),
    max_value_amount: round(feedback?.maxValueAmount ?? 0, 2),
    best_phone: bestPhone,
    best_email: bestEmail,
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
    openedEvents: feedback?.openedEvents ?? 0,
    bestManagementEvents: feedback?.bestManagementEvents ?? 0,
    effectiveContacts,
    effectiveContacts30d: feedback?.effectiveContacts30d ?? 0,
    interestEvents30d: feedback?.interestEvents30d ?? 0,
    callbackEvents30d: feedback?.callbackEvents30d ?? 0,
    openedEvents30d: feedback?.openedEvents30d ?? 0,
    clickedEvents30d: feedback?.clickedEvents30d ?? 0,
    bestManagement30d: feedback?.bestManagement30d ?? 0,
    salesEvents90d: feedback?.salesEvents90d ?? 0,
    rejectedEvents: feedback?.rejectedEvents ?? 0,
    negativeIntentEvents: feedback?.negativeIntentEvents ?? 0,
    mediumCallEvents: feedback?.mediumCallEvents ?? 0,
    longCallEvents: feedback?.longCallEvents ?? 0,
    avgDurationSeconds,
    avgTalkSeconds,
    totalValueAmount: feedback?.totalValueAmount ?? 0,
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
    known_phone_count: knownPhoneCount,
    known_email_count: knownEmailCount,
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
  const emailEngagementScore = toNumber(feature.feature_payload.email_engagement_score)
  const pymeFitScore = toNumber(feature.feature_payload.pyme_fit_score)
  const pymeIntentScore = toNumber(feature.feature_payload.pyme_intent_score)
  const crmSequenceScore = toNumber(feature.feature_payload.crm_sequence_score)
  const avgDurationSeconds = toNumber(feature.feature_payload.avg_duration_seconds)
  const avgTalkSeconds = toNumber(feature.feature_payload.avg_talk_seconds)
  const bestManagementRate = toNumber(feature.feature_payload.best_management_rate)
  const mediumCallRate = toNumber(feature.feature_payload.medium_call_rate)
  const longCallRate = toNumber(feature.feature_payload.long_call_rate)
  const negativeIntentRate = toNumber(feature.feature_payload.negative_intent_rate)
  const rejectedRate = toNumber(feature.feature_payload.rejected_rate)
  const interestEvents30d = toNumber(feature.feature_payload.interest_events_30d)
  const callbackEvents30d = toNumber(feature.feature_payload.callback_events_30d)
  const openedEvents30d = toNumber(feature.feature_payload.opened_events_30d)
  const clickedEvents30d = toNumber(feature.feature_payload.clicked_events_30d)
  const bestManagement30d = toNumber(feature.feature_payload.best_management_30d)
  const salesEvents90d = toNumber(feature.feature_payload.sales_events_90d)
  const negativeEvents90d = toNumber(feature.feature_payload.negative_events_90d)
  const daysSinceLastCallback = toNumber(feature.feature_payload.days_since_last_callback)
  const daysSinceLastFeedback = toNumber(feature.feature_payload.days_since_last_feedback)
  const recencyBoost = daysSinceLastFeedback > 0 ? clamp(20 - daysSinceLastFeedback * 0.25, 0, 20) : 0
  const callbackRecencyBoost = daysSinceLastCallback > 0 ? clamp(16 - daysSinceLastCallback * 0.35, 0, 16) : callbackEvents30d > 0 ? 10 : 0
  const conversationScore = clamp(
    avgDurationSeconds * 0.12 +
    avgTalkSeconds * 0.18 +
    mediumCallRate * 100 * 0.18 +
    longCallRate * 100 * 0.28,
    0,
    100
  )
  const negativeScore = clamp(
    negativeIntentRate * 100 * 0.7 +
    rejectedRate * 100 * 0.7 +
    negativeEvents90d * 3,
    0,
    100
  )
  const dataQualityScore = clamp(
    feature.known_phone_count * 18 +
    feature.known_email_count * 14 +
    coverage * 0.18,
    0,
    100
  )

  const baseContactProbability = clamp(
    dataQualityScore * 0.35 +
    feature.contact_rate * 100 * 0.38 +
    toNumber(feature.feature_payload.email_open_rate) * 100 * 0.08 +
    emailEngagementScore * 0.1 +
    feature.callback_rate * 100 * 0.1 +
    crmSequenceScore * 0.1 +
    callbackRecencyBoost * 0.4 +
    recencyBoost -
    feature.no_contact_rate * 100 * 0.2 -
    negativeScore * 0.12,
    0,
    100
  )

  const baseInterestProbability = clamp(
    feature.interest_rate * 100 * 0.42 +
    feature.callback_rate * 100 * 0.22 +
    toNumber(feature.feature_payload.email_click_rate) * 100 * 0.12 +
    emailEngagementScore * 0.18 +
    crmSequenceScore * 0.18 +
    callbackRecencyBoost * 0.4 +
    conversationScore * 0.12 +
    feature.contact_rate * 100 * 0.12 +
    feature.best_management_events * 2.5 +
    bestManagementRate * 100 * 0.08 +
    (feature.is_existing_customer ? 8 : 0),
    0,
    100
  )

  const basePurchaseProbability = clamp(
    feature.sale_rate * 100 * 0.24 +
    feature.interest_rate * 100 * 0.12 +
    feature.callback_rate * 100 * 0.12 +
    crmSequenceScore * 0.22 +
    pymeIntentScore * 0.14 +
    conversationScore * 0.12 +
    emailEngagementScore * 0.08 +
    patrimonial * 0.1 +
    coverage * 0.04 +
    bestManagementRate * 100 * 0.08 +
    Math.min(interestEvents30d, 4) * 3.5 +
    Math.min(callbackEvents30d, 4) * 4.5 +
    Math.min(clickedEvents30d, 3) * 4 +
    Math.min(openedEvents30d, 5) * 1.5 +
    Math.min(bestManagement30d, 4) * 3 +
    Math.min(salesEvents90d, 3) * 8 +
    callbackRecencyBoost * 0.45 +
    Math.min(feature.equifax_sales_count, 6) * 2.5 +
    (feature.is_existing_customer ? 8 : 0) -
    negativeScore * 0.22,
    0,
    100
  )

  const canUsePymeIntentFloor =
    pymeFitScore >= 55 &&
    (
      (
        emailEngagementScore >= 32 &&
        feature.known_email_count > 0 &&
        (feature.clicked_events > 0 || feature.opened_events >= 2)
      ) ||
      (
        crmSequenceScore >= 32 &&
        feature.known_phone_count > 0 &&
        (interestEvents30d > 0 || callbackEvents30d > 0 || conversationScore >= 32)
      )
    ) &&
    negativeScore < 35

  const contactIntentFloor = canUsePymeIntentFloor
    ? clamp(
        (feature.clicked_events > 0 || callbackEvents30d > 0 ? 68 : 60) +
        Math.max(emailEngagementScore * 0.1, crmSequenceScore * 0.12) +
        Math.min(feature.known_phone_count, 2) * 3 +
        Math.min(feature.opened_events + openedEvents30d, 4) * 1.5 -
        negativeScore * 0.08,
        0,
        feature.clicked_events > 0 || callbackEvents30d > 0 ? 90 : 78
      )
    : 0
  const interestIntentFloor = canUsePymeIntentFloor
    ? clamp(
        (feature.clicked_events > 0 || callbackEvents30d > 0 ? 48 : 28) +
        emailEngagementScore * (feature.clicked_events > 0 ? 0.18 : 0.1) +
        crmSequenceScore * 0.22 +
        pymeFitScore * 0.08 +
        conversationScore * 0.1 +
        Math.min(feature.clicked_events + clickedEvents30d, 3) * 4 -
        negativeScore * 0.12,
        0,
        feature.clicked_events > 0 || callbackEvents30d > 0 ? 86 : 64
      )
    : 0
  const purchaseIntentFloor = canUsePymeIntentFloor
    ? clamp(
        (feature.clicked_events > 0 || callbackEvents30d > 0 ? 34 : 26) +
        emailEngagementScore * (feature.clicked_events > 0 ? 0.12 : 0.06) +
        crmSequenceScore * 0.24 +
        pymeFitScore * 0.08 +
        pymeIntentScore * 0.12 +
        conversationScore * 0.08 +
        coverage * 0.03 +
        Math.min(feature.clicked_events + clickedEvents30d, 3) * 3 +
        Math.min(callbackEvents30d, 3) * 4 -
        negativeScore * 0.16,
        0,
        feature.clicked_events > 0 || callbackEvents30d > 0 ? 82 : 58
      )
    : 0

  const contactProbability = clamp(Math.max(baseContactProbability, contactIntentFloor), 0, 100)
  const interestProbability = clamp(Math.max(baseInterestProbability, interestIntentFloor), 0, 100)
  const purchaseProbability = clamp(Math.max(basePurchaseProbability, purchaseIntentFloor), 0, 100)

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
        callback_recency_boost: round(callbackRecencyBoost, 2),
        email_engagement_score: round(emailEngagementScore, 2),
        pyme_fit_score: round(pymeFitScore, 2),
        pyme_intent_score: round(pymeIntentScore, 2),
        crm_sequence_score: round(crmSequenceScore, 2),
        conversation_score: round(conversationScore, 2),
        negative_score: round(negativeScore, 2),
        intent_floors_applied: canUsePymeIntentFloor,
        contact_intent_floor: round(contactIntentFloor, 2),
        interest_intent_floor: round(interestIntentFloor, 2),
        purchase_intent_floor: round(purchaseIntentFloor, 2),
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

function getHeuristicProbabilityForTarget(feature: EquifaxLeadFeatureSnapshot, target: 'contact' | 'interest' | 'purchase') {
  const heuristic = buildHeuristicScore(feature)
  if (target === 'contact') return heuristic.contact_probability / 100
  if (target === 'interest') return heuristic.interest_probability / 100
  return heuristic.purchase_probability / 100
}

function evaluatePredictions(labels: number[], predictions: number[]): EvaluationMetrics {
  const sampleSize = labels.length
  if (!sampleSize) {
    return {
      log_loss: 0,
      accuracy: 0,
      brier_score: 0,
      top_decile_precision: 0,
      positive_rate: 0,
      sample_size: 0,
    }
  }

  let logLoss = 0
  let correct = 0
  let brierScore = 0
  let positiveCount = 0

  for (let index = 0; index < sampleSize; index += 1) {
    const label = labels[index]
    const prediction = clamp(predictions[index], 1e-6, 1 - 1e-6)
    positiveCount += label
    logLoss += -(
      label * Math.log(prediction) +
      (1 - label) * Math.log(1 - prediction)
    )
    brierScore += (prediction - label) ** 2
    if ((prediction >= 0.5 ? 1 : 0) === label) correct += 1
  }

  const topCount = Math.max(1, Math.ceil(sampleSize * 0.1))
  const ranked = labels
    .map((label, index) => ({ label, prediction: predictions[index] }))
    .sort((left, right) => right.prediction - left.prediction)
    .slice(0, topCount)
  const topDecilePrecision = ranked.reduce((sum, item) => sum + item.label, 0) / topCount

  return {
    log_loss: round(logLoss / sampleSize, 6),
    accuracy: round(correct / sampleSize, 6),
    brier_score: round(brierScore / sampleSize, 6),
    top_decile_precision: round(topDecilePrecision, 6),
    positive_rate: round(positiveCount / sampleSize, 6),
    sample_size: sampleSize,
  }
}

function splitRowsForTraining(rows: TrainingRow[]) {
  const trainRows: TrainingRow[] = []
  const validationRows: TrainingRow[] = []

  for (const row of rows) {
    const bucket = hashString(row.rutid) % 10
    if (bucket < 8) trainRows.push(row)
    else validationRows.push(row)
  }

  if (trainRows.length < 50 || validationRows.length < 20) {
    const fallbackSplit = Math.max(1, Math.floor(rows.length * 0.8))
    return {
      trainRows: rows.slice(0, fallbackSplit),
      validationRows: rows.slice(fallbackSplit),
    }
  }

  return { trainRows, validationRows }
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

async function loadActiveModelRows() {
  const { data, error } = await db
    .from('equifax_scoring_models')
    .select('target,model_version,model_type,intercept,feature_names,coefficients,metrics,metadata')
    .eq('model_key', MODEL_KEY)
    .eq('is_active', true)

  if (error) {
    console.error('[loadActiveModelRows]', error)
    return new Map<'contact' | 'interest' | 'purchase', LogisticModelRow>()
  }

  return new Map(
    ((data ?? []) as LogisticModelRow[]).map(row => [row.target, row])
  )
}

async function restoreLatestHistoricalModel(
  target: 'contact' | 'interest' | 'purchase',
  skipVersion?: string
) {
  const { data, error } = await db
    .from('equifax_scoring_models')
    .select('id,model_version')
    .eq('model_key', MODEL_KEY)
    .eq('target', target)
    .eq('model_type', 'logistic')
    .order('trained_at', { ascending: false })
    .limit(10)

  if (error) {
    console.error('[restoreLatestHistoricalModel]', error)
    return null
  }

  const candidate = ((data ?? []) as Array<{ id: string; model_version: string }>)
    .find(row => row.model_version !== skipVersion)

  if (!candidate?.id) return null

  const { error: updateError } = await db
    .from('equifax_scoring_models')
    .update({ is_active: true })
    .eq('id', candidate.id)

  if (updateError) {
    console.error('[restoreLatestHistoricalModel:update]', updateError)
    return null
  }

  return candidate.model_version
}

function shouldActivateCandidateModel(params: {
  target: 'contact' | 'interest' | 'purchase'
  activationMode: 'safe' | 'force' | 'dry-run'
  candidateMetrics: EvaluationMetrics
  heuristicMetrics: EvaluationMetrics
}) {
  if (params.activationMode === 'dry-run') {
    return { activated: false, reason: 'dry-run' }
  }

  if (params.activationMode === 'force') {
    return { activated: true, reason: 'force-activate' }
  }

  const beatsHeuristicLoss = params.candidateMetrics.log_loss <= params.heuristicMetrics.log_loss * 1.01
  const beatsHeuristicBrier = params.candidateMetrics.brier_score <= params.heuristicMetrics.brier_score * 1.01
  const keepsAccuracy = params.candidateMetrics.accuracy >= params.heuristicMetrics.accuracy - 0.025
  const keepsPrecision = params.candidateMetrics.top_decile_precision >= params.heuristicMetrics.top_decile_precision * 0.95

  if (beatsHeuristicLoss && beatsHeuristicBrier && keepsAccuracy && keepsPrecision) {
    return { activated: true, reason: 'safe-improvement' }
  }

  return { activated: false, reason: 'guardrail-blocked' }
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
  const heuristicBreakdown = (heuristic.score_breakdown.heuristic ?? {}) as Record<string, unknown>
  const appliesPymeIntentFloor = heuristicBreakdown.intent_floors_applied === true
  const contactIntentFloor = toNumber(heuristicBreakdown.contact_intent_floor)
  const interestIntentFloor = toNumber(heuristicBreakdown.interest_intent_floor)
  const purchaseIntentFloor = toNumber(heuristicBreakdown.purchase_intent_floor)

  const blendedContactProbability = logisticContact === null
    ? heuristic.contact_probability
    : round(logisticContact * 0.65 + heuristic.contact_probability * 0.35, 2)
  const blendedInterestProbability = logisticInterest === null
    ? heuristic.interest_probability
    : round(logisticInterest * 0.65 + heuristic.interest_probability * 0.35, 2)
  const blendedPurchaseProbability = logisticPurchase === null
    ? heuristic.purchase_probability
    : round(logisticPurchase * 0.65 + heuristic.purchase_probability * 0.35, 2)
  const contactProbability = appliesPymeIntentFloor
    ? round(Math.max(blendedContactProbability, contactIntentFloor), 2)
    : blendedContactProbability
  const interestProbability = appliesPymeIntentFloor
    ? round(Math.max(blendedInterestProbability, interestIntentFloor), 2)
    : blendedInterestProbability
  const purchaseProbability = appliesPymeIntentFloor
    ? round(Math.max(blendedPurchaseProbability, purchaseIntentFloor), 2)
    : blendedPurchaseProbability

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
    appliesPymeIntentFloor ? 'piso-intencion-pyme' : null,
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
      hybrid_adjustment: {
        pyme_intent_floor_applied: appliesPymeIntentFloor,
        blended_contact_probability: blendedContactProbability,
        blended_interest_probability: blendedInterestProbability,
        blended_purchase_probability: blendedPurchaseProbability,
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

export async function refreshEquifaxLeadScoresForUniverse(options?: RefreshUniverseOptions) {
  const startedAt = new Date().toISOString()
  const rutids = await collectUniverseRutidsForRefresh(options)
  const batchSize = Math.max(100, Math.min(2000, Math.round(options?.batchSize ?? UPSERT_CHUNK_SIZE)))
  let refreshedRutids = 0
  let refreshedBatches = 0

  if (!options?.dryRun) {
    for (const subset of chunk(rutids, batchSize)) {
      await refreshEquifaxLeadScoresForRutids(subset)
      refreshedRutids += subset.length
      refreshedBatches += 1
    }
  }

  return {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    selected_rutids: rutids.length,
    refreshed_rutids: options?.dryRun ? 0 : refreshedRutids,
    refreshed_batches: options?.dryRun ? 0 : refreshedBatches,
    dry_run: options?.dryRun === true,
    filters: {
      limit: options?.limit ?? null,
      regions: uniqueStrings(options?.regions ?? []),
      require_contact: options?.requireContact ?? 'any',
      batch_size: batchSize,
      order_by: options?.orderBy ?? 'score_patrimonial',
    },
    sample_rutids: rutids.slice(0, 15),
  }
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
  'email_engagement_score',
  'pyme_fit_score',
  'pyme_intent_score',
  'crm_sequence_score',
  'equifax_contact_share',
  'feedback_total_interactions',
  'feedback_equifax_interactions',
  'effective_contacts',
  'interest_events',
  'callback_events',
  'sales_events',
  'effective_contacts_30d',
  'interest_events_30d',
  'callback_events_30d',
  'opened_events_30d',
  'clicked_events_30d',
  'best_management_30d',
  'sales_events_90d',
  'negative_events_90d',
  'avg_duration_seconds',
  'avg_talk_seconds',
  'medium_call_rate',
  'long_call_rate',
  'best_management_rate',
  'negative_intent_rate',
  'rejected_rate',
  'rejected_events',
  'negative_intent_events',
  'total_value_amount',
  'max_value_amount',
  'score_patrimonial',
  'cobertura_pct',
  'equifax_sales_count',
  'equifax_total_amount',
  'is_existing_customer',
  'days_since_last_feedback',
  'days_since_last_contact',
  'days_since_last_interest',
  'days_since_last_callback',
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

function predictProbabilityFromModel(
  model: ReturnType<typeof trainBinaryLogisticModel>,
  row: TrainingRow
) {
  let value = model.intercept

  for (const featureName of TRAINING_FEATURES) {
    const raw = getFeatureValue(row, featureName)
    const mean = toNumber(model.means[featureName])
    const std = Math.max(toNumber(model.stds[featureName]), 1e-6)
    const standardized = (raw - mean) / std
    value += standardized * toNumber(model.coefficients[featureName])
  }

  return clamp(sigmoid(value), 0, 1)
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

async function createPipelineRun(params: {
  triggerSource: string
  triggerMode: 'safe' | 'force' | 'dry-run'
}) {
  const { data, error } = await db
    .from('equifax_scoring_pipeline_runs')
    .insert({
      trigger_source: params.triggerSource,
      trigger_mode: params.triggerMode,
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error || !data?.id) {
    console.error('[createPipelineRun]', error)
    throw new Error('No se pudo crear la corrida del pipeline Equifax.')
  }

  return String(data.id)
}

async function updatePipelineRun(runId: string, payload: Record<string, unknown>) {
  const { error } = await db
    .from('equifax_scoring_pipeline_runs')
    .update({
      ...payload,
      updated_at: new Date().toISOString(),
    })
    .eq('id', runId)

  if (error) {
    console.error('[updatePipelineRun]', error)
  }
}

async function collectEquifaxFeedbackRutids() {
  const rutids = new Set<string>()
  let from = 0

  while (true) {
    const { data, error } = await db
      .from('contact_center_feedback')
      .select('rutid,matched_rutid,campaign_name')
      .or([
        'campaign_name.ilike.%equifax%',
        'campaign_name.ilike.%dicom%',
        'campaign_name.ilike.%riesgo comercial%',
        'campaign_name.ilike.%verificacion comercial%',
        'campaign_name.ilike.%informe comercial%',
      ].join(','))
      .range(from, from + FETCH_CHUNK_SIZE - 1)

    if (error) {
      console.error('[collectEquifaxFeedbackRutids]', error)
      throw new Error('No se pudieron leer los RUTs Equifax con feedback.')
    }

    const rows = (data ?? []) as Array<{
      rutid: string | null
      matched_rutid: string | null
      campaign_name: string | null
    }>

    for (const row of rows) {
      const rutid = String(row.matched_rutid ?? row.rutid ?? '').trim()
      if (rutid) rutids.add(rutid)
    }

    if (rows.length < FETCH_CHUNK_SIZE) break
    from += FETCH_CHUNK_SIZE
  }

  return [...rutids]
}

async function fetchScoreProjectionRows() {
  const rows: EquifaxLeadScoreSnapshot[] = []
  let from = 0

  while (true) {
    const { data, error } = await db
      .from('equifax_lead_scores')
      .select('rutid,model_version,model_type,contact_probability,interest_probability,purchase_probability,fit_score,lead_score,lead_temperature,recommended_channel,recommended_hour,reason_tags,score_breakdown,scored_at')
      .order('lead_score', { ascending: false })
      .range(from, from + FETCH_CHUNK_SIZE - 1)

    if (error) {
      console.error('[fetchScoreProjectionRows]', error)
      throw new Error('No se pudieron leer los scores Equifax para proyección.')
    }

    const subset = (data ?? []) as EquifaxLeadScoreSnapshot[]
    rows.push(...subset)
    if (subset.length < FETCH_CHUNK_SIZE) break
    from += FETCH_CHUNK_SIZE
  }

  return rows
}

function summarizeProjectionBucket(rows: EquifaxLeadScoreSnapshot[]): ProjectionBucket {
  const total = rows.length
  const avgLeadScore = safeAverage(rows.map(row => toNumber(row.lead_score)))
  const avgContact = safeAverage(rows.map(row => toNumber(row.contact_probability)))
  const avgInterest = safeAverage(rows.map(row => toNumber(row.interest_probability)))
  const avgPurchase = safeAverage(rows.map(row => toNumber(row.purchase_probability)))

  return {
    total_leads: total,
    avg_lead_score: round(avgLeadScore, 2),
    avg_contact_probability: round(avgContact, 2),
    avg_interest_probability: round(avgInterest, 2),
    avg_purchase_probability: round(avgPurchase, 2),
    expected_contacts: round(rows.reduce((sum, row) => sum + toNumber(row.contact_probability), 0) / 100, 2),
    expected_interests: round(rows.reduce((sum, row) => sum + toNumber(row.interest_probability), 0) / 100, 2),
    expected_purchases: round(rows.reduce((sum, row) => sum + toNumber(row.purchase_probability), 0) / 100, 2),
    green: rows.filter(row => row.lead_temperature === 'green').length,
    yellow: rows.filter(row => row.lead_temperature === 'yellow').length,
    red: rows.filter(row => row.lead_temperature === 'red').length,
  }
}

function summarizeCrosscheckBucket(
  temperature: CrosscheckTemperature,
  rows: Array<{
    lead_score: number
    contact_probability: number
    interest_probability: number
    purchase_probability: number
    known_phone_count: number
    known_email_count: number
    coverage_pct: number
    label_contact: boolean
    label_interest: boolean
    label_purchase: boolean
  }>,
  totalSampleSize: number
): CrosscheckBucket {
  const sampleSize = rows.length
  const safeAvg = (values: number[]) => sampleSize ? safeAverage(values) : 0

  return {
    temperature,
    sample_size: sampleSize,
    share: round(safeRate(sampleSize, Math.max(totalSampleSize, 1)), 4),
    avg_lead_score: round(safeAvg(rows.map(row => row.lead_score)), 2),
    avg_contact_probability: round(safeAvg(rows.map(row => row.contact_probability)), 2),
    avg_interest_probability: round(safeAvg(rows.map(row => row.interest_probability)), 2),
    avg_purchase_probability: round(safeAvg(rows.map(row => row.purchase_probability)), 2),
    actual_contact_rate: round(safeRate(rows.filter(row => row.label_contact).length, Math.max(sampleSize, 1)), 4),
    actual_interest_rate: round(safeRate(rows.filter(row => row.label_interest).length, Math.max(sampleSize, 1)), 4),
    actual_purchase_rate: round(safeRate(rows.filter(row => row.label_purchase).length, Math.max(sampleSize, 1)), 4),
    actual_contact_and_purchase_rate: round(
      safeRate(
        rows.filter(row => row.label_contact && row.label_purchase).length,
        Math.max(sampleSize, 1)
      ),
      4
    ),
    avg_phone_count: round(safeAvg(rows.map(row => row.known_phone_count)), 2),
    avg_email_count: round(safeAvg(rows.map(row => row.known_email_count)), 2),
    avg_coverage_pct: round(safeAvg(rows.map(row => row.coverage_pct)), 2),
  }
}

export async function buildEquifaxProjectionSummary(): Promise<ProjectionSummary> {
  const rows = await fetchScoreProjectionRows()

  return {
    generated_at: new Date().toISOString(),
    portfolio: summarizeProjectionBucket(rows),
    top_1000: summarizeProjectionBucket(rows.slice(0, 1000)),
    top_3000: summarizeProjectionBucket(rows.slice(0, 3000)),
    top_10000: summarizeProjectionBucket(rows.slice(0, 10000)),
  }
}

export async function buildEquifaxModelCrosscheckSummary(): Promise<CrosscheckSummary | null> {
  const rows = await fetchTrainingRows()
  if (!rows.length) return null

  const models = await loadActiveLogisticModels()
  const sampleRows = rows.map(row => {
    const heuristic = buildHeuristicScore(row)
    const combined = combineScores(row, heuristic, models)

    return {
      lead_temperature: combined.lead_temperature,
      lead_score: combined.lead_score,
      contact_probability: combined.contact_probability,
      interest_probability: combined.interest_probability,
      purchase_probability: combined.purchase_probability,
      known_phone_count: row.known_phone_count,
      known_email_count: row.known_email_count,
      coverage_pct: toNumber(row.feature_payload.cobertura_pct),
      label_contact: row.label_contact,
      label_interest: row.label_interest,
      label_purchase: row.label_purchase,
    }
  })

  const overall = summarizeCrosscheckBucket('all', sampleRows, sampleRows.length)
  const byTemperature = (['green', 'yellow', 'red'] as const).map(temperature =>
    summarizeCrosscheckBucket(
      temperature,
      sampleRows.filter(row => row.lead_temperature === temperature),
      sampleRows.length
    )
  )

  const firstRow = rows[0]
  const firstCombined = combineScores(firstRow, buildHeuristicScore(firstRow), models)

  return {
    generated_at: new Date().toISOString(),
    model_version: firstCombined.model_version,
    model_type: firstCombined.model_type,
    sample_size: sampleRows.length,
    thresholds: {
      green: {
        min_contact_probability: 60,
        min_purchase_probability: 35,
        min_lead_score: 65,
      },
      yellow: {
        min_contact_probability: 35,
        min_lead_score: 42,
      },
    },
    overall,
    by_temperature: byTemperature,
  }
}

export async function trainEquifaxLogisticModels(options?: {
  activate?: boolean
  version?: string
  activationMode?: 'safe' | 'force' | 'dry-run'
}) {
  const rows = await fetchTrainingRows()
  if (rows.length < 80) {
    throw new Error('Aún no hay suficientes features con feedback para entrenar modelos Equifax.')
  }

  const { trainRows, validationRows } = splitRowsForTraining(rows)
  if (trainRows.length < 60 || validationRows.length < 20) {
    throw new Error('No hay split suficiente entre train y validación para entrenar con guardrails.')
  }

  const version = options?.version ?? `logistic-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const activationMode = options?.activationMode ?? (options?.activate === false ? 'dry-run' : 'safe')
  const trainedTargets: TrainModelResult['targets'] = []
  const targetsToInsert: Array<{
    target: 'contact' | 'interest' | 'purchase'
    model: ReturnType<typeof trainBinaryLogisticModel>
    activate: boolean
    activationReason: string
    candidateMetrics: EvaluationMetrics
    heuristicMetrics: EvaluationMetrics
  }> = []
  const activeModelRows = await loadActiveModelRows()
  const activatedTargets: Array<'contact' | 'interest' | 'purchase'> = []
  const targetActivationState = new Map<'contact' | 'interest' | 'purchase', boolean>()

  for (const target of ['contact', 'interest', 'purchase'] as const) {
    const labels: number[] = rows.map(row => {
      if (target === 'contact') return row.label_contact ? 1 : 0
      if (target === 'interest') return row.label_interest ? 1 : 0
      return row.label_purchase ? 1 : 0
    })
    const positiveCount = labels.reduce((sum, value) => sum + value, 0)
    const negativeCount = labels.length - positiveCount
    const positiveRate = safeRate(positiveCount, labels.length)
    if (positiveRate <= 0.02 || positiveRate >= 0.98 || positiveCount < 40 || negativeCount < 40) {
      continue
    }

    const validationLabels: number[] = validationRows.map(row => {
      if (target === 'contact') return row.label_contact ? 1 : 0
      if (target === 'interest') return row.label_interest ? 1 : 0
      return row.label_purchase ? 1 : 0
    })
    const validationPositiveCount = validationLabels.reduce((sum, value) => sum + value, 0)
    const validationNegativeCount = validationLabels.length - validationPositiveCount
    if (validationPositiveCount < 10 || validationNegativeCount < 10) {
      continue
    }

    const model = trainBinaryLogisticModel(trainRows, target)
    const logisticPredictions = validationRows.map(row => predictProbabilityFromModel(model, row))
    const heuristicPredictions = validationRows.map(row => getHeuristicProbabilityForTarget(row, target))

    const candidateMetrics = evaluatePredictions(validationLabels, logisticPredictions)
    const heuristicMetrics = evaluatePredictions(validationLabels, heuristicPredictions)

    const activationDecision = shouldActivateCandidateModel({
      target,
      activationMode,
      candidateMetrics,
      heuristicMetrics,
    })

    targetsToInsert.push({
      target,
      model,
      activate: options?.activate !== false && activationDecision.activated,
      activationReason: activationDecision.reason,
      candidateMetrics,
      heuristicMetrics,
    })
  }

  if (targetsToInsert.length === 0) {
    throw new Error('Aún no hay suficiente variabilidad en labels para entrenar modelos logísticos Equifax.')
  }

  for (const item of targetsToInsert) {
    if (item.activate) {
      await db
        .from('equifax_scoring_models')
        .update({ is_active: false })
        .eq('model_key', MODEL_KEY)
        .eq('target', item.target)
    }

    const currentActiveMetrics = activeModelRows.get(item.target)?.metrics ?? null
    const { error } = await db
      .from('equifax_scoring_models')
      .insert({
        model_key: MODEL_KEY,
        model_version: version,
        model_type: 'logistic',
        target: item.target,
        is_active: item.activate,
        trained_rows: rows.length,
        feature_names: [...TRAINING_FEATURES],
        coefficients: item.model.coefficients,
        intercept: item.model.intercept,
        metrics: {
          train: item.model.metrics,
          validation: item.candidateMetrics,
          heuristic_validation: item.heuristicMetrics,
          previous_active_metrics: currentActiveMetrics,
        },
        metadata: {
          means: item.model.means,
          stds: item.model.stds,
          train_rows: trainRows.length,
          validation_rows: validationRows.length,
          activation_mode: activationMode,
          activation_reason: item.activationReason,
        },
      })

    if (error) {
      console.error('[trainEquifaxLogisticModels]', error)
      throw new Error('No se pudo guardar el modelo logístico Equifax.')
    }

    if (item.activate) activatedTargets.push(item.target)
    targetActivationState.set(item.target, item.activate)

    trainedTargets.push({
      target: item.target,
      activated: item.activate,
      activation_reason: item.activationReason,
      log_loss: toNumber(item.model.metrics.log_loss),
      accuracy: toNumber(item.model.metrics.accuracy),
      positive_rate: toNumber(item.model.metrics.positive_rate),
      validation_log_loss: item.candidateMetrics.log_loss,
      validation_accuracy: item.candidateMetrics.accuracy,
      validation_brier_score: item.candidateMetrics.brier_score,
      validation_top_decile_precision: item.candidateMetrics.top_decile_precision,
      heuristic_validation_log_loss: item.heuristicMetrics.log_loss,
      heuristic_validation_accuracy: item.heuristicMetrics.accuracy,
      heuristic_validation_brier_score: item.heuristicMetrics.brier_score,
      heuristic_validation_top_decile_precision: item.heuristicMetrics.top_decile_precision,
    })
  }

  for (const target of ['contact', 'interest', 'purchase'] as const) {
    if (targetActivationState.get(target)) continue
    if (activeModelRows.has(target)) continue

    const restoredVersion = await restoreLatestHistoricalModel(target, version)
    if (restoredVersion) {
      activatedTargets.push(target)
      const existingIndex = trainedTargets.findIndex(item => item.target === target)
      if (existingIndex >= 0) {
        trainedTargets[existingIndex] = {
          ...trainedTargets[existingIndex],
          activated: true,
          activation_reason: `restored-${restoredVersion}`,
        }
      } else {
        trainedTargets.push({
          target,
          activated: true,
          activation_reason: `restored-${restoredVersion}`,
          log_loss: 0,
          accuracy: 0,
          positive_rate: 0,
          validation_log_loss: 0,
          validation_accuracy: 0,
          validation_brier_score: 0,
          validation_top_decile_precision: 0,
          heuristic_validation_log_loss: 0,
          heuristic_validation_accuracy: 0,
          heuristic_validation_brier_score: 0,
          heuristic_validation_top_decile_precision: 0,
        })
      }
    }
  }

  const uniqueActivatedTargets = [...new Set(activatedTargets)] as Array<'contact' | 'interest' | 'purchase'>

  return {
    version,
    trained_rows: rows.length,
    train_rows: trainRows.length,
    validation_rows: validationRows.length,
    activation_mode: activationMode,
    activated_targets: uniqueActivatedTargets,
    targets: trainedTargets,
  } satisfies TrainModelResult
}

export async function runEquifaxScoringPipeline(options?: {
  triggerSource?: string
  activationMode?: 'safe' | 'force' | 'dry-run'
}) {
  const triggerSource = options?.triggerSource ?? 'manual'
  const activationMode = options?.activationMode ?? 'safe'
  const runId = await createPipelineRun({
    triggerSource,
    triggerMode: activationMode,
  })

  try {
    const rutids = await collectEquifaxFeedbackRutids()
    let refreshedBatches = 0

    for (const subset of chunk(rutids, UPSERT_CHUNK_SIZE)) {
      await refreshEquifaxLeadScoresForRutids(subset)
      refreshedBatches += 1
    }

    let training: TrainModelResult | null = null
    try {
      training = await trainEquifaxLogisticModels({
        activate: activationMode !== 'dry-run',
        activationMode,
      })
    } catch (error) {
      console.warn('[runEquifaxScoringPipeline:training]', error instanceof Error ? error.message : error)
    }

    if (training?.activated_targets.length) {
      for (const subset of chunk(rutids, UPSERT_CHUNK_SIZE)) {
        await refreshEquifaxLeadScoresForRutids(subset)
      }
    }

    const projections = await buildEquifaxProjectionSummary()
    const crosscheck = await buildEquifaxModelCrosscheckSummary()
    const finishedAt = new Date().toISOString()

    await updatePipelineRun(runId, {
      status: 'success',
      refreshed_rutids: rutids.length,
      refreshed_batches: refreshedBatches,
      models_trained: training?.targets.length ?? 0,
      activated_targets: training?.activated_targets ?? [],
      model_version: training?.version ?? null,
      training_payload: training,
      projection_payload: projections,
      notes: training?.activated_targets.length
        ? `Se activaron ${training.activated_targets.join(', ')}`
        : 'No se activaron targets nuevos; se mantuvieron los modelos vigentes',
      finished_at: finishedAt,
    })

    return {
      run_id: runId,
      trigger_source: triggerSource,
      trigger_mode: activationMode,
      refreshed_rutids: rutids.length,
      refreshed_batches: refreshedBatches,
      training,
      projections,
      crosscheck,
      finished_at: finishedAt,
    } satisfies EquifaxPipelineRunResult
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido en pipeline Equifax.'
    await updatePipelineRun(runId, {
      status: 'failed',
      error_message: message,
      finished_at: new Date().toISOString(),
    })
    throw error
  }
}
