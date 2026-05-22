import { createClient } from '@supabase/supabase-js'
import pg from 'pg'

const { Client } = pg

const LOCAL_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const LOCAL_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
const REMOTE_URL = process.env.REGISTRO_INTEL_SUPABASE_URL
const REMOTE_SERVICE_KEY =
  process.env.REGISTRO_INTEL_SERVICE_ROLE_KEY ||
  process.env.REGISTRO_INTEL_SUPABASE_SERVICE_ROLE_KEY

const SOURCE_SYSTEM = process.env.REGISTRO_INTEL_SOURCE_SYSTEM || 'registro_intel'
const SOURCE_VIEW =
  process.env.REGISTRO_INTEL_FEEDBACK_VIEW ||
  process.env.REGISTRO_INTEL_FEEDBACK_SOURCE ||
  'crm_feedback_export_v1'
const LOOKBACK_MINUTES = Number(process.env.REGISTRO_INTEL_LOOKBACK_MINUTES || 10)
const BATCH_SIZE = Number(process.env.REGISTRO_INTEL_DIRECT_BATCH_SIZE || 250)
const UPSERT_CHUNK_SIZE = Number(process.env.REGISTRO_INTEL_LOCAL_UPSERT_CHUNK_SIZE || 50)
const RUT_CHUNK_SIZE = Number(process.env.REGISTRO_INTEL_LOCAL_RUT_CHUNK_SIZE || 500)

if (!LOCAL_URL || !LOCAL_SERVICE_KEY) {
  throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SECRET_KEY')
}

if (!REMOTE_URL || !REMOTE_SERVICE_KEY) {
  throw new Error('Faltan REGISTRO_INTEL_SUPABASE_URL o REGISTRO_INTEL_SERVICE_ROLE_KEY')
}

const local = createClient(LOCAL_URL, LOCAL_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const remote = createClient(REMOTE_URL, REMOTE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function toIsoDate(value) {
  if (!value) return null
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function maxIsoDate(...values) {
  return values.map(toIsoDate).filter(Boolean).sort().at(-1) ?? null
}

function normalizeRut(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const clean = String(value).replace(/[^\dKk]/g, '').toUpperCase()
  if (clean.length < 2) return null
  return clean.padStart(10, '0')
}

function normalizeEmail(value) {
  if (value === null || value === undefined) return null
  const normalized = String(value).trim().toLowerCase()
  return normalized || null
}

function normalizePhone(value) {
  if (value === null || value === undefined) return null
  const digits = String(value).replace(/\D/g, '')
  if (!digits) return null
  if (digits.length === 8) return `+569${digits}`
  if (digits.length === 9 && digits.startsWith('9')) return `+56${digits}`
  if (digits.length === 11 && digits.startsWith('56')) return `+${digits}`
  if (digits.startsWith('569')) return `+${digits}`
  return `+${digits}`
}

function lower(value) {
  return String(value ?? '').trim().toLowerCase()
}

function parseInteger(value) {
  if (value === null || value === undefined || value === '') return null
  const normalized = String(value).replace(/[^\d-]/g, '')
  return normalized === '' ? null : Number.parseInt(normalized, 10)
}

function normalizeOutcome(call) {
  const outcome = lower(call.outcome)
  const status = lower(call.status)
  if (outcome === 'sale') return 'sale'
  if (outcome === 'interested') return 'interested'
  if (outcome === 'callback') return 'callback'
  if (outcome === 'not_interested') return 'rejected'
  if (status === 'connected') return 'contacted'
  if (['no_answer', 'voicemail', 'busy', 'out_of_service'].includes(status)) return 'no_contact'
  return 'unknown'
}

function isEffectiveContact(call) {
  const outcome = lower(call.outcome)
  const status = lower(call.status)
  return status === 'connected' || ['interested', 'callback', 'sale', 'not_interested', 'other'].includes(outcome)
}

async function retry(label, fn, attempts = 4) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
      await new Promise(resolve => setTimeout(resolve, 400 * attempt))
    }
  }
  throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function fetchAll(table, select, buildQuery) {
  const rows = []
  for (let from = 0; ; from += BATCH_SIZE) {
    const data = await retry(`${table} batch ${from}`, async () => {
      let query = remote.from(table).select(select).range(from, from + BATCH_SIZE - 1)
      query = buildQuery(query)
      const { data, error } = await query
      if (error) throw error
      return data ?? []
    })

    rows.push(...data)
    if (data.length < BATCH_SIZE) break
  }
  return rows
}

async function fetchByIds(table, select, column, ids) {
  const unique = [...new Set(ids.filter(Boolean))]
  const map = new Map()

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const chunk = unique.slice(i, i + BATCH_SIZE)
    const rows = await retry(`${table} ${column} lookup`, async () => {
      const { data, error } = await remote.from(table).select(select).in(column, chunk)
      if (error) throw error
      return data ?? []
    })

    for (const row of rows) {
      map.set(row[column], row)
    }
  }

  return map
}

