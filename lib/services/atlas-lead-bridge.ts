import { createHmac, timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db/supabase'
import { normalizeCompanyName } from '@/lib/utils/company-match'
import { cleanRut } from '@/lib/utils/rut'
import type { ContactCenterFeedbackInput, FeedbackOutcome } from '@/types'

const ATLAS_ALLOWED_EVENT_TYPES = new Set([
  'sent',
  'opened',
  'clicked',
  'bounced',
  'bounce',
  'failed',
  'delivery_failed',
  'undeliverable',
])
const ATLAS_SUPPORTED_EVENT_TYPES = new Set([
  'opened',
  'clicked',
  'bounced',
  'bounce',
  'failed',
  'delivery_failed',
  'undeliverable',
])
const ATLAS_MAX_SIGNATURE_AGE_MS = 15 * 60 * 1000

type AtlasLeadBridgePayload = {
  source?: string
  eventType?: string
  eventAt?: string
  campaign?: {
    sourceCampaignId?: string | null
    sourceCampaignName?: string | null
    sourceCampaignType?: string | null
  } | null
  outreach?: {
    messageId?: string | null
    outreachId?: string | null
    leadId?: string | null
    sentAt?: string | null
    openedAt?: string | null
    clickedAt?: string | null
    subject?: string | null
    messageType?: string | null
  } | null
  lead?: {
    companyName?: string | null
    email?: string | null
    phone?: string | null
    country?: string | null
    website?: string | null
    metadata?: Record<string, unknown> | null
  } | null
  context?: {
    requestId?: string | null
    locale?: string | null
  } | null
}

type AtlasEngagementV1Payload = {
  schema_version?: string
  event_type?: string
  event_name?: string
  event_id?: string
  occurred_at?: string
  source?: { system?: string; component?: string } | string
  engagement?: {
    kind?: string
    type?: string
    channel?: string
    campaign?: AtlasLeadBridgePayload['campaign']
    outreach?: AtlasLeadBridgePayload['outreach']
    lead?: AtlasLeadBridgePayload['lead']
    context?: AtlasLeadBridgePayload['context']
  }
}

type AtlasOperationFeedbackV1Item = {
  event_id?: string
  event_type?: string
  occurred_at?: string
  payload?: {
    campaign_key?: string
    external_key?: string
    ended_at?: string | null
    duration_seconds?: number | null
    status?: string | null
    outcome?: string | null
    reason?: string | null
    next_action_at?: string | null
  }
}

type AtlasBridgeAuthorization =
  | { ok: true; mode: 'shared-secret' | 'hmac' }
  | { ok: false; status: number; error: string }

type AtlasBridgePayloadParseResult =
  | {
      ok: true
      ignored: false
      eventType: 'opened' | 'clicked' | 'bounced'
      eventAt: string
      campaignType: string | null
      record: ContactCenterFeedbackInput
    }
  | {
      ok: true
      ignored: true
      reason: string
    }
  | {
      ok: false
      status: number
      error: string
    }

type CompanyNameMatchRow = {
  match_key: string | null
  rutid: string | null
  razon_social_empresa: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized || null
}

function normalizeIsoDatetime(value: unknown): string | null {
  const raw = readString(value)
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function getAtlasBridgeSecret(source?: string | null): string | null {
  if (source === 'atlas2') return readString(process.env.ATLAS2_FEEDBACK_BRIDGE_SECRET)
  return (
    readString(process.env.ATLAS_LEAD_BRIDGE_SECRET) ??
    readString(process.env.CRM_FEEDBACK_INGEST_TOKEN)
  )
}

function normalizeRutCandidate(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const cleaned = cleanRut(String(value))
  if (cleaned.length < 2) return null
  return cleaned.padStart(10, '0')
}

function extractLeadRutid(payload: AtlasLeadBridgePayload): string | null {
  const metadata = isRecord(payload.lead?.metadata) ? payload.lead?.metadata : null
  if (!metadata) return null

  const candidates = [
    metadata.rutdv,
    metadata.rutid,
    metadata.rut,
    metadata.lead_rut,
    metadata.customer_rut,
  ]

  for (const candidate of candidates) {
    const normalized = normalizeRutCandidate(candidate)
    if (normalized) return normalized
  }

  return null
}

function readMetadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!metadata) return null
  return readString(metadata[key])
}

