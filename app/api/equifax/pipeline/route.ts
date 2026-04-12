import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient, db } from '@/lib/db/supabase'
import { buildEquifaxProjectionSummary, runEquifaxScoringPipeline } from '@/lib/services/equifax-scoring'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function hasOpsSecret(req: NextRequest) {
  const expected =
    process.env.EQUIFAX_OPS_CRON_SECRET ||
    process.env.CRON_SECRET ||
    process.env.CRM_FEEDBACK_INGEST_TOKEN

  if (!expected) return false

  const candidate =
    req.headers.get('x-equifax-ops-secret') ??
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

async function getLatestPipelineRun() {
  const { data, error } = await db
    .from('equifax_scoring_pipeline_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`No se pudo leer la última corrida Equifax: ${error.message}`)
  }

  return data ?? null
}

export async function GET(req: NextRequest) {
  const secretAuthorized = hasOpsSecret(req)
  const user = secretAuthorized ? null : await requireAuthenticatedUser()
  if (!secretAuthorized && !user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  try {
    const section = req.nextUrl.searchParams.get('section') ?? 'run'
    if (section === 'latest') {
      const latest = await getLatestPipelineRun()
      const projections = await buildEquifaxProjectionSummary()
      return NextResponse.json({ success: true, data: { latest, projections } })
    }

    const mode = (req.nextUrl.searchParams.get('mode') ?? 'safe') as 'safe' | 'force' | 'dry-run'
    const result = await runEquifaxScoringPipeline({
      triggerSource: secretAuthorized ? 'cron' : 'manual-api',
      activationMode: mode,
    })

    return NextResponse.json({ success: true, data: result })
  } catch (error) {
    console.error('[equifax/pipeline:get]', error)
    const message = error instanceof Error ? error.message : 'No se pudo ejecutar el pipeline Equifax.'
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
    const action = body?.action ?? 'run'

    if (action === 'latest') {
      const latest = await getLatestPipelineRun()
      const projections = await buildEquifaxProjectionSummary()
      return NextResponse.json({ success: true, data: { latest, projections } })
    }

    const mode = (body?.mode ?? 'safe') as 'safe' | 'force' | 'dry-run'
    const result = await runEquifaxScoringPipeline({
      triggerSource: secretAuthorized ? 'cron' : 'manual-api',
      activationMode: mode,
    })

    return NextResponse.json({ success: true, data: result })
  } catch (error) {
    console.error('[equifax/pipeline:post]', error)
    const message = error instanceof Error ? error.message : 'No se pudo ejecutar el pipeline Equifax.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
