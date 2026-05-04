import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import {
  getMiroFishScenarioRun,
  listMiroFishScenarioRuns,
  startMiroFishScenarioRun,
  syncMiroFishScenarioRun,
  syncPendingMiroFishScenarioRuns,
} from '@/lib/services/mirofish'
import type { MiroFishScenarioStartRequest } from '@/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function hasOpsSecret(req: NextRequest) {
  const expected =
    process.env.MIROFISH_BRIDGE_SECRET ||
    process.env.CRON_SECRET ||
    process.env.CRM_FEEDBACK_INGEST_TOKEN

  if (!expected) return false

  const candidate =
    req.headers.get('x-mirofish-bridge-secret') ??
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

export async function GET(req: NextRequest) {
  const secretAuthorized = hasOpsSecret(req)
  const user = secretAuthorized ? null : await requireAuthenticatedUser()
  if (!secretAuthorized && !user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  try {
    const section = req.nextUrl.searchParams.get('section') ?? 'list'
    const runId = req.nextUrl.searchParams.get('run_id')

    if (section === 'run') {
      if (!runId) {
        return NextResponse.json({ error: 'run_id es requerido' }, { status: 400 })
      }

      const run = await getMiroFishScenarioRun(runId)
      if (!run) {
        return NextResponse.json({ error: 'Corrida no encontrada' }, { status: 404 })
      }

      return NextResponse.json({ success: true, data: run })
    }

    const limit = Number(req.nextUrl.searchParams.get('limit') ?? 20)
    const runs = await listMiroFishScenarioRuns(Number.isFinite(limit) ? limit : 20)
    return NextResponse.json({ success: true, data: runs })
  } catch (error) {
    console.error('[scenarios/mirofish:get]', error)
    const message = error instanceof Error ? error.message : 'No se pudo consultar el puente MiroFish.'
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
    const action = typeof body?.action === 'string' ? body.action : 'start'

    if (action === 'start') {
      const payload = body as MiroFishScenarioStartRequest & { action?: string }
      const data = await startMiroFishScenarioRun(payload, user?.id)
      return NextResponse.json({ success: true, data }, { status: 201 })
    }

    if (action === 'sync') {
      if (!body?.run_id || typeof body.run_id !== 'string') {
        return NextResponse.json({ error: 'run_id es requerido' }, { status: 400 })
      }

      const data = await syncMiroFishScenarioRun(body.run_id)
      return NextResponse.json({ success: true, data })
    }

    if (action === 'sync_all') {
      const limit = Number(body?.limit ?? 10)
      const data = await syncPendingMiroFishScenarioRuns(Number.isFinite(limit) ? limit : 10)
      return NextResponse.json({ success: true, data })
    }

    if (action === 'get') {
      if (!body?.run_id || typeof body.run_id !== 'string') {
        return NextResponse.json({ error: 'run_id es requerido' }, { status: 400 })
      }

      const run = await getMiroFishScenarioRun(body.run_id)
      if (!run) {
        return NextResponse.json({ error: 'Corrida no encontrada' }, { status: 404 })
      }

      return NextResponse.json({ success: true, data: run })
    }

    return NextResponse.json({ error: 'Accion no reconocida' }, { status: 400 })
  } catch (error) {
    console.error('[scenarios/mirofish:post]', error)
    const message = error instanceof Error ? error.message : 'No se pudo ejecutar el puente MiroFish.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
