import assert from 'node:assert/strict'
import test from 'node:test'

import {
  claimHeavyJob,
  finishHeavyJob,
  runGuardedHeavyJob,
} from './heavy-job-guard.mjs'

function fakeClient(claim = { acquired: false, reason: 'outside_allowed_window' }) {
  const calls = []
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (sql.includes('claim_heavy_job')) return { rows: [{ claim }] }
      if (sql.includes('is_heavy_job_stop_requested')) return { rows: [{ stop_requested: false }] }
      return { rows: [] }
    },
  }
}

test('no ejecuta trabajo cuando el guard no adquiere la ventana', async () => {
  const client = fakeClient()
  let executed = false
  const result = await runGuardedHeavyJob(client, 'base_contact_pipeline', {}, async () => {
    executed = true
  })

  assert.equal(executed, false)
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'outside_allowed_window')
})

test('configura límites finitos al adquirir el lock', async () => {
  const client = fakeClient({
    acquired: true,
    run_id: '00000000-0000-0000-0000-000000000001',
    statement_timeout_ms: 9999999,
    lock_timeout_ms: 9999999,
  })

  const claim = await claimHeavyJob(client, 'equifax_bdd_rebuild')
  assert.equal(claim.statement_timeout_ms, 600000)
  assert.equal(claim.lock_timeout_ms, 30000)
  assert.match(client.calls[1].params[0], /^600000ms$/)
  assert.match(client.calls[2].params[0], /^30000ms$/)
})

test('cierra telemetría y libera lock con estado final', async () => {
  const client = fakeClient()
  await finishHeavyJob(
    client,
    { acquired: true, run_id: '00000000-0000-0000-0000-000000000001' },
    'succeeded',
    { rows: 12 }
  )

  assert.match(client.calls[0].sql, /finish_heavy_job/)
  assert.equal(client.calls[0].params[1], 'succeeded')
  assert.equal(client.calls[0].params[2], '{"rows":12}')
})

test('permite acotar la telemetría sin alterar el resultado operacional', async () => {
  const client = fakeClient({
    acquired: true,
    run_id: '00000000-0000-0000-0000-000000000001',
    statement_timeout_ms: 1000,
    lock_timeout_ms: 1000,
  })
  const result = await runGuardedHeavyJob(
    client,
    'base_contact_pipeline',
    { telemetryResult: value => ({ stdout_bytes: value.stdout.length }) },
    async () => ({ stdout: 'contenido-grande' })
  )

  assert.equal(result.result.stdout, 'contenido-grande')
  const finishCall = client.calls.find(call => call.sql.includes('finish_heavy_job'))
  assert.equal(finishCall.params[2], '{"stdout_bytes":16}')
})
