import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { NextRequest, NextResponse } from 'next/server'
import { Client } from 'pg'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const execFileAsync = promisify(execFile)
const SYNC_MAX_BUFFER = 1024 * 1024 * 4

let refreshPromise: Promise<{
  sync: { stdout: string; stderr: string }
  dataset: unknown
}> | null = null

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

async function refreshBaseContactDataset() {
  const client = new Client({
    connectionString: getPostgresConnectionString(),
    ssl: { rejectUnauthorized: false },
  })

  await client.connect()
  try {
    await client.query('set statement_timeout = 0')
    const { rows } = await client.query('select public.refresh_base_contact_dataset() as result')
    return rows[0]?.result ?? null
  } finally {
    await client.end()
  }
}

async function refreshBaseContact() {
  const sync = await execFileAsync(
    'npm',
    ['run', 'ops:sync:crm-feedback'],
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: SYNC_MAX_BUFFER,
      timeout: 240000,
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
        env: process.env,
        maxBuffer: SYNC_MAX_BUFFER,
        timeout: 600000,
      }
    )
  })

  const dataset = await refreshBaseContactDataset()

  return { sync, dataset }
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
    return NextResponse.json({
      success: true,
      data: {
        dataset: result.dataset,
        crm_sync: parseLastJsonObject(result.sync.stdout),
        stderr: result.sync.stderr?.trim() || null,
      },
    })
  } catch (error) {
    console.error('[base-contact/refresh:get]', error)
    const message = error instanceof Error ? error.message : 'No se pudo refrescar Base Contact.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
