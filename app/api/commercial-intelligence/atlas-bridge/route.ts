import { NextRequest, NextResponse, unstable_after as after } from 'next/server'
import { ingestContactCenterFeedback } from '@/lib/services/commercial-intelligence'
import { processCustomer360Doorbell } from '@/lib/services/customer-360'
import {
  authorizeAtlasLeadBridgeRequest,
  ingestCanonicalFeedbackV2,
  parseAtlasLeadBridgeEnvelope,
  resolveAtlasBridgeCompanyMatches,
} from '@/lib/services/atlas-lead-bridge'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const MAX_BODY_BYTES = 1024 * 1024

function scheduleCustomer360Doorbell() {
  after(async () => {
    try {
      await processCustomer360Doorbell()
    } catch (error) {
      console.warn('[commercial-intelligence/atlas-bridge:doorbell]', error)
    }
  })
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'El payload excede 1 MiB.' }, { status: 413 })
  }
  const authorization = authorizeAtlasLeadBridgeRequest({
    rawBody,
    source: req.headers.get('x-atlas-source'),
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

  const parsed = parseAtlasLeadBridgeEnvelope(payload)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status })
  }

  const atlasSource = req.headers.get('x-atlas-source')
  if (parsed.contract === 'canonical.v2') {
    const eventSources = new Set((parsed.canonicalEvents ?? []).map(event => event.event_source))
    const expectedHeader = eventSources.has('urn:geimser:atlas2')
      ? 'atlas2'
      : eventSources.has('urn:geimser:atlas-lead') ? 'atlas_lead' : null
    if (eventSources.size !== 1 || !expectedHeader || atlasSource !== expectedHeader) {
      return NextResponse.json({ error: 'x-atlas-source no coincide con event_source v2.' }, { status: 400 })
    }
    if (expectedHeader === 'atlas2' && !req.headers.get('idempotency-key')?.trim()) {
      return NextResponse.json({ error: 'El lote v2 Atlas2 requiere idempotency-key.' }, { status: 400 })
    }
  } else if (parsed.contract === 'operation.feedback.v1') {
    if (atlasSource !== 'atlas2') {
      return NextResponse.json({ error: 'operation.feedback.v1 requiere x-atlas-source: atlas2.' }, { status: 400 })
    }
    if (!req.headers.get('idempotency-key')?.trim()) {
      return NextResponse.json({ error: 'operation.feedback.v1 requiere idempotency-key.' }, { status: 400 })
    }
  } else if (atlasSource === 'atlas2') {
    return NextResponse.json({ error: 'x-atlas-source: atlas2 solo admite operation.feedback.v1.' }, { status: 400 })
  }

  if (parsed.contract === 'canonical.v2') {
    try {
      const canaryEvents = (parsed.canonicalEvents ?? []).filter(event => event.event_type === 'integration.canary.v1')
      const ordered = await ingestCanonicalFeedbackV2(parsed.records, canaryEvents)
      scheduleCustomer360Doorbell()
      return NextResponse.json({
        success: true,
        acknowledged: true,
        accepted_event_ids: parsed.acceptedEventIds,
        applied_event_ids: ordered.accepted_event_ids,
        ignored: [...parsed.ignored, ...(ordered.ignored ?? [])],
        contract: parsed.contract,
        doorbell: 'scheduled',
        note: 'Evento v2 persistido con orden monotónico; stale/duplicados se reconocen sin sobrescribir.',
      })
    } catch (error) {
      console.error('[commercial-intelligence/atlas-bridge:v2]', error)
      return NextResponse.json({ error: error instanceof Error ? error.message : 'No se pudo ingerir el evento v2.' }, { status: 500 })
    }
  }

  if (parsed.records.length === 0) {
    return NextResponse.json({
      success: true,
      acknowledged: true,
      accepted_event_ids: parsed.acceptedEventIds,
      ignored: parsed.ignored,
      contract: parsed.contract,
    })
  }

  try {
    const records = await resolveAtlasBridgeCompanyMatches(parsed.records)
    const managedTimes = records
      .map(record => record.managed_at instanceof Date
        ? record.managed_at.toISOString()
        : typeof record.managed_at === 'string' ? record.managed_at : null)
      .filter((value): value is string => Boolean(value))
      .sort()
    const result = await ingestContactCenterFeedback(records, {
      sourceName: parsed.contract === 'operation.feedback.v1'
        ? 'atlas2_operation_feedback_bridge'
        : 'atlas_lead_engine_bridge',
      refreshScores: false,
      requestedFrom: managedTimes[0] ?? null,
      requestedTo: managedTimes.at(-1) ?? null,
      cursorValue: managedTimes.at(-1) ?? null,
      metadata: {
        bridge_source: parsed.contract === 'operation.feedback.v1' ? 'atlas2' : 'atlas_lead_engine',
        authorization_mode: authorization.mode,
        contract: parsed.contract,
        event_count: records.length,
        ignored_count: parsed.ignored.length,
      },
    })

    scheduleCustomer360Doorbell()

    return NextResponse.json({
      success: true,
      acknowledged: true,
      accepted_event_ids: parsed.acceptedEventIds,
      ignored: parsed.ignored,
      contract: parsed.contract,
      data: result,
      doorbell: 'scheduled',
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