async function fetchPairMap(table, select, pairs) {
  const campaignIds = [...new Set(pairs.map(pair => pair.campaign_id).filter(Boolean))]
  const contactIds = [...new Set(pairs.map(pair => pair.contact_id).filter(Boolean))]
  const map = new Map()

  if (campaignIds.length === 0 || contactIds.length === 0) return map

  for (let i = 0; i < campaignIds.length; i += BATCH_SIZE) {
    for (let j = 0; j < contactIds.length; j += BATCH_SIZE) {
      const campaignChunk = campaignIds.slice(i, i + BATCH_SIZE)
      const contactChunk = contactIds.slice(j, j + BATCH_SIZE)
      const rows = await retry(`${table} pair lookup`, async () => {
        const { data, error } = await remote
          .from(table)
          .select(select)
          .in('campaign_id', campaignChunk)
          .in('contact_id', contactChunk)
        if (error) throw error
        return data ?? []
      })

      for (const row of rows) {
        map.set(`${row.campaign_id}:${row.contact_id}`, row)
      }
    }
  }

  return map
}

async function getLastCursor() {
  const override = process.env.REGISTRO_INTEL_DIRECT_FROM
  if (override) return new Date(override).toISOString()

  const { data, error } = await local
    .from('external_sync_runs')
    .select('cursor_value, completed_at')
    .eq('source_name', SOURCE_SYSTEM)
    .in('status', ['completed', 'partial'])
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`No pude leer cursor local: ${error.message}`)

  const cursor = data?.cursor_value ?? new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString()
  return new Date(new Date(cursor).getTime() - LOOKBACK_MINUTES * 60 * 1000).toISOString()
}

async function createRun(cursorStartedAt) {
  const { data, error } = await local
    .from('external_sync_runs')
    .insert({
      source_name: SOURCE_SYSTEM,
      source_kind: 'supabase_direct_tables',
      status: 'running',
      requested_from: cursorStartedAt,
      cursor_value: cursorStartedAt,
      metadata: {
        source_view: SOURCE_VIEW,
        sync_method: 'calls_direct_cross',
      },
    })
    .select('id')
    .single()

  if (error || !data) throw new Error(`No pude crear run de sync: ${error?.message}`)
  return data.id
}

async function updateRun(runId, payload) {
  const { error } = await local.from('external_sync_runs').update(payload).eq('id', runId)
  if (error) throw new Error(`No pude actualizar run ${runId}: ${error.message}`)
}

async function upsertLocal(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE)
    const { error } = await local.from(table).upsert(chunk, { onConflict })
    if (error) throw new Error(`Error upsert ${table}: ${error.message}`)
  }
}

async function fetchExistingMasterRuts(rutids) {
  const existing = new Set()
  const unique = [...new Set(rutids.filter(Boolean))]

  for (let i = 0; i < unique.length; i += RUT_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + RUT_CHUNK_SIZE)
    const { data, error } = await local.from('master_personas').select('rutid').in('rutid', chunk)
    if (error) throw new Error(`No pude validar RUTs locales: ${error.message}`)
    for (const row of data ?? []) {
      if (row.rutid) existing.add(row.rutid)
    }
  }

  return existing
}

async function refreshScoresForRutids(rutids) {
  const unique = [...new Set(rutids.filter(Boolean))]
  let refreshed = 0

  for (let i = 0; i < unique.length; i += RUT_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + RUT_CHUNK_SIZE)
    const { data, error } = await local.rpc('refresh_persona_scores', { p_rutids: chunk })
    if (error) throw new Error(`Refresh scoring falló: ${error.message}`)
    refreshed += Number(data ?? 0)
  }

  return refreshed
}

