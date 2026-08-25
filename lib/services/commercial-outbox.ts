import { timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db/supabase'
import { getCommercialActionFeed } from '@/lib/services/commercial-brain'
import type { CommercialActionFeed, LeadActionInstruction } from '@/types'
import {
  batchRowsForTransport,
  createDecisionEvent,
  isRetryableStatus,
  parseExplicitAck,
  parseRetryAfter,
  sha256,
  signTransportBody,
  validateDecisionOutboxRow,
} from './commercial-outbox-utils.mjs'

type OutboxRow = {
  id: string
  payload: {
    campaign_key?: string
    item?: {
      event_id?: string
      event_type?: string
      external_key?: string
      occurred_at?: string
      payload?: { priority_rank?: number }
    }
  }
}

type DeliverySummary = {
  claimed: number
  batches: number
  delivered: number
  retry: number
  dead: number
  circuit_or_queue_empty?: boolean
}

const MAX_CLAIM = 250

function normalizeRutid(value: unknown) {
  const compact = String(value ?? '').toUpperCase().replace(/[^0-9K]/g, '')
  if (compact.length < 2) return null
  return compact.padStart(10, '0')
}

function hasFinitePriority(lead: LeadActionInstruction) {
  const value = lead.dynamic_priority_score
  return value !== null
    && value !== undefined
    && String(value).trim() !== ''
    && Number.isFinite(Number(value))
}

async function rpc<T>(name: string, params: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(name, params)
  if (error) throw new Error(`${name}: ${error.message}`)
  return data as T
}

export async function enqueueCommercialDecisions(feed?: CommercialActionFeed) {
  const actionFeed = feed ?? await getCommercialActionFeed()
  const occurredAt = new Date(actionFeed.generated_at ?? Date.now()).toISOString()
  let enqueued = 0
  let unmappedDeadLetters = 0

  for (const lead of actionFeed.lead_instructions ?? []) {
    const campaignKey = typeof lead.campaign_name === 'string' && lead.campaign_name.trim()
      ? lead.campaign_name.trim()
      : null
    const externalKey = normalizeRutid(lead.rutid)
    const aggregateId = `${lead.campaign_name ?? 'unassigned'}:${lead.rutid ?? 'unknown'}`

    if (!campaignKey || !externalKey || !hasFinitePriority(lead)) {
      const decision = createDecisionEvent({
        campaignKey: campaignKey ?? 'unmapped',
        externalKey: externalKey ?? aggregateId,
        occurredAt,
        decision: lead,
      })
      const missing = [
        !campaignKey ? 'campaign_name/campaign_key ausente' : null,
        !externalKey ? 'rutid/external_key normalizable ausente' : null,
        !hasFinitePriority(lead) ? 'dynamic_priority_score ausente o inválido' : null,
      ].filter(Boolean).join('; ')
      await rpc('record_unmapped_intelligence_decision', {
        p_aggregate_id: aggregateId,
        p_idempotency_key: `unmapped:${decision.idempotencyKey}`,
        p_payload: { lead, occurred_at: occurredAt },
        p_error: missing,
      })
      unmappedDeadLetters += 1
      continue
    }

    const event = createDecisionEvent({ campaignKey, externalKey, occurredAt, decision: lead })
    await rpc('enqueue_intelligence_decision', {
      p_aggregate_type: 'lead',
      p_aggregate_id: externalKey,
      p_idempotency_key: event.idempotencyKey,
      p_payload: event.payload,
      p_destination: 'atlas2',
    })
    enqueued += 1
  }

  return {
    generated_at: actionFeed.generated_at,
    lead_decisions: actionFeed.lead_instructions?.length ?? 0,
    enqueued,
    unmapped_dead_letters: unmappedDeadLetters,
    portfolio_and_campaign_decisions_skipped: true,
  }
}

function destinationConfig() {
  const url = process.env.ATLAS2_INTELLIGENCE_URL
  const secret = process.env.ATLAS2_INTELLIGENCE_SECRET
  if (!url || !secret) throw new Error('Faltan ATLAS2_INTELLIGENCE_URL/ATLAS2_INTELLIGENCE_SECRET.')
  const parsed = new URL(url)
  if (parsed.pathname.replace(/\/$/, '') !== '/api/integrations/v2/batches' || parsed.search || parsed.hash) {
    throw new Error('ATLAS2_INTELLIGENCE_URL debe apuntar exactamente a /api/integrations/v2/batches.')
  }
  return { url, secret }
}

function workerName() {
  return process.env.COMMERCIAL_OUTBOX_WORKER ?? `mdata-outbox-${process.pid}-${Date.now()}`
}

function timeoutMs() {
  return Math.min(Math.max(Number(process.env.COMMERCIAL_OUTBOX_REQUEST_TIMEOUT_MS ?? 15000), 1000), 60000)
}

async function ack(rows: OutboxRow[], worker: string, responsePayload: unknown) {
  if (!rows.length) return 0
  return rpc<number>('ack_commercial_outbox', {
    p_ids: rows.map(row => row.id), p_worker: worker, p_ack_payload: responsePayload ?? {},
  })
}

async function nack(rows: OutboxRow[], worker: string, error: string, status: number | null = null, retryAfter: number | null = null) {
  if (!rows.length) return null
  return rpc('nack_commercial_outbox', {
    p_ids: rows.map(row => row.id), p_worker: worker, p_error: error.slice(0, 2000),
    p_http_status: status, p_retry_after_seconds: retryAfter,
  })
}

async function deadLetter(rows: OutboxRow[], worker: string, error: string, status: number | null = null) {
  if (!rows.length) return 0
  return rpc<number>('dead_letter_commercial_outbox', {
    p_ids: rows.map(row => row.id), p_worker: worker, p_error: error.slice(0, 2000), p_http_status: status,
  })
}

async function deliverBatch(batch: { rows: OutboxRow[]; body: string; oversized: boolean }, worker: string) {
  if (batch.oversized) {
    await deadLetter(batch.rows, worker, 'El evento excede 1 MiB al envolverlo en el contrato de transporte.')
    return { delivered: 0, dead: batch.rows.length, retry: 0, stop: false }
  }

  const { url, secret } = destinationConfig()
  const timestamp = String(Math.floor(Date.now() / 1000))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs())

  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'x-atlas-source': 'bigdata',
        'x-atlas-timestamp': timestamp,
        'x-atlas-signature': signTransportBody(secret, timestamp, batch.body),
        'idempotency-key': `mdata-batch:${sha256(batch.body)}`,
      },
      body: batch.body,
      signal: controller.signal,
    })
    const responseText = await response.text()
    let responsePayload: unknown = null
    try { responsePayload = responseText ? JSON.parse(responseText) : null } catch { responsePayload = { raw: responseText.slice(0, 2000) } }

    const rowsByEventId = new Map(batch.rows.map(row => [String(row.payload.item?.event_id), row]))
    const explicitAck = parseExplicitAck(responsePayload, [...rowsByEventId.keys()])
    if ((response.ok || response.status === 409) && explicitAck.valid) {
      const acceptedRows = explicitAck.accepted.map((id: string) => rowsByEventId.get(id)).filter(Boolean) as OutboxRow[]
      const missingRows = explicitAck.missing.map((id: string) => rowsByEventId.get(id)).filter(Boolean) as OutboxRow[]
      await ack(acceptedRows, worker, responsePayload)
      if (missingRows.length) await nack(missingRows, worker, 'ACK parcial: Atlas2 no confirmó todos los event_id.', response.status)
      return { delivered: acceptedRows.length, dead: 0, retry: missingRows.length, stop: missingRows.length > 0 }
    }

    const detail = `HTTP ${response.status}; ACK explícito ausente o inválido; ${responseText.slice(0, 1000)}`
    if (isRetryableStatus(response.status) || response.ok || response.status === 409) {
      await nack(batch.rows, worker, detail, response.status, parseRetryAfter(response.headers.get('retry-after')))
      return { delivered: 0, dead: 0, retry: batch.rows.length, stop: true }
    }
    await deadLetter(batch.rows, worker, detail, response.status)
    return { delivered: 0, dead: batch.rows.length, retry: 0, stop: false }
  } catch (error) {
    await nack(batch.rows, worker, error instanceof Error ? error.message : String(error))
    return { delivered: 0, dead: 0, retry: batch.rows.length, stop: true }
  } finally {
    clearTimeout(timeout)
  }
}

