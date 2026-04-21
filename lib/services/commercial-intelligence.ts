'use server'

import { db } from '@/lib/db/supabase'
import { analyzeWithAI } from '@/lib/services/ai'
import { cleanRut } from '@/lib/utils/rut'
import type {
  CommercialRutSummary,
  CommercialOverview,
  ContactCenterFeedbackInput,
  ContactCenterIngestionResult,
  PersonaCommercialIntelligence,
  PersonaFeedbackEvent,
  PersonaScoreCard,
} from '@/types'

const UPSERT_CHUNK_SIZE = 500
const CRM_SUMMARY_HISTORY_LIMIT = 5000

type CommercialSummaryFeedbackRow = {
  id: string
  rutid: string | null
  matched_rutid: string | null
  managed_at: string
  outcome: PersonaFeedbackEvent['outcome']
  outcome_subtype: string | null
  channel: PersonaFeedbackEvent['channel']
  campaign_name: string | null
  agent_name: string | null
}

function normalizeRutForDb(value?: string | null): string | null {
  if (!value) return null
  const cleaned = cleanRut(value)
  if (cleaned.length < 2) return null
  return cleaned.padStart(10, '0')
}

function normalizeEmail(value?: string | null): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized || null
}

function normalizePhone(value?: string | null): string | null {
  if (!value) return null
  const digits = value.replace(/\D/g, '')
  if (!digits) return null
  if (digits.length === 8) return `+569${digits}`
  if (digits.length === 9 && digits.startsWith('9')) return `+56${digits}`
  if (digits.length === 11 && digits.startsWith('56')) return `+${digits}`
  if (digits.startsWith('569')) return `+${digits}`
  return `+${digits}`
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value > 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return ['true', '1', 'si', 'sí', 'yes', 'y'].includes(normalized)
  }
  return false
}

function toIsoDate(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  return null
}

function normalizeFeedbackRecord(record: ContactCenterFeedbackInput) {
  const managedAt = toIsoDate(record.managed_at ?? record.fecha_gestion ?? record.created_at) ?? new Date().toISOString()
  const soldAt = toIsoDate(record.sold_at)
  const callbackAt = toIsoDate(record.callback_at)
  const openedAt = toIsoDate(record.opened_at)
  const clickedAt = toIsoDate(record.clicked_at)
  const respondedAt = toIsoDate(record.responded_at)
  const rutid = normalizeRutForDb(record.rutid)
  const matchedRutid = normalizeRutForDb(record.matched_rutid)
  const phone = normalizePhone(record.contact_phone ?? record.telefono)
  const email = normalizeEmail(record.contact_email ?? record.email)
  const outcome = record.outcome ?? 'unknown'

  return {
    external_source: record.external_source ?? 'registro_intel',
    external_event_id: String(record.external_event_id ?? record.id ?? crypto.randomUUID()),
    external_record_type: record.external_record_type ?? null,
    rutid,
    matched_rutid: matchedRutid,
    match_method: record.match_method ?? (matchedRutid ? 'crm_match' : rutid ? 'direct_rut' : null),
    contact_phone: phone,
    contact_email: email,
    channel: record.channel ?? 'other',
    managed_at: managedAt,
    outcome,
    outcome_subtype: record.outcome_subtype ?? null,
    outcome_reason: record.outcome_reason ?? record.motivo_rechazo ?? null,
    direction: record.direction ?? null,
    duration_seconds: record.duration_seconds ?? record.duracion ?? null,
    talk_seconds: record.talk_seconds ?? null,
    wait_seconds: record.wait_seconds ?? null,
    agent_id: record.agent_id ?? null,
    agent_name: record.agent_name ?? record.agente ?? null,
    campaign_id: record.campaign_id ?? null,
    campaign_name: record.campaign_name ?? record.campana ?? null,
    opened_at: openedAt,
    clicked_at: clickedAt,
    callback_at: callbackAt,
    responded_at: respondedAt,
    sold_at: soldAt,
    value_amount: record.value_amount ?? record.monto ?? null,
    mail_opened: toBoolean(record.mail_opened) || Boolean(openedAt) || outcome === 'opened',
    clicked: toBoolean(record.clicked) || Boolean(clickedAt) || outcome === 'clicked',
    callback_requested: toBoolean(record.callback_requested ?? record.callback) || Boolean(callbackAt) || outcome === 'callback',
    interested: toBoolean(record.interested) || outcome === 'interested',
    contacted: toBoolean(record.contacted) || ['contacted', 'interested', 'callback', 'sale'].includes(outcome),
    effective_contact: toBoolean(record.effective_contact) || ['contacted', 'interested', 'callback', 'sale'].includes(outcome),
    sale: toBoolean(record.sale ?? record.venta) || Boolean(soldAt) || outcome === 'sale',
    is_best_management: toBoolean(record.is_best_management),
    raw_payload: record.raw_payload ?? record,
    metadata: record.metadata ?? {},
  }
}

