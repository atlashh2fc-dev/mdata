const TRUE_VALUES = new Set(['1', 'true', 'yes', 'si', 'sí'])

function envFlag(name) {
  return TRUE_VALUES.has(String(process.env[name] ?? '').trim().toLowerCase())
}

function asPositiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function compactError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 4000)
}

export function forceHeavyJobOutsideWindow(argv = process.argv.slice(2)) {
  return argv.includes('--force-outside-window') || envFlag('MDATA_HEAVY_FORCE_OUTSIDE_WINDOW')
}

export async function claimHeavyJob(client, jobName, options = {}) {
  if (!jobName) throw new Error('jobName es obligatorio para aislar una carga pesada.')

  if (envFlag('MDATA_HEAVY_JOBS_DISABLED')) {
    return { acquired: false, reason: 'environment_kill_switch' }
  }

  const forceOutsideWindow = options.forceOutsideWindow === true
  const { rows } = await client.query(
    'select mdata_ops.claim_heavy_job($1, $2) as claim',
    [jobName, forceOutsideWindow]
  )
  const claim = rows[0]?.claim

  if (!claim || typeof claim !== 'object') {
    throw new Error(`El guard de ${jobName} no devolvió una respuesta válida.`)
  }

  if (!claim.acquired) return claim

  const statementTimeoutMs = Math.min(
    asPositiveInteger(claim.statement_timeout_ms, 540000),
    600000
  )
  const lockTimeoutMs = Math.min(asPositiveInteger(claim.lock_timeout_ms, 5000), 30000)

  await client.query("select set_config('statement_timeout', $1, false)", [`${statementTimeoutMs}ms`])
  await client.query("select set_config('lock_timeout', $1, false)", [`${lockTimeoutMs}ms`])
  await client.query("select set_config('idle_in_transaction_session_timeout', '60s', false)")

  return {
    ...claim,
    statement_timeout_ms: statementTimeoutMs,
    lock_timeout_ms: lockTimeoutMs,
  }
}

export async function isHeavyJobStopRequested(client, jobName) {
  if (envFlag('MDATA_HEAVY_JOBS_DISABLED')) return true

  const { rows } = await client.query(
    'select mdata_ops.is_heavy_job_stop_requested($1) as stop_requested',
    [jobName]
  )
  return rows[0]?.stop_requested !== false
}

export async function assertHeavyJobMayContinue(client, jobName) {
  if (await isHeavyJobStopRequested(client, jobName)) {
    throw new Error(`Kill switch activo para ${jobName}.`)
  }
}

export async function finishHeavyJob(client, claim, status, result = null, error = null) {
  if (!claim?.acquired || !claim.run_id) return

  await client.query(
    'select mdata_ops.finish_heavy_job($1::uuid, $2, $3::jsonb, $4)',
    [
      claim.run_id,
      status,
      result == null ? null : JSON.stringify(result),
      error == null ? null : compactError(error),
    ]
  )
}

export async function runGuardedHeavyJob(client, jobName, options, work) {
  const claim = await claimHeavyJob(client, jobName, options)
  if (!claim.acquired) {
    return { skipped: true, reason: claim.reason ?? 'not_acquired', claim }
  }

  try {
    const result = await work({
      claim,
      assertMayContinue: () => assertHeavyJobMayContinue(client, jobName),
    })
    const telemetryResult = typeof options?.telemetryResult === 'function'
      ? options.telemetryResult(result)
      : result
    await finishHeavyJob(client, claim, 'succeeded', telemetryResult)
    return { skipped: false, result, claim }
  } catch (error) {
    try {
      await finishHeavyJob(client, claim, 'failed', null, error)
    } catch (finishError) {
      const suffix = compactError(finishError)
      if (error instanceof Error) error.message = `${error.message} (falló cierre de telemetría: ${suffix})`
    }
    throw error
  }
}
