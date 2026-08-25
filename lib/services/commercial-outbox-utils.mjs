import { createHash, createHmac } from 'node:crypto'

export const MAX_BATCH_EVENTS = 250
export const MAX_BATCH_BYTES = 1024 * 1024

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function createDecisionEvent({ campaignKey, externalKey, decision, occurredAt }) {
  const decisionVersion = sha256(stableStringify({ campaignKey, externalKey, decision }))
  const eventId = `mdata:${decisionVersion}`
  const priorityScore = Number(decision.dynamic_priority_score ?? 0)
  const priorityRank = Math.max(1, Math.min(100, 101 - Math.round(priorityScore)))
  return {
    eventId,
    idempotencyKey: eventId,
    payload: {
      campaign_key: campaignKey,
      item: {
        event_id: eventId,
        event_type: 'intelligence.decision.v1',
        external_key: externalKey,
        occurred_at: occurredAt,
        payload: {
          priority_rank: priorityRank,
          priority_reason: decision.next_best_action ?? 'Prioridad calculada por mdata',
          decision_version: decisionVersion,
          dynamic_priority_score: priorityScore,
          contact_probability: Number(decision.contact_probability ?? 0),
          conversion_probability: Number(decision.conversion_probability ?? 0),
          fatigue_score: Number(decision.fatigue_score ?? 0),
          optimal_window: decision.optimal_window ?? null,
          recommended_channel: decision.recommended_channel ?? null,
          next_best_action: decision.next_best_action ?? null,
          reason_tags: Array.isArray(decision.reason_tags) ? decision.reason_tags : [],
          rutid: decision.rutid ?? null,
        },
      },
    },
  }
}

export function validateDecisionOutboxRow(row) {
  const campaignKey = row?.payload?.campaign_key
  const item = row?.payload?.item
  const priorityRank = item?.payload?.priority_rank
  return typeof campaignKey === 'string'
    && campaignKey.trim().length > 0
    && typeof item?.event_id === 'string'
    && item.event_id.trim().length > 0
    && item.event_type === 'intelligence.decision.v1'
    && typeof item.external_key === 'string'
    && item.external_key.trim().length > 0
    && typeof item.occurred_at === 'string'
    && Number.isFinite(Date.parse(item.occurred_at))
    && Number.isInteger(priorityRank)
    && priorityRank >= 1
    && priorityRank <= 100
}

function transportBody(rows) {
  return JSON.stringify({ campaign_key: rows[0]?.payload?.campaign_key, items: rows.map(row => row.payload.item) })
}

export function batchRowsForTransport(rows, options = {}) {
  const maxItems = Math.min(Math.max(Number(options.maxItems ?? MAX_BATCH_EVENTS), 1), MAX_BATCH_EVENTS)
  const maxBytes = Math.min(Math.max(Number(options.maxBytes ?? MAX_BATCH_BYTES), 1024), MAX_BATCH_BYTES)
  const batches = []
  const grouped = new Map()
  for (const row of rows) {
    const campaignKey = String(row?.payload?.campaign_key ?? '')
    const group = grouped.get(campaignKey) ?? []
    group.push(row)
    grouped.set(campaignKey, group)
  }
  for (const campaignRows of grouped.values()) {
    let current = []
    for (const row of campaignRows) {
      const candidate = [...current, row]
      if (candidate.length > maxItems || Buffer.byteLength(transportBody(candidate)) > maxBytes) {
        if (current.length === 0) {
          batches.push({ rows: [row], body: transportBody([row]), oversized: true })
          continue
        }
        batches.push({ rows: current, body: transportBody(current), oversized: false })
        current = [row]
        if (Buffer.byteLength(transportBody(current)) > maxBytes) {
          batches.push({ rows: current, body: transportBody(current), oversized: true })
          current = []
        }
        continue
      }
      current = candidate
    }
    if (current.length > 0) batches.push({ rows: current, body: transportBody(current), oversized: false })
  }
  return batches
}

export function signTransportBody(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

export function parseExplicitAck(payload, expectedEventIds) {
  const accepted = new Set(Array.isArray(payload?.accepted_event_ids)
    ? payload.accepted_event_ids.map(String)
    : Array.isArray(payload?.data?.accepted_event_ids) ? payload.data.accepted_event_ids.map(String) : [])
  const expected = new Set(expectedEventIds.map(String))
  const acknowledged = payload?.acknowledged === true || payload?.data?.acknowledged === true
  const acceptedExpected = [...expected].filter(id => accepted.has(id))
  const missing = [...expected].filter(id => !accepted.has(id))
  return { valid: acknowledged && acceptedExpected.length > 0, complete: acknowledged && missing.length === 0, accepted: acceptedExpected, missing }
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(3600, Math.ceil(seconds))
  const at = new Date(value).getTime()
  if (!Number.isFinite(at)) return null
  return Math.min(3600, Math.max(0, Math.ceil((at - now) / 1000)))
}

export function isRetryableStatus(status) {
  return (status >= 300 && status < 400) || status === 408 || status === 425 || status === 429 || status >= 500
}
