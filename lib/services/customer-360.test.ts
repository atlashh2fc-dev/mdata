import assert from 'node:assert/strict'
import test from 'node:test'
import { isCronSecretValid } from './cron-auth'
import { boundedCustomer360Env } from './customer-360'

test('los micro-batches Customer 360 siempre quedan acotados', () => {
  const previous = process.env.CUSTOMER_360_EVENT_BATCH_SIZE
  process.env.CUSTOMER_360_EVENT_BATCH_SIZE = '999999'
  assert.equal(boundedCustomer360Env('CUSTOMER_360_EVENT_BATCH_SIZE', 1000, 5000), 5000)
  process.env.CUSTOMER_360_EVENT_BATCH_SIZE = '0'
  assert.equal(boundedCustomer360Env('CUSTOMER_360_EVENT_BATCH_SIZE', 1000, 5000), 1)
  process.env.CUSTOMER_360_EVENT_BATCH_SIZE = 'invalid'
  assert.equal(boundedCustomer360Env('CUSTOMER_360_EVENT_BATCH_SIZE', 1000, 5000), 1000)
  if (previous === undefined) delete process.env.CUSTOMER_360_EVENT_BATCH_SIZE
  else process.env.CUSTOMER_360_EVENT_BATCH_SIZE = previous
})

test('el cron Customer 360 exige CRON_SECRET exacto', () => {
  const previous = process.env.CRON_SECRET
  process.env.CRON_SECRET = 'customer-360-test-secret'
  assert.equal(isCronSecretValid('customer-360-test-secret'), true)
  assert.equal(isCronSecretValid('customer-360-test-secreu'), false)
  assert.equal(isCronSecretValid(null), false)
  if (previous === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = previous
})
