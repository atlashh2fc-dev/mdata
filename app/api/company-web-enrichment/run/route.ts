import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 1024 * 1024 * 8

let runningPromise: Promise<unknown> | null = null

type WebEnrichmentAction = 'progress' | 'enqueue' | 'process' | 'run'

function hasOpsSecret(req: NextRequest) {
  const expected =
    process.env.COMPANY_WEB_ENRICHMENT_CRON_SECRET ||
    process.env.CRON_SECRET ||
    process.env.CRM_FEEDBACK_INGEST_TOKEN

  if (!expected) return false

  const candidate =
    req.headers.get('x-company-web-enrichment-secret') ??
    req.headers.get('x-api-key') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')

  return Boolean(candidate && candidate === expected)
}

async function requireAuthenticatedUser() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}

function parseFirstJsonObject(value: string) {
  const start = value.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaping = false

  for (let index = start; index < value.length; index += 1) {
    const char = value[index]

    if (escaping) {
      escaping = false
      continue
    }

    if (char === '\\') {
      escaping = inString
      continue
    }

    if (char === '"') {
      inString = !inString
      continue
    }

    if (inString) continue
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return JSON.parse(value.slice(start, index + 1))
      }
    }
  }

  return null
}

function positiveInt(value: unknown, fallback: number, max: number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(Math.floor(parsed), max)
}

function buildScriptArgs(action: WebEnrichmentAction, body: Record<string, unknown> = {}) {
  const args = ['--progress']
  const need = ['any', 'both', 'email', 'phone'].includes(String(body.need))
    ? String(body.need)
    : 'any'
  const limit = positiveInt(body.limit, action === 'run' ? 1000 : 5000, 20000)
  const batchSize = positiveInt(body.batch_size, action === 'run' ? 25 : 50, 200)

  if (action === 'enqueue' || action === 'run') {
    args.push('--enqueue', `--limit=${limit}`, `--need=${need}`)
  }

  if (action === 'process' || action === 'run') {
    args.push(
      '--process',
      `--batch-size=${batchSize}`,
      `--worker=${action}-${Date.now()}`
    )
  }

  if (body.retry_failed === true) args.push('--retry-failed')
  if (body.force_refresh === true) args.push('--force-refresh')
  if (body.dry_run === true) args.push('--dry-run')

  return args
}

async function runWorker(action: WebEnrichmentAction, body: Record<string, unknown> = {}) {
  const args = buildScriptArgs(action, body)
  const result = await execFileAsync(
    'npx',
    ['--yes', 'tsx', 'scripts/company-web-enrichment/run-company-web-enrichment.ts', ...args],
    {
      cwd: process.cwd(),
      env: process.env,
      timeout: 295000,
      maxBuffer: MAX_BUFFER,
    }
  )

  return {
    payload: parseFirstJsonObject(result.stdout) ?? null,
    stdout_tail: result.stdout.slice(-4000),
    stderr_tail: result.stderr.slice(-4000),
  }
}

async function execute(action: WebEnrichmentAction, body: Record<string, unknown> = {}) {
  if (action === 'progress') {
    return runWorker('progress', body)
  }

  if (runningPromise) {
    return {
      already_running: true,
      message: 'Ya hay un poblamiento web masivo en ejecución.',
      current: await runWorker('progress', body),
    }
  }

  runningPromise = runWorker(action, body).finally(() => {
    runningPromise = null
  })

  return runningPromise
}

export async function GET(req: NextRequest) {
  const secretAuthorized = hasOpsSecret(req)
  const user = secretAuthorized ? null : await requireAuthenticatedUser()
  if (!secretAuthorized && !user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  try {
    const action = (req.nextUrl.searchParams.get('action') ?? (secretAuthorized ? 'run' : 'progress')) as WebEnrichmentAction
    if (!['progress', 'enqueue', 'process', 'run'].includes(action)) {
      return NextResponse.json({ error: 'Acción inválida.' }, { status: 400 })
    }

    const data = await execute(action, {
      limit: req.nextUrl.searchParams.get('limit'),
      batch_size: req.nextUrl.searchParams.get('batch_size'),
      need: req.nextUrl.searchParams.get('need'),
      retry_failed: req.nextUrl.searchParams.get('retry_failed') === 'true',
      force_refresh: req.nextUrl.searchParams.get('force_refresh') === 'true',
      dry_run: req.nextUrl.searchParams.get('dry_run') === 'true',
    })

    return NextResponse.json({ success: true, data })
  } catch (error) {
    console.error('[company-web-enrichment/run:get]', error)
    const message = error instanceof Error ? error.message : 'No se pudo ejecutar el poblamiento web.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const secretAuthorized = hasOpsSecret(req)
  const user = secretAuthorized ? null : await requireAuthenticatedUser()
  if (!secretAuthorized && !user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const action = (body?.action ?? 'run') as WebEnrichmentAction
    if (!['progress', 'enqueue', 'process', 'run'].includes(action)) {
      return NextResponse.json({ error: 'Acción inválida.' }, { status: 400 })
    }

    const data = await execute(action, body)
    return NextResponse.json({ success: true, data })
  } catch (error) {
    console.error('[company-web-enrichment/run:post]', error)
    const message = error instanceof Error ? error.message : 'No se pudo ejecutar el poblamiento web.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
