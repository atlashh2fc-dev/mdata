import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import {
  explainPersonaCommercialScore,
  getCommercialOverview,
  getCommercialSummariesByRutids,
  getPersonaCommercialIntelligence,
  ingestContactCenterFeedback,
  markBestManagement,
  refreshPersonaScores,
} from '@/lib/services/commercial-intelligence'
import { getCommercialActionFeed, getCommercialBrainOverview } from '@/lib/services/commercial-brain'
import type { ContactCenterFeedbackInput } from '@/types'

function hasSyncSecret(req: NextRequest): boolean {
  const expected = process.env.CRM_FEEDBACK_INGEST_TOKEN
  if (!expected) return false

  const candidate =
    req.headers.get('x-crm-sync-secret') ??
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
  const secretAuthorized = hasSyncSecret(req)
  const user = secretAuthorized ? null : await requireAuthenticatedUser()
  if (!secretAuthorized && !user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { searchParams } = req.nextUrl
  const rut = searchParams.get('rut')
  const section = searchParams.get('section') ?? 'overview'

  if (!rut && section === 'brain') {
    const brain = await getCommercialBrainOverview()
    return NextResponse.json({ success: true, data: brain })
  }

  if (!rut && section === 'actions') {
    const actions = await getCommercialActionFeed()
    return NextResponse.json({ success: true, data: actions })
  }

  if (!rut && section === 'summary') {
    const rutids = [
      ...searchParams.getAll('rutid'),
      ...(searchParams.get('rutids') ?? '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean),
    ]

    if (!rutids.length) {
      return NextResponse.json({ error: 'rutids es requerido' }, { status: 400 })
    }

    const summary = await getCommercialSummariesByRutids(rutids)
    return NextResponse.json({ success: true, data: summary })
  }

  if (rut) {
    if (section === 'explanation') {
      if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
      const explanation = await explainPersonaCommercialScore(rut, user.id)
      return NextResponse.json({ success: true, data: explanation })
    }

    const profile = await getPersonaCommercialIntelligence(rut)
    if (!profile) {
      return NextResponse.json({ error: 'RUT no encontrado' }, { status: 404 })
    }
    return NextResponse.json({ success: true, data: profile })
  }

  const overview = await getCommercialOverview()
  return NextResponse.json({ success: true, data: overview })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const action = body.action ?? 'ingest_feedback'
  const secretAuthorized = hasSyncSecret(req)

  if (action === 'ingest_feedback') {
    if (!secretAuthorized) {
      const user = await requireAuthenticatedUser()
      if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
    }

    const records = (body.records ?? []) as ContactCenterFeedbackInput[]
    if (!Array.isArray(records) || records.length === 0) {
      return NextResponse.json({ error: 'records es requerido' }, { status: 400 })
    }

    try {
      const result = await ingestContactCenterFeedback(records, {
        sourceName: body.source_name ?? 'registro_intel',
        refreshScores: body.refresh_scores !== false,
        requestedFrom: body.requested_from ?? null,
        requestedTo: body.requested_to ?? null,
        cursorValue: body.cursor_value ?? null,
        metadata: body.metadata ?? {},
      })

      return NextResponse.json({ success: true, data: result })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error ingestando feedback'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  const user = await requireAuthenticatedUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  if (action === 'refresh_scores') {
    const refreshed = await refreshPersonaScores(body.rutids)
    return NextResponse.json({ success: true, data: { refreshed } })
  }

  if (action === 'summary') {
    const rutids = Array.isArray(body.rutids)
      ? body.rutids.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0)
      : []

    if (!rutids.length) {
      return NextResponse.json({ error: 'rutids es requerido' }, { status: 400 })
    }

    const summary = await getCommercialSummariesByRutids(rutids)
    return NextResponse.json({ success: true, data: summary })
  }

  if (action === 'mark_best_management') {
    if (!body.feedback_id) {
      return NextResponse.json({ error: 'feedback_id es requerido' }, { status: 400 })
    }

    const ok = await markBestManagement(body.feedback_id, body.is_best_management !== false)
    return NextResponse.json({ success: ok })
  }

  return NextResponse.json({ error: 'Acción no reconocida' }, { status: 400 })
}
