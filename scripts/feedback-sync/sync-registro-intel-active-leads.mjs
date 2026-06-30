import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import pg from 'pg'

const { Client } = pg

const LOCAL_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const LOCAL_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
const REMOTE_URL = process.env.REGISTRO_INTEL_SUPABASE_URL
const REMOTE_SERVICE_KEY =
  process.env.REGISTRO_INTEL_SERVICE_ROLE_KEY ||
  process.env.REGISTRO_INTEL_SUPABASE_SERVICE_ROLE_KEY

const SOURCE_SYSTEM = 'registro_intel_active_leads'
const BATCH_SIZE = Number(process.env.REGISTRO_INTEL_ACTIVE_LEADS_BATCH_SIZE || 1000)
const UPSERT_CHUNK_SIZE = Number(process.env.REGISTRO_INTEL_LOCAL_UPSERT_CHUNK_SIZE || 100)
const LOOKBACK_MINUTES = Number(process.env.REGISTRO_INTEL_ACTIVE_LEADS_LOOKBACK_MINUTES || 15)
const DIRECT_FROM = process.env.REGISTRO_INTEL_ACTIVE_LEADS_FROM
const DIRECT_TO = process.env.REGISTRO_INTEL_ACTIVE_LEADS_TO
  ? new Date(process.env.REGISTRO_INTEL_ACTIVE_LEADS_TO).toISOString()
  : null

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

function postgresConnectionString() {
  const raw = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || process.env.DATABASE_URL
  if (!raw) throw new Error('Falta POSTGRES_URL_NON_POOLING/POSTGRES_URL/DATABASE_URL')
  const url = new URL(raw)
  url.searchParams.delete('sslmode')
  return url.toString()
}

function toIsoDate(value) {
  if (!value) return null
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function normalizeRut(value) {
  const clean = String(value ?? '').replace(/[^0-9Kk]/g, '').toUpperCase()
  if (clean.length < 2) return null
  return clean.padStart(10, '0')
}

function normalizePhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.length === 8) return `+569${digits}`
  if (digits.length === 9 && digits.startsWith('9')) return `+56${digits}`
  if (digits.length === 10 && digits.startsWith('0')) return `+56${digits.slice(1)}`
  if (digits.length === 11 && digits.startsWith('56')) return `+${digits}`
  if (digits.startsWith('569')) return `+${digits}`
  return null
}

function normalizeEmail(value) {
  const candidates = Array.isArray(value) ? value : String(value ?? '').split(/[,\s|;]+/)
  for (const candidate of candidates) {
    const email = String(candidate).trim().toLowerCase()
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email
  }
  return null
}

function normalizeText(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized || null
}

function extractPhones(row) {
  const payload = row.source_payload ?? {}
  const values = [
    payload.mejor_telefono,
    payload.telefono,
    payload.telefono_raw,
    payload.phone,
    payload.phone_normalized,
    payload.phone_mobile,
    payload.telefonos,
    payload.telefonos_raw,
  ]

  const phones = new Set()
  for (const value of values) {
    const items = Array.isArray(value) ? value : String(value ?? '').split(/[,\s|;/]+/)
    for (const item of items) {
      const phone = normalizePhone(item)
      if (phone) phones.add(phone)
    }
  }
  return [...phones]
}

function extractEmails(row) {
  const payload = row.source_payload ?? {}
  return [
    row.mail,
    payload.correo,
    payload.email,
    payload.mail,
    payload.emails,
  ].map(normalizeEmail).filter(Boolean)
}

function displayName(row) {
  const payload = row.source_payload ?? {}
  return normalizeText(row.nombre_cliente)
    ?? normalizeText(row.razon_social)
    ?? normalizeText(payload.nombre_comercial)
    ?? normalizeText(payload.razon_social_empresa)
}

