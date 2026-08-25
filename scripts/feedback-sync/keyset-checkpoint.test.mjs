import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPostgrestKeysetFilter,
  buildScanStart,
  compareCheckpoints,
  maxCheckpoint,
  normalizeCheckpoint,
} from './keyset-checkpoint.mjs'

test('el lookback no modifica el checkpoint persistido', () => {
  const checkpoint = normalizeCheckpoint('2026-08-25T12:00:00Z', 'b')
  const scan = buildScanStart(checkpoint, 10)
  assert.equal(checkpoint.timestamp, '2026-08-25T12:00:00.000Z')
  assert.equal(checkpoint.id, 'b')
  assert.equal(scan.timestamp, '2026-08-25T11:50:00.000Z')
  assert.equal(scan.id, '')
})
test('el checkpoint compuesto nunca retrocede', () => {
  const current = normalizeCheckpoint('2026-08-25T12:00:00Z', 'b')
  const olderTimestamp = normalizeCheckpoint('2026-08-25T11:59:59Z', 'z')
  const lowerTieBreaker = normalizeCheckpoint('2026-08-25T12:00:00Z', 'a')
  const higherTieBreaker = normalizeCheckpoint('2026-08-25T12:00:00Z', 'c')

  assert.deepEqual(maxCheckpoint(current, olderTimestamp), current)
  assert.deepEqual(maxCheckpoint(current, lowerTieBreaker), current)
  assert.deepEqual(maxCheckpoint(current, higherTieBreaker), higherTieBreaker)
  assert.equal(compareCheckpoints(current, higherTieBreaker), -1)
})

test('el filtro keyset usa timestamp e id como desempate', () => {
  const filter = buildPostgrestKeysetFilter(
    'updated_at',
    'id',
    normalizeCheckpoint('2026-08-25T12:00:00Z', 'abc:123')
  )
  assert.equal(
    filter,
    'updated_at.gt."2026-08-25T12:00:00.000Z",and(updated_at.eq."2026-08-25T12:00:00.000Z",id.gt."abc:123")'
  )
})
