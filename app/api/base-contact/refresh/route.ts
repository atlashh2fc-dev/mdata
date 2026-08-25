import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { NextRequest, NextResponse } from 'next/server'
import { Client } from 'pg'
import { runGuardedHeavyJob } from '@/lib/services/heavy-job-guard.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const execFileAsync = promisify(execFile)
const SYNC_MAX_BUFFER = 1024 * 1024 * 4
const ROUTE_BUDGET_MS = 270000
const PRIMARY_SYNC_TIMEOUT_MS = 90000
const FALLBACK_SYNC_TIMEOUT_MS = 45000
const ROUTE_CLOSE_RESERVE_MS = 15000

let refreshPromise: ReturnType<typeof refreshBaseContact> | null = null

function hasOpsSecret(req: NextRequest) {
  const expected =
    process.env.BASE_CONTACT_CRON_SECRET ||
    process.env.CRON_SECRET ||
    process.env.CRM_FEEDBACK_INGEST_TOKEN

  if (!expected) return false

  const candidate =
    req.headers.get('x-base-contact-secret') ??
    req.headers.get('x-api-key') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')

  return Boolean(candidate && candidate === expected)
}

function parseLastJsonObject(value: string) {
  const matches = value.match(/\{[\s\S]*?\}(?=\s*$|\s*\n)/g)
  if (!matches?.length) return null

  for (let index = matches.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(matches[index])
    } catch {
      // Continue scanning older JSON blocks.
    }
  }

  return null
}

function getPostgresConnectionString() {
  const raw =
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.POSTGRES_URL ??
    process.env.DATABASE_URL ??
    process.env.SUPABASE_DB_URL

  if (!raw) {
    throw new Error('Falta POSTGRES_URL_NON_POOLING/POSTGRES_URL/DATABASE_URL para refrescar Base Contact.')
  }

  const url = new URL(raw)
  url.searchParams.delete('sslmode')
  return url.toString()
}

function remainingStatementBudget(startedAt: number, maximumMs: number) {
  const remaining = ROUTE_BUDGET_MS - (Date.now() - startedAt) - ROUTE_CLOSE_RESERVE_MS
  if (remaining < 5000) {
    throw new Error('Pipeline Base Contact cancelado antes del límite real del worker.')
  }
  return Math.max(1000, Math.min(maximumMs, remaining))
}

async function setStatementBudget(client: Client, startedAt: number, maximumMs: number) {
  const timeoutMs = remainingStatementBudget(startedAt, maximumMs)
  await client.query("select set_config('statement_timeout', $1, false)", [`${timeoutMs}ms`])
}

async function refreshBaseContact() {
  const startedAt = Date.now()
  const client = new Client({
    connectionString: getPostgresConnectionString(),
    ssl: { rejectUnauthorized: false },
  })

  await client.connect()
  try {
    return await runGuardedHeavyJob(
      client,
      'base_contact_pipeline',
      {
        forceOutsideWindow: false,
        telemetryResult: (value: {
          sync: { stdout?: string; stderr?: string }
          dataset: unknown
          empresas_master_crm: unknown
          elapsed_ms: number
        }) => ({
          dataset: value.dataset,
          empresas_master_crm: value.empresas_master_crm,
          elapsed_ms: value.elapsed_ms,
          sync_stdout_bytes: Buffer.byteLength(value.sync.stdout ?? ''),
          sync_stderr_bytes: Buffer.byteLength(value.sync.stderr ?? ''),
        }),
      },
      async ({ assertMayContinue }: { assertMayContinue: () => Promise<void> }) => {
        const syncEnv = {
          ...process.env,
          // El fallback directo no debe disparar otro refresh pesado dentro del
          // mismo pipeline; el refresh protegido ocurre una sola vez más abajo.
          REGISTRO_INTEL_SKIP_DERIVED_REFRESH: 'true',
        }
        const sync = await execFileAsync(
          'npm',
          ['run', 'ops:sync:crm-feedback'],
          {
            cwd: process.cwd(),
            env: syncEnv,
            maxBuffer: SYNC_MAX_BUFFER,
            timeout: PRIMARY_SYNC_TIMEOUT_MS,
          }
        ).catch(async error => {
          const message = error instanceof Error ? error.message : String(error)
          const stderr =
            typeof error === 'object' && error && 'stderr' in error
              ? String((error as { stderr?: unknown }).stderr ?? '')
              : ''
          const detail = `${message}\n${stderr}`

          if (!/statement timeout|canceling statement due to statement timeout|57014/i.test(detail)) {
            throw error
          }

          return execFileAsync(
            'npm',
            ['run', 'ops:sync:crm-feedback:direct'],
            {
              cwd: process.cwd(),
              env: syncEnv,
              maxBuffer: SYNC_MAX_BUFFER,
              timeout: FALLBACK_SYNC_TIMEOUT_MS,
            }
          )
        })

        await assertMayContinue()
        await setStatementBudget(client, startedAt, 135000)
        const { rows: datasetRows } = await client.query(
          'select public.refresh_base_contact_dataset() as result'
        )

        await assertMayContinue()
        await setStatementBudget(client, startedAt, 60000)
        const { rows: crmRows } = await client.query(
          'select public.refresh_empresas_master_crm() as result'
        )

        return {
          sync,
          dataset: datasetRows[0]?.result ?? null,
          empresas_master_crm: crmRows[0]?.result ?? null,
          elapsed_ms: Date.now() - startedAt,
        }
      }
    )
  } finally {
    await client.end()
  }
}

export async function GET(req: NextRequest) {
  if (!hasOpsSecret(req)) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  try {
    if (!refreshPromise) {
      refreshPromise = refreshBaseContact().finally(() => {
        refreshPromise = null
      })
    }

    const result = await refreshPromise
    if (result.skipped) {
      return NextResponse.json(
        {
          success: true,
          data: { skipped: true, reason: result.reason },
        },
        { status: 202 }
      )
    }

    const pipeline = result.result
    return NextResponse.json({
      success: true,
      data: {
        dataset: pipeline.dataset,
        empresas_master_crm: pipeline.empresas_master_crm,
        crm_sync: parseLastJsonObject(pipeline.sync.stdout),
        stderr: pipeline.sync.stderr?.trim() || null,
        elapsed_ms: pipeline.elapsed_ms,
      },
    })
  } catch (error) {
    console.error('[base-contact/refresh:get]', error)
    const message = error instanceof Error ? error.message : 'No se pudo refrescar Base Contact.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
