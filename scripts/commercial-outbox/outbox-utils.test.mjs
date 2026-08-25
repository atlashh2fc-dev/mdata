import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import {
  batchRowsForTransport,
  createDecisionEvent,
  isRetryableStatus,
  parseExplicitAck,
  signTransportBody,
  validateDecisionOutboxRow,
} from './outbox-utils.mjs'

function row(index, extra = {}) {
  return {
    id: `row-${index}`,
    payload: {
      campaign_key: 'campaign-one',
      item: {
        event_id: `event-${index}`,
        event_type: 'intelligence.decision.v1',
        external_key: `rut-${index}`,
        occurred_at: '2026-08-25T12:00:00Z',
        payload: { priority_rank: 10 },
      },
      ...extra,
    },
  }
}

test('el transporte nunca supera 250 eventos', () => {
  const batches = batchRowsForTransport(Array.from({ length: 251 }, (_, index) => row(index)))
  assert.equal(batches.length, 2)
  assert.equal(batches[0].rows.length, 250)
  assert.equal(batches[1].rows.length, 1)
  assert.ok(batches.every(batch => Buffer.byteLength(batch.body) <= 1024 * 1024))
})

test('el transporte agrupa por campaign_key y usa el contrato exacto de items', () => {
  const batches = batchRowsForTransport([
    row(1),
    row(2, { campaign_key: 'campaign-two' }),
  ])
  assert.equal(batches.length, 2)
  assert.deepEqual(JSON.parse(batches[0].body), {
    campaign_key: 'campaign-one',
    items: [row(1).payload.item],
  })
  assert.deepEqual(JSON.parse(batches[1].body), {
    campaign_key: 'campaign-two',
    items: [row(2).payload.item],
  })
})

test('el transporte divide por bytes antes de superar 1 MiB', () => {
  const batches = batchRowsForTransport([
    row(1, { item: { ...row(1).payload.item, payload: { value: 'a'.repeat(700_000) } } }),
    row(2, { item: { ...row(2).payload.item, payload: { value: 'b'.repeat(700_000) } } }),
  ])
  assert.equal(batches.length, 2)
  assert.ok(batches.every(batch => !batch.oversized))
  assert.ok(batches.every(batch => Buffer.byteLength(batch.body) <= 1024 * 1024))
})

test('la versión e idempotencia no dependen del orden de las claves', () => {
  const first = createDecisionEvent({
    campaignKey: 'campaign', externalKey: '1', occurredAt: '2026-08-25T12:00:00Z', decision: { a: 1, b: 2 },
  })
  const second = createDecisionEvent({
    campaignKey: 'campaign', externalKey: '1', occurredAt: '2026-08-25T13:00:00Z', decision: { b: 2, a: 1 },
  })
  assert.equal(first.idempotencyKey, second.idempotencyKey)
})

test('la firma HMAC cubre timestamp y body', () => {
  const expected = createHmac('sha256', 'secret').update('timestamp.body').digest('hex')
  assert.equal(signTransportBody('secret', 'timestamp', 'body'), expected)
})

test('el ACK debe enumerar explícitamente todos los event_id', () => {
  assert.deepEqual(
    parseExplicitAck({ acknowledged: true, accepted_event_ids: ['a'] }, ['a', 'b']),
    { valid: true, complete: false, accepted: ['a'], missing: ['b'] }
  )
  assert.equal(parseExplicitAck({ acknowledged: true }, ['a']).valid, false)
  assert.equal(parseExplicitAck({ accepted_event_ids: ['a'] }, ['a']).valid, false)
  assert.equal(parseExplicitAck({ acknowledged: true, accepted_event_ids: ['a'] }, ['a']).complete, true)
})

test('las filas mal mapeadas no llegan al transporte', () => {
  assert.equal(validateDecisionOutboxRow(row(1)), true)
  assert.equal(validateDecisionOutboxRow(row(2, { campaign_key: '' })), false)
  assert.equal(validateDecisionOutboxRow(row(3, {
    item: { ...row(3).payload.item, external_key: '' },
  })), false)
})

test('un redirect se reintenta y nunca se considera entrega', () => {
  assert.equal(isRetryableStatus(301), true)
  assert.equal(isRetryableStatus(307), true)
  assert.equal(isRetryableStatus(308), true)
  assert.equal(isRetryableStatus(400), false)
})
