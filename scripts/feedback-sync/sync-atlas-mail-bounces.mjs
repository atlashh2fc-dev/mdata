import { createClient } from '@supabase/supabase-js'

const LOCAL_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const LOCAL_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
const REMOTE_URL = process.env.REGISTRO_INTEL_SUPABASE_URL
const REMOTE_SERVICE_KEY =
  process.env.REGISTRO_INTEL_SERVICE_ROLE_KEY ||
  process.env.REGISTRO_INTEL_SUPABASE_SERVICE_ROLE_KEY

const SOURCE_NAME = process.env.ATLAS_MAIL_BOUNCES_SOURCE_NAME || 'atlas_mail_bounces'
const REMOTE_TABLE = process.env.ATLAS_MAIL_BOUNCES_REMOTE_TABLE || 'mail_result_contacts'
const BATCH_SIZE = Number(process.env.ATLAS_MAIL_BOUNCES_BATCH_SIZE || 1000)
const LOCAL_UPSERT_CHUNK_SIZE = Number(process.env.ATLAS_MAIL_BOUNCES_LOCAL_UPSERT_CHUNK_SIZE || 500)

if (!LOCAL_URL || !LOCAL_SERVICE_KEY) {
  throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SECRET_KEY')
}

if (!REMOTE_URL || !REMOTE_SERVICE_KEY) {
  throw new Error('Faltan REGISTRO_INTEL_SUPABASE_URL o REGISTRO_INTEL_SERVICE_ROLE_KEY')
}

const local = createClient(LOCAL_URL, LOCAL_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function normalizeEmail(value) {
  if (value === null || value === undefined) return null
  const normalized = String(value).trim().toLowerCase()
  return normalized.includes('@') ? normalized : null
}

function toIsoDate(value) {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function buildRemoteUrl(offset) {
  const url = new URL(`/rest/v1/${REMOTE_TABLE}`, REMOTE_URL)
  url.searchParams.set(
    'select',
    'id,batch_id,campaign_id,email,email_normalized,full_name,estado,estado_ses,sent,delivered,bounced,opened,clicked,complained,unsubscribed,raw,created_at'
  )
  url.searchParams.set('bounced', 'eq.true')
  url.searchParams.set('email_normalized', 'not.is.null')
  url.searchParams.set('order', 'created_at.asc,id.asc')
  url.searchParams.set('limit', String(BATCH_SIZE))
  url.searchParams.set('offset', String(offset))
  return url
}

async function fetchRemoteBatch(offset) {
  const response = await fetch(buildRemoteUrl(offset), {
    headers: {
      apikey: REMOTE_SERVICE_KEY,
      Authorization: `Bearer ${REMOTE_SERVICE_KEY}`,
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Error leyendo ${REMOTE_TABLE}: ${response.status} ${errorText}`)
  }

  return response.json()
}

async function createRun() {
  const { data, error } = await local
    .from('external_sync_runs')
    .insert({
      source_name: SOURCE_NAME,
      source_kind: 'supabase_rest',
      status: 'running',
      metadata: {
        remote_table: REMOTE_TABLE,
        remote_source: 'registro_intel',
      },
    })
    .select('id')
    .single()

  if (error || !data) throw new Error(`No pude crear run: ${error?.message}`)
  return data.id
}

async function updateRun(runId, payload) {
  const { error } = await local
    .from('external_sync_runs')
    .update(payload)
    .eq('id', runId)

  if (error) throw new Error(`No pude actualizar run ${runId}: ${error.message}`)
}

function mapRow(row) {
  const email = normalizeEmail(row.email_normalized ?? row.email)
  if (!email) return null

  const createdAt = toIsoDate(row.created_at) ?? new Date().toISOString()
  const rawPayload = row.raw && typeof row.raw === 'object' ? row.raw : {}

  return {
    external_source: 'atlas_lead_engine',
    external_event_id: `mail_result_contact:${row.id}`,
    external_record_type: 'mail_result_contact',
    rutid: null,
    matched_rutid: null,
    match_method: 'crm_mail_result_contacts',
    contact_phone: null,
    contact_email: email,
    channel: 'email',
    managed_at: createdAt,
    outcome: 'bounced',
    outcome_subtype: row.estado_ses ?? 'email_bounce',
    outcome_reason: 'CRM mail_result_contacts bounced=true',
    direction: 'outbound',
    agent_id: null,
    agent_name: 'Atlas Lead Engine',
    campaign_id: row.campaign_id ?? null,
    campaign_name: rawPayload.campaign_name ?? rawPayload.campaignName ?? 'Atlas Lead',
    mail_opened: Boolean(row.opened),
    clicked: Boolean(row.clicked),
    raw_payload: row,
    metadata: {
      source_view: `${REMOTE_TABLE}_bounced`,
      source_updated_at: createdAt,
      bridge_source: 'atlas_lead_engine',
      source_batch_id: row.batch_id ?? null,
      source_contact_full_name: row.full_name ?? null,
      source_estado: row.estado ?? null,
      source_estado_ses: row.estado_ses ?? null,
      sent: Boolean(row.sent),
      delivered: Boolean(row.delivered),
      bounced: Boolean(row.bounced),
      complained: Boolean(row.complained),
      unsubscribed: Boolean(row.unsubscribed),
    },
  }
}

async function upsertFeedback(records) {
  for (let i = 0; i < records.length; i += LOCAL_UPSERT_CHUNK_SIZE) {
    const chunk = records.slice(i, i + LOCAL_UPSERT_CHUNK_SIZE)
    const { error } = await local
      .from('contact_center_feedback')
      .upsert(chunk, { onConflict: 'external_source,external_event_id' })

    if (error) throw new Error(`Error upsert feedback: ${error.message}`)
  }
}

async function refreshBlacklistMetadata() {
  const { error } = await local.rpc('refresh_contact_blacklist_dataset_metadata')
  if (error) {
    console.warn(`[${SOURCE_NAME}] No pude refrescar metadata de blacklist: ${error.message}`)
  }
}

async function main() {
  const runId = await createRun()
  let offset = 0
  let fetched = 0
  let loaded = 0
  let maxCursor = null

  try {
    for (;;) {
      const remoteRows = await fetchRemoteBatch(offset)
      if (!Array.isArray(remoteRows) || remoteRows.length === 0) break

      fetched += remoteRows.length
      const mapped = remoteRows.map(mapRow).filter(Boolean)
      if (mapped.length > 0) {
        await upsertFeedback(mapped)
        loaded += mapped.length
        for (const row of mapped) {
          if (!maxCursor || row.managed_at > maxCursor) maxCursor = row.managed_at
        }
      }

      offset += remoteRows.length
      await updateRun(runId, {
        records_fetched: fetched,
        records_loaded: loaded,
        cursor_value: maxCursor,
      })

      if (remoteRows.length < BATCH_SIZE) break
    }

    await refreshBlacklistMetadata()

    await updateRun(runId, {
      status: 'completed',
      records_fetched: fetched,
      records_loaded: loaded,
      cursor_value: maxCursor,
      completed_at: new Date().toISOString(),
      metadata: {
        remote_table: REMOTE_TABLE,
        remote_source: 'registro_intel',
        fetched_bounced_contacts: fetched,
      },
    })

    console.log(JSON.stringify({ ok: true, fetched, loaded, cursor: maxCursor }, null, 2))
  } catch (error) {
    await updateRun(runId, {
      status: loaded > 0 ? 'partial' : 'failed',
      records_fetched: fetched,
      records_loaded: loaded,
      cursor_value: maxCursor,
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
