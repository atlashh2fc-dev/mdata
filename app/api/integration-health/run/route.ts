import { NextRequest, NextResponse } from 'next/server'
import { isCronSecretValid } from '@/lib/services/cron-auth'
import { runIntegrationHealthCheck } from '@/lib/services/integration-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

let activeRun: Promise<unknown> | null = null

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null
  if (!isCronSecretValid(token)) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  if (activeRun) return NextResponse.json({ error: 'Canary ya activo en esta instancia.' }, { status: 409 })

  try {
    activeRun = runIntegrationHealthCheck()
    const data = await activeRun
    return NextResponse.json({ success: true, data })
  } catch (error) {
    console.error('[integration-health/run]', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Falló health check.' }, { status: 500 })
  } finally {
    activeRun = null
  }
}