function mapFeedback(call, contact, campaign, profile, bestManagement, queue) {
  const rutid = normalizeRut(contact?.rut)
  const sourceUpdatedAt = maxIsoDate(
    call.last_telephony_event_at,
    call.telephony_ended_at,
    call.ended_at,
    call.started_at,
    call.created_at,
    queue?.updated_at,
    bestManagement?.updated_at
  )
  const outcome = normalizeOutcome(call)
  const effectiveContact = isEffectiveContact(call)

  return {
    external_source: SOURCE_SYSTEM,
    external_event_id: String(call.id),
    external_record_type: 'call',
    rutid,
    matched_rutid: rutid,
    match_method: rutid ? 'direct_rut' : null,
    contact_phone: normalizePhone(call.phone_number || contact?.phone_mobile || contact?.phone_contact || contact?.phone_normalized),
    contact_email: normalizeEmail(contact?.email),
    channel: lower(campaign?.campaign_channel) || 'phone',
    managed_at: toIsoDate(call.started_at || call.created_at),
    outcome,
    outcome_subtype: call.outcome,
    outcome_reason: call.reason,
    direction: lower(call.direction || 'outbound') || null,
    duration_seconds:
      parseInteger(call.telephony_duration_seconds) ??
      (call.ended_at && call.started_at
        ? Math.round((new Date(call.ended_at).getTime() - new Date(call.started_at).getTime()) / 1000)
        : null),
    talk_seconds: null,
    wait_seconds: null,
    agent_id: call.agent_id,
    agent_name: profile?.full_name ?? null,
    campaign_id: call.campaign_id,
    campaign_name: campaign?.name ?? null,
    opened_at: null,
    clicked_at: null,
    callback_at: lower(call.outcome) === 'callback' ? toIsoDate(call.next_action_at) : null,
    responded_at: null,
    sold_at: lower(call.outcome) === 'sale' ? toIsoDate(call.ended_at || call.started_at || call.created_at) : null,
    value_amount: null,
    mail_opened: false,
    clicked: false,
    callback_requested: lower(call.outcome) === 'callback',
    interested: lower(call.outcome) === 'interested',
    contacted: effectiveContact,
    effective_contact: effectiveContact,
    sale: lower(call.outcome) === 'sale',
    is_best_management: bestManagement?.best_call_id === call.id,
    raw_payload: {
      ...call,
      contact_name: contact?.full_name ?? null,
      company_name: contact?.full_name ?? null,
    },
    metadata: {
      source_view: SOURCE_VIEW,
      source_updated_at: sourceUpdatedAt,
      sync_method: 'calls_direct_cross',
    },
  }
}

