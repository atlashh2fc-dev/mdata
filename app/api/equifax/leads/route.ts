import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import { generateEquifaxLeads, previewEquifaxLeadScenarios, previewFreshEquifaxUniverse } from '@/lib/services/equifax-bdd'
import { getEquifaxRunActionFeed, pushEquifaxRunToCrm } from '@/lib/services/equifax-crm'
import type { EquifaxLeadGenerationParams, EquifaxUniverseProgress } from '@/types/equifax'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

async function requireAuthenticatedUser() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return user
}

export async function GET(req: NextRequest) {
  const user = await requireAuthenticatedUser()
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  try {
    const section = req.nextUrl.searchParams.get('section') ?? 'feed'
    const runId = req.nextUrl.searchParams.get('run_id')

    if (section === 'feed') {
      if (!runId) {
        return NextResponse.json({ error: 'run_id es requerido' }, { status: 400 })
      }

      const data = await getEquifaxRunActionFeed(runId)
      return NextResponse.json({ success: true, data })
    }

    return NextResponse.json({ error: 'Sección no soportada' }, { status: 400 })
  } catch (error) {
    console.error('[equifax/leads:get]', error)
    const message = error instanceof Error ? error.message : 'No se pudo preparar el feed Equifax.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const user = await requireAuthenticatedUser()
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const action =
      body?.action === 'generate'
        || body?.action === 'push_to_crm'
        || body?.action === 'preview_universe'
        || body?.action === 'preview_universe_stream'
        ? body.action
        : 'preview'

    if (action === 'push_to_crm') {
      if (!body?.run_id || typeof body.run_id !== 'string') {
        return NextResponse.json({ error: 'run_id es requerido' }, { status: 400 })
      }

      const data = await pushEquifaxRunToCrm(body.run_id, {
        allowed_temperatures: Array.isArray(body?.allowed_temperatures) ? body.allowed_temperatures : undefined,
        min_lead_score: body?.min_lead_score,
        min_contact_probability: body?.min_contact_probability,
        min_purchase_probability: body?.min_purchase_probability,
        exclude_existing_customers: body?.exclude_existing_customers === true,
        exclude_active_crm_targets: body?.exclude_active_crm_targets !== false,
        exclude_recent_crm_days: body?.exclude_recent_crm_days,
        max_leads: body?.max_leads ?? null,
      })
      return NextResponse.json({ success: true, data })
    }

    const params: EquifaxLeadGenerationParams = {
      volume: Number(body?.volume ?? 1000),
      product_ids: Array.isArray(body?.product_ids) ? body.product_ids : [],
      transient_products: Array.isArray(body?.transient_products) ? body.transient_products : [],
      prompt: typeof body?.prompt === 'string' ? body.prompt : null,
      regions: Array.isArray(body?.regions) ? body.regions : [],
      include_existing_customers: body?.include_existing_customers !== false,
      min_phone_count: Number(body?.min_phone_count ?? 1),
      min_email_count: Number(body?.min_email_count ?? 0),
      scenario_key: typeof body?.scenario_key === 'string' ? body.scenario_key : null,
      universe_source:
        body?.universe_source === 'sampled_master'
          ? 'sampled_master'
          : body?.universe_source === 'scored_universe'
            ? 'scored_universe'
            : 'fresh_companies',
      allowed_temperatures: Array.isArray(body?.allowed_temperatures) ? body.allowed_temperatures : undefined,
      scored_universe_limit: body?.scored_universe_limit == null ? null : Number(body.scored_universe_limit),
    }

    if (action === 'preview_universe_stream') {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          const send = (payload: Record<string, unknown>) => {
            controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`))
          }

          try {
            const data = await previewFreshEquifaxUniverse(params, (progress: EquifaxUniverseProgress) => {
              send({ type: 'progress', progress })
            })
            send({ type: 'result', data })
          } catch (error) {
            console.error('[equifax/leads:preview_universe_stream]', error)
            const message = error instanceof Error ? error.message : 'No se pudo construir el universo.'
            send({ type: 'error', error: message })
          } finally {
            controller.close()
          }
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      })
    }

    const result = action === 'preview_universe'
      ? await previewFreshEquifaxUniverse(params)
      : action === 'generate'
        ? await generateEquifaxLeads(params, user.id)
        : await previewEquifaxLeadScenarios(params)

    return NextResponse.json({ success: true, data: result })
  } catch (error) {
    console.error('[equifax/leads]', error)
    const message = error instanceof Error ? error.message : 'No se pudo generar la base Equifax.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