export async function resolveAtlasBridgeCompanyMatch(
  record: ContactCenterFeedbackInput
): Promise<ContactCenterFeedbackInput> {
  const [resolved] = await resolveAtlasBridgeCompanyMatches([record])
  return resolved ?? record
}

export async function resolveAtlasBridgeCompanyMatches(
  records: ContactCenterFeedbackInput[]
): Promise<ContactCenterFeedbackInput[]> {
  const candidates = records.map(record => {
    const metadata = isRecord(record.metadata) ? record.metadata : {}
    const companyName =
      readMetadataString(metadata, 'company_name') ??
      readString((record.raw_payload?.lead as Record<string, unknown> | undefined)?.companyName)
    return { record, metadata, companyName, matchKey: companyName ? normalizeCompanyName(companyName) : null }
  })
  const companyNames = [...new Set(candidates.map(candidate => candidate.companyName).filter((value): value is string => Boolean(value)))]
  if (!companyNames.length) return records

  const { data, error } = await db.rpc('match_company_names', {
    input_names: companyNames,
  })

  if (error) {
    console.warn('[resolveAtlasBridgeCompanyMatches]', error.message)
    return records
  }

  const matchesByKey = new Map<string, Map<string, CompanyNameMatchRow>>()
  for (const row of (data ?? []) as CompanyNameMatchRow[]) {
    if (!row.match_key || !row.rutid) continue
    const matches = matchesByKey.get(row.match_key) ?? new Map<string, CompanyNameMatchRow>()
    matches.set(row.rutid, row)
    matchesByKey.set(row.match_key, matches)
  }

  return candidates.map(({ record, metadata, companyName, matchKey }) => {
    if (!companyName || !matchKey) return record
    const uniqueMatches = matchesByKey.get(matchKey) ?? new Map<string, CompanyNameMatchRow>()

    if (uniqueMatches.size !== 1) {
      return {
        ...record,
        metadata: {
          ...metadata,
          company_name: companyName,
          atlas_company_match_key: matchKey,
          atlas_company_match_status: uniqueMatches.size === 0 ? 'not_found' : 'ambiguous',
        },
      }
    }

    const [matchedRutid, match] = [...uniqueMatches.entries()][0]
    return {
      ...record,
      matched_rutid: matchedRutid,
      match_method: 'atlas_company_name_exact',
      metadata: {
        ...metadata,
        company_name: companyName,
        atlas_original_rutid: record.rutid ?? null,
        atlas_original_matched_rutid: record.matched_rutid ?? null,
        atlas_company_match_key: matchKey,
        atlas_company_match_status: 'matched',
        atlas_company_match_name: match.razon_social_empresa ?? null,
      },
    }
  })
}

function compareSignatures(expected: string, candidate: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf8')
  const candidateBuffer = Buffer.from(candidate, 'utf8')
  if (expectedBuffer.length !== candidateBuffer.length) return false
  return timingSafeEqual(expectedBuffer, candidateBuffer)
}