export async function drainCommercialOutbox(): Promise<DeliverySummary> {
  const worker = workerName()
  const claimed = await rpc<OutboxRow[]>('claim_commercial_outbox', {
    p_destination: 'atlas2', p_worker: worker, p_limit: MAX_CLAIM,
    p_lease_seconds: Math.ceil(timeoutMs() / 1000) + 30,
  })
  const rows = Array.isArray(claimed) ? claimed : []
  if (!rows.length) return { claimed: 0, batches: 0, delivered: 0, retry: 0, dead: 0, circuit_or_queue_empty: true }

  const malformedRows = rows.filter(row => !validateDecisionOutboxRow(row))
  const deliverableRows = rows.filter(row => validateDecisionOutboxRow(row))
  if (malformedRows.length) {
    await deadLetter(malformedRows, worker, 'Contrato intelligence.decision.v1 inválido: mapeo incompleto.')
  }
  const batches = batchRowsForTransport(deliverableRows) as Array<{ rows: OutboxRow[]; body: string; oversized: boolean }>
  const summary: DeliverySummary = {
    claimed: rows.length, batches: batches.length, delivered: 0, retry: 0, dead: malformedRows.length,
  }

  for (let index = 0; index < batches.length; index += 1) {
    const result = await deliverBatch(batches[index], worker)
    summary.delivered += result.delivered
    summary.retry += result.retry
    summary.dead += result.dead
    if (result.stop) {
      const remaining = batches.slice(index + 1).flatMap(batch => batch.rows)
      if (remaining.length) {
        await nack(remaining, worker, 'Entrega pospuesta por una falla transitoria previa.')
        summary.retry += remaining.length
      }
      break
    }
  }
  return summary
}

export async function runCommercialOutbox(options: { generate: boolean }) {
  const generation = options.generate ? await enqueueCommercialDecisions() : null
  const delivery = await drainCommercialOutbox()
  return { generation, delivery }
}

export function isCronSecretValid(candidate: string | null) {
  const expected = process.env.CRON_SECRET
  if (!candidate || !expected) return false
  const left = Buffer.from(candidate)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}