async function getLastCursor() {
  if (DIRECT_FROM) return new Date(DIRECT_FROM).toISOString()

  const { data, error } = await local
    .from('external_sync_runs')
    .select('cursor_value, completed_at')
    .eq('source_name', SOURCE_SYSTEM)
    .in('status', ['completed', 'partial'])
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`No pude leer cursor local: ${error.message}`)

  const cursor = data?.cursor_value ?? new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString()
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
      requested_to: DIRECT_TO,
      cursor_value: cursorStartedAt,
      metadata: {
        source_table: 'registro_intel.campaign_base_leads',
        sync_method: 'active_leads_to_contact_points',
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

async function fetchLeads(fromIso) {
  const rows = []
  const select = [
    'id',
    'rut_empresa',
    'nombre_cliente',
    'razon_social',
    'mail',
    'assignment_status',
    'workflow_status',
    'last_outcome',
    'updated_at',
    'source_external_key',
    'source_payload',
  ].join(',')

  for (let from = 0; ; from += BATCH_SIZE) {
    let query = remote
      .from('campaign_base_leads')
      .select(select)
      .gte('updated_at', fromIso)
      .order('updated_at', { ascending: true })
      .range(from, from + BATCH_SIZE - 1)

    if (DIRECT_TO) query = query.lte('updated_at', DIRECT_TO)

    const { data, error } = await query
    if (error) throw new Error(`No pude leer campaign_base_leads: ${error.message}`)

    rows.push(...(data ?? []))
    if (!data || data.length < BATCH_SIZE) break
  }

  return rows
}

async function fetchExistingMasterRuts(rutids) {
  const existing = new Set()
  const unique = [...new Set(rutids.filter(Boolean))]

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const chunk = unique.slice(i, i + BATCH_SIZE)
    const { data, error } = await local.from('master_personas').select('rutid').in('rutid', chunk)
    if (error) throw new Error(`No pude validar RUTs locales: ${error.message}`)
    for (const row of data ?? []) {
      if (row.rutid) existing.add(row.rutid)
    }
  }

  return existing
}

function buildContactPoints(leads, existingRuts) {
  const points = new Map()

  for (const row of leads) {
    const rutid = normalizeRut(row.rut_empresa)
    if (!rutid || !existingRuts.has(rutid)) continue

    const metadata = {
      campaign_base_lead_id: row.id,
      source_external_key: row.source_external_key,
      assignment_status: row.assignment_status,
      workflow_status: row.workflow_status,
      last_outcome: row.last_outcome,
      display_name: displayName(row),
    }

    for (const phone of extractPhones(row)) {
      points.set(`${rutid}:phone:${phone}`, {
        rutid,
        contact_type: 'phone',
        contact_value: phone,
        normalized_value: phone,
        source_name: 'registro_intel.campaign_base_leads',
        source_priority: 18,
        quality_score: row.last_outcome === 'callback' ? 82 : 76,
        is_primary: true,
        is_verified: false,
        last_seen_at: toIsoDate(row.updated_at),
        last_feedback_at: null,
        metadata,
      })
    }

    for (const email of extractEmails(row)) {
      points.set(`${rutid}:email:${email}`, {
        rutid,
        contact_type: 'email',
        contact_value: email,
        normalized_value: email,
        source_name: 'registro_intel.campaign_base_leads',
        source_priority: 22,
        quality_score: 70,
        is_primary: false,
        is_verified: false,
        last_seen_at: toIsoDate(row.updated_at),
        last_feedback_at: null,
        metadata,
      })
    }
  }

  return [...points.values()]
}

function sqlValue(value) {
  if (value === undefined) return null
  if (value && typeof value === 'object' && !(value instanceof Date)) return JSON.stringify(value)
  return value
}

