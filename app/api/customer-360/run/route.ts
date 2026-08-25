import { NextRequest, NextResponse } from 'next/server'
import { isCronSecretValid } from '@/lib/services/cron-auth'
import {
  runCustomer360DailyReconciliation,
  runCustomer360MicroBatch,
} from '@/lib/services/customer-360'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

let activeRun: Promise<unknown> | null = null

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null
  if (!isCronSecretValid(token)) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const mode = req.nextUrl.searchParams.get('mode') ?? 'micro'
  if (!['micro', 'daily'].includes(mode)) {
    return NextResponse.json({ error: 'mode debe ser micro o daily.' }, { status: 400 })
  }
  if (activeRun) return NextResponse.json({ error: 'Ya existe una corrida Customer 360 activa.' }, { status: 409 })

  try {
    activeRun = mode === 'daily'
      ? runCustomer360DailyReconciliation()
      : runCustomer360MicroBatch()
    const result = await activeRun
    return NextResponse.json({ success: true, mode, data: result })
  } catch (error) {
    console.error('[customer-360/run]', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Falló Customer 360.' }, { status: 500 })
  } finally {
    activeRun = null
  }
}