export function authorizeAtlasLeadBridgeRequest(args: {
  rawBody: string
  source?: string | null
  apiKey?: string | null
  signature?: string | null
  timestamp?: string | null
}): AtlasBridgeAuthorization {
  const source = readString(args.source)
  const atlas2Feedback = source === 'atlas2'
  const secret = getAtlasBridgeSecret(source)
  if (!secret) {
    return {
      ok: false,
      status: 503,
      error: atlas2Feedback
        ? 'ATLAS2_FEEDBACK_BRIDGE_SECRET no está configurado.'
        : 'ATLAS_LEAD_BRIDGE_SECRET no está configurado.',
    }
  }

  const apiKey = readString(args.apiKey)
  if (!atlas2Feedback && apiKey && compareSignatures(secret, apiKey)) {
    return { ok: true, mode: 'shared-secret' }
  }

  const signature = readString(args.signature)
  const timestamp = readString(args.timestamp)
  if (!signature || !timestamp) {
    return {
      ok: false,
      status: 401,
      error: 'Faltan headers x-atlas-signature y x-atlas-timestamp.',
    }
  }

  if (atlas2Feedback && !/^\d{10}$/.test(timestamp)) {
    return { ok: false, status: 401, error: 'Atlas2 requiere x-atlas-timestamp en segundos UNIX.' }
  }

  const unixSeconds = /^\d{10}$/.test(timestamp) ? Number(timestamp) : null
  const timestampMs = unixSeconds === null ? new Date(timestamp).getTime() : unixSeconds * 1000
  if (!Number.isFinite(timestampMs)) {
    return {
      ok: false,
      status: 401,
      error: 'x-atlas-timestamp es inválido.',
    }
  }

  const ageMs = Math.abs(Date.now() - timestampMs)
  if (ageMs > ATLAS_MAX_SIGNATURE_AGE_MS) {
    return {
      ok: false,
      status: 401,
      error: 'La firma del bridge Atlas expiró.',
    }
  }

  const expectedSignature = createHmac('sha256', secret)
    .update(`${timestamp}.${args.rawBody}`)
    .digest('hex')

  if (!compareSignatures(expectedSignature, signature)) {
    return {
      ok: false,
      status: 401,
      error: 'La firma del bridge Atlas no coincide.',
    }
  }

  return { ok: true, mode: 'hmac' }
}

export function parseAtlasLeadBridgePayload(payload: unknown): AtlasBridgePayloadParseResult {
  if (!isRecord(payload)) {
    return { ok: false, status: 400, error: 'Payload inválido.' }
  }

  const source = readString(payload.source)
  if (source !== 'atlas_lead_engine') {
    return { ok: false, status: 400, error: 'La fuente del payload Atlas es inválida.' }
  }

  const typedPayload = payload as AtlasLeadBridgePayload
  const eventType = readString(typedPayload.eventType)
  if (!eventType || !ATLAS_ALLOWED_EVENT_TYPES.has(eventType)) {
    return { ok: false, status: 400, error: 'eventType es inválido.' }
  }

  if (!ATLAS_SUPPORTED_EVENT_TYPES.has(eventType)) {
    return { ok: true, ignored: true, reason: `Evento Atlas ignorado: ${eventType}.` }
  }

  const campaignType = readString(typedPayload.campaign?.sourceCampaignType)
  if (campaignType && campaignType !== 'dicom_equifax') {
    return {
      ok: true,
      ignored: true,
      reason: `Campaña Atlas ignorada por tipo ${campaignType}.`,
    }
  }

  const normalizedEventType = ['bounce', 'failed', 'delivery_failed', 'undeliverable'].includes(eventType)
    ? 'bounced'
    : eventType as 'opened' | 'clicked' | 'bounced'

  const eventAt =
    normalizeIsoDatetime(typedPayload.eventAt) ??
    normalizeIsoDatetime(
      normalizedEventType === 'opened'
        ? typedPayload.outreach?.openedAt
        : normalizedEventType === 'clicked'
          ? typedPayload.outreach?.clickedAt
          : typedPayload.outreach?.sentAt
    )

  if (!eventAt) {
    return { ok: false, status: 400, error: 'eventAt es inválido.' }
  }

  const messageId = readString(typedPayload.outreach?.messageId)
  const requestId = readString(typedPayload.context?.requestId)
  const companyName = readString(typedPayload.lead?.companyName)
  const contactEmail = readString(typedPayload.lead?.email)
  const contactPhone = readString(typedPayload.lead?.phone)
  const country = readString(typedPayload.lead?.country)
  const website = readString(typedPayload.lead?.website)
  const locale = readString(typedPayload.context?.locale)
  const subject = readString(typedPayload.outreach?.subject)
  const messageType = readString(typedPayload.outreach?.messageType)
  const sentAt = normalizeIsoDatetime(typedPayload.outreach?.sentAt)
  const openedAt =
    normalizeIsoDatetime(typedPayload.outreach?.openedAt) ??
    (normalizedEventType === 'opened' || normalizedEventType === 'clicked' ? eventAt : null)
  const clickedAt =
    normalizeIsoDatetime(typedPayload.outreach?.clickedAt) ??
    (normalizedEventType === 'clicked' ? eventAt : null)
  const rutid = extractLeadRutid(typedPayload)
  const externalEventId = requestId ?? `${messageId ?? 'unknown'}:${eventType}:${eventAt}`

  const record: ContactCenterFeedbackInput = {
    external_source: 'atlas_lead_engine',
    external_event_id: externalEventId,
    external_record_type: 'outreach_message',
    rutid,
    matched_rutid: rutid,
    match_method: rutid ? 'lead_metadata_rutdv' : null,
    contact_phone: contactPhone,
    contact_email: contactEmail,
    channel: 'email',
    managed_at: eventAt,
    outcome: normalizedEventType,
    outcome_subtype: normalizedEventType === 'bounced' ? 'email_bounce' : messageType,
    outcome_reason: normalizedEventType === 'bounced' ? 'Atlas Lead email bounced' : null,
    direction: 'outbound',
    agent_id: null,
    agent_name: 'Atlas Lead Engine',
    campaign_id: readString(typedPayload.campaign?.sourceCampaignId),
    campaign_name: readString(typedPayload.campaign?.sourceCampaignName) ?? 'Equifax',
    opened_at: openedAt,
    clicked_at: clickedAt,
    responded_at: null,
    callback_at: null,
    sold_at: null,
    value_amount: null,
    mail_opened: normalizedEventType === 'opened' || normalizedEventType === 'clicked',
    clicked: normalizedEventType === 'clicked',
    callback_requested: false,
    interested: false,
    contacted: false,
    effective_contact: false,
    sale: false,
    is_best_management: false,
    raw_payload: payload,
    metadata: {
      source_view: 'atlas_lead_engine_bridge_v1',
      source_updated_at: eventAt,
      source_campaign_type: campaignType,
      outreach_message_id: messageId,
      outreach_id: readString(typedPayload.outreach?.outreachId),
      atlas_lead_id: readString(typedPayload.outreach?.leadId),
      sent_at: sentAt,
      subject,
      message_type: messageType,
      company_name: companyName,
      country,
      website,
      locale,
    },
  }

  return {
    ok: true,
    ignored: false,
    eventType: normalizedEventType,
    eventAt,
    campaignType,
    record,
  }
}

