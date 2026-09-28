import { NextRequest, NextResponse } from 'next/server'
import { Client } from 'pg'
import { runGuardedHeavyJob } from '@/lib/services/heavy-job-guard.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const ROUTE_BUDGET_MS = 270000
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
          dataset: unknown
          empresas_master_crm: unknown
          elapsed_ms: number
        }) => ({
          dataset: value.dataset,
          empresas_master_crm: value.empresas_master_crm,
          elapsed_ms: value.elapsed_ms,
        }),
      },
      async ({ assertMayContinue }: { assertMayContinue: () => Promise<void> }) => {
        // El sync de feedback desde Atlas 1 (registro-intel) fue retirado:
        // el pipeline solo recalcula los datasets derivados locales.
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
        elapsed_ms: pipeline.elapsed_ms,
      },
    })
  } catch (error) {
    console.error('[base-contact/refresh:get]', error)
    const message = error instanceof Error ? error.message : 'No se pudo refrescar Base Contact.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