async function upsertContactPoints(records: ReturnType<typeof normalizeFeedbackRecord>[]) {
  const candidateRutids = [...new Set(
    records
      .map(record => record.matched_rutid ?? record.rutid)
      .filter((value): value is string => Boolean(value))
  )]

  const existingRuts = new Set<string>()

  for (let i = 0; i < candidateRutids.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = candidateRutids.slice(i, i + UPSERT_CHUNK_SIZE)
    const { data, error } = await db
      .from('master_personas')
      .select('rutid')
      .in('rutid', chunk)

    if (error) {
      console.error('[upsertContactPoints:master_personas]', error)
      throw new Error('No se pudo validar los RUTs de la base maestra.')
    }

    for (const row of data ?? []) {
      if (row.rutid) existingRuts.add(row.rutid)
    }
  }

  const points = new Map<string, {
    rutid: string
    contact_type: 'phone' | 'email'
    contact_value: string
    normalized_value: string
    source_name: string
    source_priority: number
    quality_score: number
    is_primary: boolean
    is_verified: boolean
    last_seen_at: string
    last_feedback_at: string
    metadata: Record<string, unknown>
  }>()

  for (const record of records) {
    const rutid = record.matched_rutid ?? record.rutid
    if (!rutid || !existingRuts.has(rutid)) continue

    if (record.contact_phone) {
      const key = `${rutid}:phone:${record.contact_phone}`
      points.set(key, {
        rutid,
        contact_type: 'phone',
        contact_value: record.contact_phone,
        normalized_value: record.contact_phone,
        source_name: record.external_source,
        source_priority: 80,
        quality_score: record.effective_contact ? 85 : 65,
        is_primary: record.effective_contact || record.sale,
        is_verified: record.effective_contact || record.sale,
        last_seen_at: record.managed_at,
        last_feedback_at: record.managed_at,
        metadata: {
          channel: record.channel,
          campaign_name: record.campaign_name,
        },
      })
    }

    if (record.contact_email) {
      const key = `${rutid}:email:${record.contact_email}`
      points.set(key, {
        rutid,
        contact_type: 'email',
        contact_value: record.contact_email,
        normalized_value: record.contact_email,
        source_name: record.external_source,
        source_priority: 75,
        quality_score: record.mail_opened || record.clicked ? 85 : 60,
        is_primary: record.mail_opened || record.clicked || record.sale,
        is_verified: record.mail_opened || record.clicked || record.sale,
        last_seen_at: record.managed_at,
        last_feedback_at: record.managed_at,
        metadata: {
          channel: record.channel,
          campaign_name: record.campaign_name,
        },
      })
    }
  }

  const rows = [...points.values()]
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE)
    await db
      .from('persona_contact_points')
      .upsert(chunk, { onConflict: 'rutid,contact_type,normalized_value' })
  }
}

export async function refreshPersonaScores(rutids?: string[]): Promise<number> {
  const normalized = (rutids ?? [])
    .map(value => normalizeRutForDb(value))
    .filter((value): value is string => Boolean(value))

  const { data, error } = await db.rpc('refresh_persona_scores', {
    p_rutids: normalized.length > 0 ? normalized : null,
  })

  if (error) {
    console.error('[refreshPersonaScores]', error)
    return 0
  }

  return Number(data ?? 0)
}

