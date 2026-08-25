import assert from 'node:assert/strict'
import test from 'node:test'
import {
  authorizeAtlasLeadBridgeRequest,
  parseAtlasLeadBridgeEnvelope,
  parseAtlasLeadBridgePayload,
} from './atlas-lead-bridge'

const legacy = {
  source: 'atlas_lead_engine',
  eventType: 'opened',
  eventAt: '2026-08-25T12:00:00Z',
  outreach: { messageId: 'message-1' },
  lead: { companyName: 'Empresa Uno', email: 'uno@example.com' },
  context: { requestId: 'legacy-event-1' },
}

const engagement = {
  schema_version: '1.0',
  event_type: 'engagement.v1',
  event_id: 'engagement-event-1',
  occurred_at: '2026-08-25T12:00:00Z',
  source: { system: 'atlas2' },
  engagement: {
    kind: 'clicked',
    channel: 'email',
    campaign: { sourceCampaignId: 'campaign-1', sourceCampaignName: 'Equifax', sourceCampaignType: 'dicom_equifax' },
    outreach: { messageId: 'message-1', clickedAt: '2026-08-25T12:00:00Z' },
    lead: { companyName: 'Empresa Uno', email: 'uno@example.com' },
  },
}

const operationFeedback = {
  schema_version: '1',
  items: [{
    event_id: 'operation-event-1',
    event_type: 'operation.feedback.v1',
    occurred_at: '2026-08-25T12:00:00Z',
    payload: {
      campaign_key: 'Equifax agosto',
      external_key: '76.123.456-7',
      ended_at: '2026-08-25T12:05:00Z',
      duration_seconds: 300,
      status: 'completed',
      outcome: 'interested',
      reason: 'Solicita propuesta',
      next_action_at: '2026-08-26T15:00:00Z',
    },
  }],
}

test('el payload legacy conserva su parser', () => {
  const parsed = parseAtlasLeadBridgePayload(legacy)
  assert.equal(parsed.ok, true)
  if (parsed.ok && !parsed.ignored) assert.equal(parsed.record.external_event_id, 'legacy-event-1')
})

test('engagement.v1 acepta lote y conserva event_id idempotente', () => {
  const parsed = parseAtlasLeadBridgeEnvelope({ schema_version: '1.0', events: [engagement] })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.contract, 'engagement.v1')
  assert.deepEqual(parsed.acceptedEventIds, ['engagement-event-1'])
  assert.equal(parsed.records[0]?.external_event_id, 'engagement-event-1')
  assert.equal(parsed.records[0]?.outcome, 'clicked')
})

test('engagement.v1 rechaza event_id ausente y lotes mayores a 250', () => {
  const withoutId = structuredClone(engagement) as Record<string, unknown>
  delete withoutId.event_id
  assert.equal(parseAtlasLeadBridgeEnvelope(withoutId).ok, false)
  assert.equal(parseAtlasLeadBridgeEnvelope({ events: Array.from({ length: 251 }, () => engagement) }).ok, false)
})

test('operation.feedback.v1 ingresa con RUT, campaña e idempotencia por event_id', () => {
  const parsed = parseAtlasLeadBridgeEnvelope(operationFeedback)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.contract, 'operation.feedback.v1')
  assert.deepEqual(parsed.acceptedEventIds, ['operation-event-1'])
  assert.equal(parsed.records[0]?.external_source, 'atlas2_operation_feedback')
  assert.equal(parsed.records[0]?.matched_rutid, '0761234567')
  assert.equal(parsed.records[0]?.campaign_name, 'Equifax agosto')
  assert.equal(parsed.records[0]?.outcome, 'interested')
  assert.equal(parsed.records[0]?.callback_at, '2026-08-26T15:00:00.000Z')
})

test('operation.feedback.v1 rechaza mapeo incompleto y event_id repetido', () => {
  const missingCampaign = structuredClone(operationFeedback)
  delete (missingCampaign.items[0].payload as { campaign_key?: string }).campaign_key
  assert.equal(parseAtlasLeadBridgeEnvelope(missingCampaign).ok, false)
  assert.equal(parseAtlasLeadBridgeEnvelope({
    schema_version: '1',
    items: [operationFeedback.items[0], operationFeedback.items[0]],
  }).ok, false)
})

test('la firma HMAC entrante acepta timestamp UNIX sin retirar timestamp ISO legacy', async () => {
  const previousSecret = process.env.ATLAS2_FEEDBACK_BRIDGE_SECRET
  const previousLegacySecret = process.env.ATLAS_LEAD_BRIDGE_SECRET
  process.env.ATLAS2_FEEDBACK_BRIDGE_SECRET = 'test-secret'
  process.env.ATLAS_LEAD_BRIDGE_SECRET = 'legacy-secret'
  const rawBody = JSON.stringify(operationFeedback)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const { createHmac } = await import('node:crypto')
  const signature = createHmac('sha256', 'test-secret').update(`${timestamp}.${rawBody}`).digest('hex')
  assert.equal(authorizeAtlasLeadBridgeRequest({ rawBody, source: 'atlas2', timestamp, signature }).ok, true)
  assert.equal(authorizeAtlasLeadBridgeRequest({
    rawBody,
    source: 'atlas2',
    apiKey: 'test-secret',
  }).ok, false)
  const legacyTimestamp = new Date().toISOString()
  const legacySignature = createHmac('sha256', 'legacy-secret').update(`${legacyTimestamp}.${rawBody}`).digest('hex')
  assert.equal(authorizeAtlasLeadBridgeRequest({
    rawBody,
    timestamp: legacyTimestamp,
    signature: legacySignature,
  }).ok, true)
  assert.equal(authorizeAtlasLeadBridgeRequest({
    rawBody,
    source: 'atlas2',
    timestamp: legacyTimestamp,
    signature: createHmac('sha256', 'test-secret').update(`${legacyTimestamp}.${rawBody}`).digest('hex'),
  }).ok, false)
  if (previousSecret === undefined) delete process.env.ATLAS2_FEEDBACK_BRIDGE_SECRET
  else process.env.ATLAS2_FEEDBACK_BRIDGE_SECRET = previousSecret
  if (previousLegacySecret === undefined) delete process.env.ATLAS_LEAD_BRIDGE_SECRET
  else process.env.ATLAS_LEAD_BRIDGE_SECRET = previousLegacySecret
})