function isEngagementV1Payload(payload: unknown): payload is AtlasEngagementV1Payload {
  if (!isRecord(payload)) return false
  return payload.event_type === 'engagement.v1' || payload.event_name === 'engagement.v1'
}

function normalizeOperationOutcome(value: unknown): FeedbackOutcome {
  const normalized = readString(value)?.toLowerCase().replace(/[\s-]+/g, '_')
  if (!normalized) return 'unknown'
  if (['contacted', 'answered', 'contactado', 'contacto'].includes(normalized)) return 'contacted'
  if (['no_contact', 'no_answer', 'unanswered', 'busy', 'voicemail', 'sin_contacto'].includes(normalized)) return 'no_contact'
  if (['interested', 'interesado', 'qualified'].includes(normalized)) return 'interested'
  if (['callback', 'callback_requested', 'scheduled', 'agendado'].includes(normalized)) return 'callback'
  if (['rejected', 'not_interested', 'rechazado'].includes(normalized)) return 'rejected'
  if (['sale', 'sold', 'converted', 'venta'].includes(normalized)) return 'sale'
  if (['do_not_contact', 'do_not_call', 'opt_out', 'blacklist'].includes(normalized)) return 'do_not_contact'
  return 'unknown'
}

function operationFeedbackV1ToRecord(item: unknown):
  | { ok: true; eventId: string; record: ContactCenterFeedbackInput }
  | { ok: false; status: number; error: string } {
  if (!isRecord(item)) return { ok: false, status: 400, error: 'operation.feedback.v1 requiere items válidos.' }
  const typedItem = item as AtlasOperationFeedbackV1Item
  const eventId = readString(typedItem.event_id)
  const occurredAt = normalizeIsoDatetime(typedItem.occurred_at)
  const payload = isRecord(typedItem.payload) ? typedItem.payload as AtlasOperationFeedbackV1Item['payload'] : null
  const campaignKey = readString(payload?.campaign_key)
  const externalKey = normalizeRutCandidate(payload?.external_key)
  const endedAt = payload?.ended_at == null ? null : normalizeIsoDatetime(payload.ended_at)
  const nextActionAt = payload?.next_action_at == null ? null : normalizeIsoDatetime(payload.next_action_at)
  const durationSeconds = payload?.duration_seconds == null ? null : Number(payload.duration_seconds)

  if (typedItem.event_type !== 'operation.feedback.v1') {
    return { ok: false, status: 400, error: 'event_type debe ser operation.feedback.v1.' }
  }
  if (!eventId) return { ok: false, status: 400, error: 'operation.feedback.v1 requiere event_id estable.' }
  if (!occurredAt) return { ok: false, status: 400, error: 'operation.feedback.v1 requiere occurred_at válido.' }
  if (!campaignKey) return { ok: false, status: 400, error: 'operation.feedback.v1 requiere payload.campaign_key.' }
  if (!externalKey) return { ok: false, status: 400, error: 'operation.feedback.v1 requiere payload.external_key como RUT válido.' }
  if (payload?.ended_at != null && !endedAt) {
    return { ok: false, status: 400, error: 'payload.ended_at es inválido.' }
  }
  if (payload?.next_action_at != null && !nextActionAt) {
    return { ok: false, status: 400, error: 'payload.next_action_at es inválido.' }
  }
  if (durationSeconds !== null && (!Number.isInteger(durationSeconds) || durationSeconds < 0)) {
    return { ok: false, status: 400, error: 'payload.duration_seconds debe ser un entero no negativo.' }
  }

  const outcome = normalizeOperationOutcome(payload?.outcome ?? payload?.status)
  const managedAt = endedAt ?? occurredAt
  return {
    ok: true,
    eventId,
    record: {
      external_source: 'atlas2_operation_feedback',
      external_event_id: eventId,
      external_record_type: 'operation.feedback.v1',
      rutid: externalKey,
      matched_rutid: externalKey,
      match_method: 'atlas2_external_key',
      channel: 'phone',
      managed_at: managedAt,
      outcome,
      outcome_subtype: readString(payload?.status),
      outcome_reason: readString(payload?.reason),
      direction: 'outbound',
      duration_seconds: durationSeconds,
      agent_name: 'Atlas 2.0',
      campaign_id: null,
      campaign_name: campaignKey,
      callback_at: nextActionAt,
      callback_requested: Boolean(nextActionAt) || outcome === 'callback',
      interested: outcome === 'interested',
      contacted: ['contacted', 'interested', 'callback', 'sale'].includes(outcome),
      effective_contact: ['contacted', 'interested', 'callback', 'sale'].includes(outcome),
      sale: outcome === 'sale',
      raw_payload: item,
      metadata: {
        source_view: 'atlas2_operation_feedback_v1',
        source_updated_at: occurredAt,
        campaign_key: campaignKey,
        atlas2_status: readString(payload?.status),
        next_action_at: nextActionAt,
      },
    },
  }
}