function buildContactPoints(records, existingRuts) {
  const points = new Map()

  for (const record of records) {
    const rutid = record.matched_rutid ?? record.rutid
    if (!rutid || !existingRuts.has(rutid)) continue

    if (record.contact_phone) {
      points.set(`${rutid}:phone:${record.contact_phone}`, {
        rutid,
        contact_type: 'phone',
        contact_value: record.contact_phone,
        normalized_value: record.contact_phone,
        source_name: SOURCE_SYSTEM,
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
      points.set(`${rutid}:email:${record.contact_email}`, {
        rutid,
        contact_type: 'email',
        contact_value: record.contact_email,
        normalized_value: record.contact_email,
        source_name: SOURCE_SYSTEM,
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

  return [...points.values()]
}

function postgresConnectionString() {
  const raw = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || process.env.DATABASE_URL
  if (!raw) throw new Error('Falta POSTGRES_URL_NON_POOLING/POSTGRES_URL/DATABASE_URL')
  const url = new URL(raw)
  url.searchParams.delete('sslmode')
  return url.toString()
}

async function refreshBaseContactDataset() {
  const client = new Client({
    connectionString: postgresConnectionString(),
    ssl: { rejectUnauthorized: false },
  })

  await client.connect()
  try {
    await client.query('set statement_timeout = 0')
    const { rows } = await client.query('select public.refresh_base_contact_dataset() as result')
    return rows[0]?.result ?? null
  } finally {
    await client.end()
  }
}

async function main() {
  const fromIso = await getLastCursor()
  const runId = await createRun(fromIso)
  let fetched = 0
  let loaded = 0
  let refreshed = 0
  let maxCursor = fromIso

  try {
    const callsById = new Map()
    const callSelect = [
      'id',
      'contact_id',
      'agent_id',
      'campaign_id',
      'started_at',
      'ended_at',
      'status',
      'outcome',
      'reason',
      'next_action_at',
      'created_at',
      'direction',
      'phone_number',
      'telephony_ended_at',
      'telephony_duration_seconds',
      'last_telephony_event_at',
    ].join(',')

    for (const column of ['created_at', 'last_telephony_event_at']) {
      const rows = await fetchAll('calls', callSelect, query =>
        query.gte(column, fromIso).order(column, { ascending: true })
      )
      for (const row of rows) {
        callsById.set(row.id, row)
      }
    }

    const calls = [...callsById.values()].sort((a, b) => {
      const aDate = maxIsoDate(a.last_telephony_event_at, a.telephony_ended_at, a.ended_at, a.started_at, a.created_at) ?? ''
      const bDate = maxIsoDate(b.last_telephony_event_at, b.telephony_ended_at, b.ended_at, b.started_at, b.created_at) ?? ''
      return aDate.localeCompare(bDate)
    })
    fetched = calls.length

    const contacts = await fetchByIds(
      'contacts',
      'id,rut,full_name,email,phone_mobile,phone_contact,phone_normalized',
      'id',
      calls.map(call => call.contact_id)
    )
    const campaigns = await fetchByIds('campaigns', 'id,name,campaign_channel', 'id', calls.map(call => call.campaign_id))
    const profiles = await fetchByIds('profiles', 'user_id,full_name', 'user_id', calls.map(call => call.agent_id))
    const pairs = calls.map(call => ({ campaign_id: call.campaign_id, contact_id: call.contact_id }))
    const bestManagement = await fetchPairMap(
      'campaign_contact_best_management',
      'campaign_id,contact_id,best_call_id,updated_at',
      pairs
    )
    const queue = await fetchPairMap('campaign_contact_queue', 'campaign_id,contact_id,updated_at', pairs)

    const records = calls
      .map(call => {
        const key = `${call.campaign_id}:${call.contact_id}`
        return mapFeedback(
          call,
          contacts.get(call.contact_id),
          campaigns.get(call.campaign_id),
          profiles.get(call.agent_id),
          bestManagement.get(key),
          queue.get(key)
        )
      })
      .filter(record => record.external_event_id && record.managed_at)

    for (const record of records) {
      const rowCursor = record.metadata?.source_updated_at
      if (rowCursor && rowCursor > maxCursor) {
        maxCursor = rowCursor
      }
    }

    await upsertLocal('contact_center_feedback', records, 'external_source,external_event_id')
    loaded = records.length

    const existingRuts = await fetchExistingMasterRuts(records.map(record => record.matched_rutid ?? record.rutid))
    const contactPoints = buildContactPoints(records, existingRuts)
    await upsertLocal('persona_contact_points', contactPoints, 'rutid,contact_type,normalized_value')
    refreshed = await refreshScoresForRutids([...existingRuts])
    const dataset = await refreshBaseContactDataset()

    await updateRun(runId, {
      status: 'completed',
      cursor_value: maxCursor,
      records_fetched: fetched,
      records_loaded: loaded,
      affected_ruts: existingRuts.size,
      completed_at: new Date().toISOString(),
      metadata: {
        source_view: SOURCE_VIEW,
        sync_method: 'calls_direct_cross',
        refreshed_scores: refreshed,
        contact_points: contactPoints.length,
        dataset,
      },
    })

    console.log(JSON.stringify({
      ok: true,
      source_system: SOURCE_SYSTEM,
      source_view: SOURCE_VIEW,
      sync_method: 'calls_direct_cross',
      fetched,
      loaded,
      refreshed_scores: refreshed,
      affected_ruts: existingRuts.size,
      contact_points: contactPoints.length,
      cursor_started_at: fromIso,
      cursor_ended_at: maxCursor,
      dataset,
    }, null, 2))
  } catch (error) {
    await updateRun(runId, {
      status: loaded > 0 ? 'partial' : 'failed',
      cursor_value: maxCursor,
      records_fetched: fetched,
      records_loaded: loaded,
      completed_at: new Date().toISOString(),
      error_message: error instanceof Error ? error.message : 'Error desconocido',
    })
    throw error
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
