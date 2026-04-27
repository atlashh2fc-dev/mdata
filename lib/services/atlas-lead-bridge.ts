import { createHmac, timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db/supabase'
import { normalizeCompanyName } from '@/lib/utils/company-match'
import { cleanRut } from '@/lib/utils/rut'
import type { ContactCenterFeedbackInput } from '@/types'

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

function getAtlasBridgeSecret(): string | null {
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
  const metadata = isRecord(record.metadata) ? record.metadata : {}
  const companyName =
    readMetadataString(metadata, 'company_name') ??
    readString((record.raw_payload?.lead as Record<string, unknown> | undefined)?.companyName)

  if (!companyName) return record

  const matchKey = normalizeCompanyName(companyName)
  if (!matchKey) return record

  const { data, error } = await db.rpc('match_company_names', {
    input_names: [companyName],
  })

  if (error) {
    console.warn('[resolveAtlasBridgeCompanyMatch]', error.message)
    return record
  }

  const matches = ((data ?? []) as CompanyNameMatchRow[])
    .filter(row => row.rutid && row.match_key === matchKey)
  const uniqueMatches = new Map(matches.map(row => [row.rutid as string, row]))

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
}

function compareSignatures(expected: string, candidate: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf8')
  const candidateBuffer = Buffer.from(candidate, 'utf8')
  if (expectedBuffer.length !== candidateBuffer.length) return false
  return timingSafeEqual(expectedBuffer, candidateBuffer)
}

export function authorizeAtlasLeadBridgeRequest(args: {
  rawBody: string
  apiKey?: string | null
  signature?: string | null
  timestamp?: string | null
}): AtlasBridgeAuthorization {
  const secret = getAtlasBridgeSecret()
  if (!secret) {
    return {
      ok: false,
      status: 503,
      error: 'ATLAS_LEAD_BRIDGE_SECRET no está configurado.',
    }
  }

  const apiKey = readString(args.apiKey)
  if (apiKey && compareSignatures(secret, apiKey)) {
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

  const parsedTimestamp = new Date(timestamp)
  if (Number.isNaN(parsedTimestamp.getTime())) {
    return {
      ok: false,
      status: 401,
      error: 'x-atlas-timestamp es inválido.',
    }
  }

  const ageMs = Math.abs(Date.now() - parsedTimestamp.getTime())
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