function engagementV1ToLegacy(payload: AtlasEngagementV1Payload):
  | { ok: true; payload: AtlasLeadBridgePayload; eventId: string }
  | { ok: false; status: number; error: string } {
  const eventId = readString(payload.event_id)
  const eventAt = normalizeIsoDatetime(payload.occurred_at)
  const engagement = isRecord(payload.engagement) ? payload.engagement as AtlasEngagementV1Payload['engagement'] : null
  const eventType = readString(engagement?.kind) ?? readString(engagement?.type)
  const sourceSystem = typeof payload.source === 'string'
    ? readString(payload.source)
    : readString(payload.source?.system)

  if (payload.schema_version !== '1.0') {
    return { ok: false, status: 400, error: 'engagement.v1 requiere schema_version 1.0.' }
  }
  if (!eventId) return { ok: false, status: 400, error: 'engagement.v1 requiere event_id estable.' }
  if (!eventAt) return { ok: false, status: 400, error: 'engagement.v1 requiere occurred_at válido.' }
  if (!sourceSystem) return { ok: false, status: 400, error: 'engagement.v1 requiere source.system.' }
  if (!eventType) return { ok: false, status: 400, error: 'engagement.v1 requiere engagement.kind.' }
  if (engagement?.channel && engagement.channel !== 'email') {
    return { ok: false, status: 400, error: 'engagement.v1 solo admite channel=email en este bridge.' }
  }

  return {
    ok: true,
    eventId,
    payload: {
      source: 'atlas_lead_engine',
      eventType,
      eventAt,
      campaign: engagement?.campaign ?? null,
      outreach: engagement?.outreach ?? null,
      lead: engagement?.lead ?? null,
      context: {
        ...(engagement?.context ?? {}),
        requestId: eventId,
      },
    },
  }
}