export async function ingestContactCenterFeedback(
  records: ContactCenterFeedbackInput[],
  options?: {
    sourceName?: string
    refreshScores?: boolean
    requestedFrom?: string | null
    requestedTo?: string | null
    cursorValue?: string | null
    metadata?: Record<string, unknown>
  }
): Promise<ContactCenterIngestionResult> {
  if (!records.length) {
    return {
      inserted: 0,
      affected_ruts: 0,
      refreshed_scores: 0,
      sync_run_id: null,
    }
  }

  const sourceName = options?.sourceName ?? 'registro_intel'
  const normalizedRecords = records.map(normalizeFeedbackRecord)
  const uniqueRutids = new Set<string>()

  for (const record of normalizedRecords) {
    const rutid = record.matched_rutid ?? record.rutid
    if (rutid) uniqueRutids.add(rutid)
  }

  const { data: syncRun } = await db
    .from('external_sync_runs')
    .insert({
      source_name: sourceName,
      source_kind: 'api',
      status: 'running',
      requested_from: options?.requestedFrom ?? null,
      requested_to: options?.requestedTo ?? null,
      cursor_value: options?.cursorValue ?? null,
      metadata: options?.metadata ?? {},
      records_fetched: records.length,
    })
    .select('id')
    .single()

  let loaded = 0

  try {
    for (let i = 0; i < normalizedRecords.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = normalizedRecords.slice(i, i + UPSERT_CHUNK_SIZE)
      const { error } = await db
        .from('contact_center_feedback')
        .upsert(chunk, { onConflict: 'external_source,external_event_id' })

      if (error) throw error
      loaded += chunk.length
    }

    await upsertContactPoints(normalizedRecords)

    const refreshedScores = options?.refreshScores === false
      ? 0
      : await refreshPersonaScores([...uniqueRutids])

    await db
      .from('external_sync_runs')
      .update({
        status: 'completed',
        records_loaded: loaded,
        affected_ruts: uniqueRutids.size,
        completed_at: new Date().toISOString(),
      })
      .eq('id', syncRun?.id ?? '')

    return {
      inserted: loaded,
      affected_ruts: uniqueRutids.size,
      refreshed_scores: refreshedScores,
      sync_run_id: syncRun?.id ?? null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error ingestando feedback'
    if (syncRun?.id) {
      await db
        .from('external_sync_runs')
        .update({
          status: loaded > 0 ? 'partial' : 'failed',
          records_loaded: loaded,
          affected_ruts: uniqueRutids.size,
          error_message: message,
          completed_at: new Date().toISOString(),
        })
        .eq('id', syncRun.id)
    }
    throw error
  }
}

export async function markBestManagement(feedbackId: string, isBestManagement = true) {
  const { data, error } = await db
    .from('contact_center_feedback')
    .update({ is_best_management: isBestManagement, updated_at: new Date().toISOString() })
    .eq('id', feedbackId)
    .select('rutid, matched_rutid')
    .single()

  if (error) {
    console.error('[markBestManagement]', error)
    return false
  }

  const rutid = data?.matched_rutid ?? data?.rutid
  if (rutid) {
    await refreshPersonaScores([rutid])
  }
  return true
}

export async function getCommercialOverview(): Promise<CommercialOverview> {
  const [{ data: overview }, { data: topOpportunities }, { data: recentSyncs }] = await Promise.all([
    db.from('commercial_intelligence_overview').select('*').single(),
    db
      .from('persona_scores')
      .select(`
        rutid,
        contactability_score,
        purchase_propensity_score,
        priority_score,
        best_channel,
        best_contact_hour,
        next_best_action,
        action_priority,
        feedback_coverage,
        updated_at
      `)
      .order('priority_score', { ascending: false })
      .limit(12),
    db
      .from('external_sync_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(8),
  ])

  return {
    total_scored_personas: overview?.total_scored_personas ?? 0,
    with_feedback: overview?.with_feedback ?? 0,
    high_priority_personas: overview?.high_priority_personas ?? 0,
    recommended_phone: overview?.recommended_phone ?? 0,
    recommended_email: overview?.recommended_email ?? 0,
    avg_contactability_score: Number(overview?.avg_contactability_score ?? 0),
    avg_purchase_propensity_score: Number(overview?.avg_purchase_propensity_score ?? 0),
    avg_priority_score: Number(overview?.avg_priority_score ?? 0),
    last_score_refresh: overview?.last_score_refresh ?? null,
    last_feedback_sync: overview?.last_feedback_sync ?? null,
    top_opportunities: (topOpportunities ?? []) as PersonaScoreCard[],
    recent_syncs: recentSyncs ?? [],
  }
}

export async function getCommercialSummariesByRutids(
  rutids: string[]
): Promise<CommercialRutSummary[]> {
  const normalizedRutids = [...new Set(
    (rutids ?? [])
      .map(value => normalizeRutForDb(value))
      .filter((value): value is string => Boolean(value))
  )]

  if (!normalizedRutids.length) return []

  const selectClause = `
    rutid,
    feedback_coverage,
    should_contact,
    contactability_score,
    purchase_propensity_score,
    priority_score,
    best_channel,
    best_contact_hour,
    next_best_action,
    action_priority,
    best_phone,
    best_email,
    total_interactions,
    effective_contacts,
    interest_events,
    callback_events,
    sales_events,
    last_feedback_at,
    last_contact_at,
    last_sale_at,
    updated_at
  `

  const fetchSummaries = async (targetRutids: string[]) => {
    const { data, error } = await db
      .from('persona_scores')
      .select(selectClause)
      .in('rutid', targetRutids)

    if (error) {
      console.error('[getCommercialSummariesByRutids]', error)
      throw new Error('No se pudo leer el resumen CRM de la base actual.')
    }

    return (data ?? []) as CommercialRutSummary[]
  }

  let summaries = await fetchSummaries(normalizedRutids)
  const foundRutids = new Set(summaries.map(item => item.rutid))
  const missingRutids = normalizedRutids.filter(rutid => !foundRutids.has(rutid))

  if (missingRutids.length) {
    try {
      await refreshPersonaScores(missingRutids)
      const refreshed = await fetchSummaries(missingRutids)
      const refreshedMap = new Map(refreshed.map(item => [item.rutid, item]))
      summaries = summaries.concat(
        missingRutids
          .map(rutid => refreshedMap.get(rutid))
          .filter((item): item is CommercialRutSummary => Boolean(item))
      )
    } catch (error) {
      console.error('[getCommercialSummariesByRutids.refresh]', error)
    }
  }

  const [matchedHistory, directHistory] = await Promise.all([
    db
      .from('contact_center_feedback')
      .select('id,rutid,matched_rutid,managed_at,outcome,outcome_subtype,channel,campaign_name,agent_name')
      .in('matched_rutid', normalizedRutids)
      .order('managed_at', { ascending: false })
      .limit(CRM_SUMMARY_HISTORY_LIMIT),
    db
      .from('contact_center_feedback')
      .select('id,rutid,matched_rutid,managed_at,outcome,outcome_subtype,channel,campaign_name,agent_name')
      .in('rutid', normalizedRutids)
      .order('managed_at', { ascending: false })
      .limit(CRM_SUMMARY_HISTORY_LIMIT),
  ])

  const latestFeedbackByRut = new Map<string, CommercialSummaryFeedbackRow>()
  const seenEventIds = new Set<string>()

  for (const row of [
    ...((matchedHistory.data ?? []) as CommercialSummaryFeedbackRow[]),
    ...((directHistory.data ?? []) as CommercialSummaryFeedbackRow[]),
  ]) {
    if (seenEventIds.has(row.id)) continue
    seenEventIds.add(row.id)

    const eventRutid = normalizeRutForDb(row.matched_rutid ?? row.rutid)
    if (!eventRutid || latestFeedbackByRut.has(eventRutid)) continue
    latestFeedbackByRut.set(eventRutid, row)
  }

  const summaryMap = new Map(summaries.map(item => [item.rutid, item]))

  return normalizedRutids
    .map(rutid => {
      const summary = summaryMap.get(rutid)
      if (!summary) return null

      const latestFeedback = latestFeedbackByRut.get(rutid)

      return {
        ...summary,
        latest_outcome: latestFeedback?.outcome ?? null,
        latest_outcome_subtype: latestFeedback?.outcome_subtype ?? null,
        latest_channel: latestFeedback?.channel ?? null,
        latest_campaign_name: latestFeedback?.campaign_name ?? null,
        latest_agent_name: latestFeedback?.agent_name ?? null,
        latest_managed_at: latestFeedback?.managed_at ?? summary.last_feedback_at ?? null,
      }
    })
    .filter((item): item is CommercialRutSummary => Boolean(item))
}

async function getPersonaScore(rutid: string): Promise<PersonaScoreCard | null> {
  const { data } = await db
    .from('persona_scores')
    .select('*')
    .eq('rutid', rutid)
    .single()

  return (data as PersonaScoreCard | null) ?? null
}

export async function getPersonaCommercialIntelligence(rut: string): Promise<PersonaCommercialIntelligence | null> {
  const rutid = normalizeRutForDb(rut)
  if (!rutid) return null

  let score = await getPersonaScore(rutid)
  if (!score) {
    await refreshPersonaScores([rutid])
    score = await getPersonaScore(rutid)
  }

  const [{ data: persona }, { data: history }, { data: contactPoints }] = await Promise.all([
    db.from('master_personas_view').select('*').eq('rutid', rutid).single(),
    db
      .from('contact_center_feedback')
      .select('*')
      .or(`rutid.eq.${rutid},matched_rutid.eq.${rutid}`)
      .order('managed_at', { ascending: false })
      .limit(25),
    db
      .from('persona_contact_points')
      .select('*')
      .eq('rutid', rutid)
      .order('is_primary', { ascending: false })
      .order('quality_score', { ascending: false }),
  ])

  if (!persona) return null

  return {
    persona,
    score: score as PersonaScoreCard | null,
    history: (history ?? []) as PersonaFeedbackEvent[],
    contact_points: contactPoints ?? [],
  }
}

export async function explainPersonaCommercialScore(
  rut: string,
  userId?: string
): Promise<Record<string, unknown> | null> {
  const profile = await getPersonaCommercialIntelligence(rut)
  if (!profile?.persona) return null

  try {
    const result = await analyzeWithAI(
      {
        type: 'scoring',
        data: {
          persona: profile.persona,
          score: profile.score,
          history: profile.history.slice(0, 10),
          contact_points: profile.contact_points,
        },
        context: 'Explica el score comercial, priorización, mejor canal y siguiente acción sugerida para un contact center.',
      },
      userId
    )

    return result.result
  } catch (error) {
    console.error('[explainPersonaCommercialScore]', error)
    return null
  }
}
