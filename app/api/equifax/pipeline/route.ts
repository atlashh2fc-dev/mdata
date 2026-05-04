import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient, db } from '@/lib/db/supabase'
import {
  buildEquifaxProjectionSummary,
  findLatestRunningEquifaxPipelineRun,
  markStaleEquifaxPipelineRunsAsFailed,
  runEquifaxScoringPipeline,
} from '@/lib/services/equifax-scoring'

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

async function getLatestSuccessfulPipelineRun() {
  const { data, error } = await db
    .from('equifax_scoring_pipeline_runs')
    .select('*')
    .eq('status', 'success')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`No se pudo leer la última corrida Equifax exitosa: ${error.message}`)
  }

  return data ?? null
}

async function getActiveModels() {
  const { data, error } = await db
    .from('equifax_scoring_models')
    .select('target,model_version,model_type,trained_rows,metrics,metadata,trained_at')
    .eq('model_key', 'equifax-lead')
    .eq('is_active', true)
    .order('target', { ascending: true })

  if (error) {
    throw new Error(`No se pudieron leer los modelos activos Equifax: ${error.message}`)
  }

  return data ?? []
}

function hasPayload(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length > 0)
}

async function buildPipelineOverview() {
  await markStaleEquifaxPipelineRunsAsFailed()

  const latest = await getLatestPipelineRun()
  const latestSuccess = latest?.status === 'success'
    ? latest
    : await getLatestSuccessfulPipelineRun()

  const projections =
    (hasPayload(latest?.projection_payload) ? latest.projection_payload : null) ??
    (hasPayload(latestSuccess?.projection_payload) ? latestSuccess.projection_payload : null) ??
    await buildEquifaxProjectionSummary()

  const latestTrainingPayload = hasPayload(latest?.training_payload) ? latest.training_payload : null
  const latestSuccessTrainingPayload = hasPayload(latestSuccess?.training_payload) ? latestSuccess.training_payload : null
  const crosscheck =
    (hasPayload(latestTrainingPayload?.crosscheck_summary) ? latestTrainingPayload.crosscheck_summary : null) ??
    (hasPayload(latestSuccessTrainingPayload?.crosscheck_summary) ? latestSuccessTrainingPayload.crosscheck_summary : null) ??
    null

  const activeModels = await getActiveModels()
  return { latest, projections, crosscheck, active_models: activeModels }
}

async function executePipelineRun(triggerSource: 'cron' | 'manual-api', mode: 'safe' | 'force' | 'dry-run') {
  await markStaleEquifaxPipelineRunsAsFailed()

  const existingRun = await findLatestRunningEquifaxPipelineRun()
  if (existingRun) {
    return {
      ...existingRun,
      queued: true,
      already_running: true,
      message: 'Ya hay una corrida Equifax en progreso.',
    }
  }

  const run = await runEquifaxScoringPipeline({
    triggerSource,
    activationMode: mode,
  })

  return {
    ...run,
    message: 'Pipeline Equifax ejecutado.',
  }
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
      const overview = await buildPipelineOverview()
      return NextResponse.json({ success: true, data: overview })
    }

    const mode = (req.nextUrl.searchParams.get('mode') ?? 'safe') as 'safe' | 'force' | 'dry-run'
    const result = await executePipelineRun(secretAuthorized ? 'cron' : 'manual-api', mode)
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
      const overview = await buildPipelineOverview()
      return NextResponse.json({ success: true, data: overview })
    }

    const mode = (body?.mode ?? 'safe') as 'safe' | 'force' | 'dry-run'
    const result = await executePipelineRun(secretAuthorized ? 'cron' : 'manual-api', mode)
    return NextResponse.json({ success: true, data: result })
  } catch (error) {
    console.error('[equifax/pipeline:post]', error)
    const message = error instanceof Error ? error.message : 'No se pudo ejecutar el pipeline Equifax.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