async function upsertContactPoints(points) {
  if (points.length === 0) return 0

  const client = new Client({
    connectionString: postgresConnectionString(),
    ssl: { rejectUnauthorized: false },
  })
  await client.connect()

  try {
    const columns = Object.keys(points[0])
    let upserted = 0

    for (let i = 0; i < points.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = points.slice(i, i + UPSERT_CHUNK_SIZE)
      const values = []
      const tuples = chunk.map((row, rowIndex) => {
        const placeholders = columns.map((column, columnIndex) => {
          values.push(sqlValue(row[column]))
          return `$${rowIndex * columns.length + columnIndex + 1}`
        })
        return `(${placeholders.join(', ')})`
      })

      const result = await client.query(
        `insert into public.persona_contact_points (${columns.join(', ')})
         values ${tuples.join(', ')}
         on conflict (rutid, contact_type, normalized_value) do update set
           contact_value = excluded.contact_value,
           source_name = excluded.source_name,
           source_priority = least(public.persona_contact_points.source_priority, excluded.source_priority),
           quality_score = greatest(public.persona_contact_points.quality_score, excluded.quality_score),
           is_primary = public.persona_contact_points.is_primary or excluded.is_primary,
           is_verified = public.persona_contact_points.is_verified or excluded.is_verified,
           last_seen_at = greatest(public.persona_contact_points.last_seen_at, excluded.last_seen_at),
           metadata = public.persona_contact_points.metadata || excluded.metadata,
           updated_at = now()`,
        values
      )
      upserted += result.rowCount
    }

    return upserted
  } finally {
    await client.end()
  }
}

async function refreshScoresForRutids(rutids) {
  const unique = [...new Set(rutids.filter(Boolean))]
  let refreshed = 0

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const chunk = unique.slice(i, i + BATCH_SIZE)
    const { data, error } = await local.rpc('refresh_persona_scores', { p_rutids: chunk })
    if (error) throw new Error(`Refresh scoring falló: ${error.message}`)
    refreshed += Number(data ?? 0)
  }

  return refreshed
}

async function main() {
  const fromIso = await getLastCursor()
  const runId = await createRun(fromIso)
  const startedAt = new Date().toISOString()

  let fetched = 0
  let contactPoints = 0
  let upserted = 0
  let refreshed = 0
  let maxCursor = fromIso

  try {
    const leads = await fetchLeads(fromIso)
    fetched = leads.length

    for (const row of leads) {
      const updatedAt = toIsoDate(row.updated_at)
      if (updatedAt && updatedAt > maxCursor) maxCursor = updatedAt
    }

    const rutids = leads.map(row => normalizeRut(row.rut_empresa)).filter(Boolean)
    const existingRuts = await fetchExistingMasterRuts(rutids)
    const points = buildContactPoints(leads, existingRuts)
    contactPoints = points.length
    upserted = await upsertContactPoints(points)
    refreshed = await refreshScoresForRutids([...new Set(points.map(point => point.rutid))])

    await updateRun(runId, {
      status: 'completed',
      cursor_value: maxCursor,
      completed_at: new Date().toISOString(),
      records_fetched: fetched,
      records_loaded: upserted,
      affected_ruts: new Set(points.map(point => point.rutid)).size,
      metadata: {
        source_table: 'registro_intel.campaign_base_leads',
        sync_method: 'active_leads_to_contact_points',
        started_at: startedAt,
        contact_points: contactPoints,
        refreshed_scores: refreshed,
      },
    })

    console.log(JSON.stringify({
      ok: true,
      fetched,
      contact_points: contactPoints,
      upserted,
      refreshed_scores: refreshed,
      cursor: maxCursor,
    }, null, 2))
  } catch (error) {
    await updateRun(runId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      records_fetched: fetched,
      records_loaded: upserted,
      error_message: error instanceof Error ? error.message : String(error),
      metadata: {
        source_table: 'registro_intel.campaign_base_leads',
        sync_method: 'active_leads_to_contact_points',
        started_at: startedAt,
        contact_points: contactPoints,
        refreshed_scores: refreshed,
      },
    })
    throw error
  }
}

await main()
