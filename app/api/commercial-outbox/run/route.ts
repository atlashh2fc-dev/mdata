import { NextRequest, NextResponse } from 'next/server'
import { isCronSecretValid, runCommercialOutbox } from '@/lib/services/commercial-outbox'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

let activeRun: Promise<unknown> | null = null

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null
  if (!isCronSecretValid(token)) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const mode = req.nextUrl.searchParams.get('mode') ?? 'drain'
  if (!['generate', 'drain'].includes(mode)) {
    return NextResponse.json({ error: 'mode debe ser generate o drain.' }, { status: 400 })
  }
  if (activeRun) return NextResponse.json({ error: 'Ya existe una corrida activa en esta instancia.' }, { status: 409 })

  try {
    activeRun = runCommercialOutbox({ generate: mode === 'generate' })
    const result = await activeRun
    return NextResponse.json({ success: true, mode, data: result })
  } catch (error) {
    console.error('[commercial-outbox/run]', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Falló el outbox comercial.' }, { status: 500 })
  } finally {
    activeRun = null
  }
}
