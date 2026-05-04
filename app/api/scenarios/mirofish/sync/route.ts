import { NextRequest, NextResponse } from 'next/server'
import { syncPendingMiroFishScenarioRuns } from '@/lib/services/mirofish'

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

export async function GET(req: NextRequest) {
  if (!hasOpsSecret(req)) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  try {
    const limit = Number(req.nextUrl.searchParams.get('limit') ?? 10)
    const data = await syncPendingMiroFishScenarioRuns(Number.isFinite(limit) ? limit : 10)
    return NextResponse.json({ success: true, data })
  } catch (error) {
    console.error('[scenarios/mirofish/sync:get]', error)
    const message = error instanceof Error ? error.message : 'No se pudieron sincronizar las corridas MiroFish.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
