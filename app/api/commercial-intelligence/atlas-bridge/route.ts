import { NextRequest, NextResponse } from 'next/server'
import { ingestContactCenterFeedback } from '@/lib/services/commercial-intelligence'
import {
  authorizeAtlasLeadBridgeRequest,
  parseAtlasLeadBridgePayload,
} from '@/lib/services/atlas-lead-bridge'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const authorization = authorizeAtlasLeadBridgeRequest({
    rawBody,
    apiKey:
      req.headers.get('x-api-key') ??
      req.headers.get('authorization')?.replace(/^Bearer\s+/i, ''),
    signature: req.headers.get('x-atlas-signature'),
    timestamp: req.headers.get('x-atlas-timestamp'),
  })

  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error }, { status: authorization.status })
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'El payload Atlas no es JSON válido.' }, { status: 400 })
  }

  const parsed = parseAtlasLeadBridgePayload(payload)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status })
  }

  if (parsed.ignored) {
    return NextResponse.json({ success: true, ignored: true, reason: parsed.reason })
  }

  try {
    const result = await ingestContactCenterFeedback([parsed.record], {
      sourceName: 'atlas_lead_engine_bridge',
      refreshScores: false,
      requestedFrom: parsed.eventAt,
      requestedTo: parsed.eventAt,
      cursorValue: parsed.eventAt,
      metadata: {
        bridge_source: 'atlas_lead_engine',
        authorization_mode: authorization.mode,
        event_type: parsed.eventType,
        campaign_type: parsed.campaignType,
      },
    })

    return NextResponse.json({
      success: true,
      data: result,
      note: 'Evento Atlas ingerido. El recálculo completo del score queda delegado al pipeline/sync posterior.',
    })
  } catch (error) {
    console.error('[commercial-intelligence/atlas-bridge]', error)
    const message =
      error instanceof Error
        ? error.message
        : 'No se pudo ingerir el evento de Atlas Lead Engine.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