export type AtlasBridgeEnvelopeParseResult =
  | {
      ok: true
      records: ContactCenterFeedbackInput[]
      acceptedEventIds: string[]
      ignored: Array<{ event_id: string; reason: string }>
      contract: 'legacy' | 'engagement.v1' | 'operation.feedback.v1'
    }
  | { ok: false; status: number; error: string }

export function parseAtlasLeadBridgeEnvelope(payload: unknown): AtlasBridgeEnvelopeParseResult {
  if (isRecord(payload) && Array.isArray(payload.items)) {
    if (payload.schema_version !== '1') {
      return { ok: false, status: 400, error: 'operation.feedback.v1 requiere schema_version 1.' }
    }
    if (payload.items.length === 0) return { ok: false, status: 400, error: 'El lote no contiene items.' }
    if (payload.items.length > 250) return { ok: false, status: 413, error: 'El lote excede 250 items.' }

    const records: ContactCenterFeedbackInput[] = []
    const acceptedEventIds: string[] = []
    const seenEventIds = new Set<string>()
    for (const item of payload.items) {
      const parsed = operationFeedbackV1ToRecord(item)
      if (!parsed.ok) return parsed
      if (seenEventIds.has(parsed.eventId)) {
        return { ok: false, status: 400, error: `event_id duplicado en el lote: ${parsed.eventId}.` }
      }
      seenEventIds.add(parsed.eventId)
      records.push(parsed.record)
      acceptedEventIds.push(parsed.eventId)
    }
    return { ok: true, records, acceptedEventIds, ignored: [], contract: 'operation.feedback.v1' }
  }

  const isEnvelope = isRecord(payload) && Array.isArray(payload.events)
  const events: unknown[] = isEnvelope ? payload.events as unknown[] : [payload]
  if (events.length === 0) return { ok: false, status: 400, error: 'El lote no contiene eventos.' }
  if (events.length > 250) return { ok: false, status: 413, error: 'El lote excede 250 eventos.' }

  const records: ContactCenterFeedbackInput[] = []
  const acceptedEventIds: string[] = []
  const ignored: Array<{ event_id: string; reason: string }> = []
  let contract: 'legacy' | 'engagement.v1' = 'legacy'
  const seenEventIds = new Set<string>()

  for (const event of events) {
    let candidate: unknown = event
    let explicitEventId: string | null = null

    if (isEngagementV1Payload(event)) {
      contract = 'engagement.v1'
      const converted = engagementV1ToLegacy(event)
      if (!converted.ok) return converted
      candidate = converted.payload
      explicitEventId = converted.eventId
    } else if (isEnvelope) {
      return { ok: false, status: 400, error: 'Los lotes solo admiten eventos engagement.v1.' }
    }

    const parsed = parseAtlasLeadBridgePayload(candidate)
    if (!parsed.ok) return parsed

    const eventId = explicitEventId ?? (parsed.ignored ? null : parsed.record.external_event_id)
    if (parsed.ignored) {
      if (eventId) {
        if (seenEventIds.has(eventId)) return { ok: false, status: 400, error: `event_id duplicado en el lote: ${eventId}.` }
        seenEventIds.add(eventId)
        acceptedEventIds.push(eventId)
        ignored.push({ event_id: eventId, reason: parsed.reason })
      }
      continue
    }

    const parsedEventId = readString(parsed.record.external_event_id)
    if (!parsedEventId) return { ok: false, status: 400, error: 'El evento no produjo external_event_id.' }
    if (seenEventIds.has(parsedEventId)) {
      return { ok: false, status: 400, error: `event_id duplicado en el lote: ${parsedEventId}.` }
    }
    seenEventIds.add(parsedEventId)
    records.push(parsed.record)
    acceptedEventIds.push(parsedEventId)
  }

  return { ok: true, records, acceptedEventIds, ignored, contract }
}
