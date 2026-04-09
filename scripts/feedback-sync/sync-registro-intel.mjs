import { createClient } from '@supabase/supabase-js'

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
const CURSOR_COLUMN = process.env.REGISTRO_INTEL_CURSOR_COLUMN || 'source_updated_at'
const SOURCE_ID_COLUMN = process.env.REGISTRO_INTEL_SOURCE_ID_COLUMN || 'external_event_id'
const BATCH_SIZE = Number(process.env.REGISTRO_INTEL_BATCH_SIZE || process.env.REGISTRO_INTEL_PAGE_SIZE || 1000)
const LOOKBACK_MINUTES = Number(process.env.REGISTRO_INTEL_LOOKBACK_MINUTES || 10)
const LOCAL_UPSERT_CHUNK_SIZE = Number(process.env.REGISTRO_INTEL_LOCAL_UPSERT_CHUNK_SIZE || 500)
const LOCAL_RUT_CHUNK_SIZE = Number(process.env.REGISTRO_INTEL_LOCAL_RUT_CHUNK_SIZE || 1000)

if (!LOCAL_URL || !LOCAL_SERVICE_KEY) {
  throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SECRET_KEY para el proyecto local')
}

if (!REMOTE_URL || !REMOTE_SERVICE_KEY) {
  throw new Error('Faltan REGISTRO_INTEL_SUPABASE_URL o REGISTRO_INTEL_SERVICE_ROLE_KEY')
}

const local = createClient(LOCAL_URL, LOCAL_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const VALID_CHANNELS = new Set([
  'phone',
  'email',
  'whatsapp',
  'sms',
  'bot',
  'web',
  'in_person',
  'other',
])

const VALID_OUTCOMES = new Set([
  'contacted',
  'no_contact',
  'interested',
  'callback',
  'rejected',
  'sale',
  'opened',
  'clicked',
  'bounced',
  'do_not_contact',
  'unknown',
])

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

function parseBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  const normalized = String(value ?? '').trim().toLowerCase()
  return ['1', 'true', 't', 'yes', 'si', 'sí', 'y'].includes(normalized)
}

function parseInteger(value) {
  if (value === null || value === undefined || value === '') return null
  const normalized = String(value).replace(/[^\d-]/g, '')
  return normalized === '' ? null : Number.parseInt(normalized, 10)
}

function parseNumeric(value) {
  if (value === null || value === undefined || value === '') return null
  const str = String(value).trim()
  const sanitized = str.replace(/[^0-9,.\-]/g, '')
  if (!sanitized) return null

  if (sanitized.includes(',') && sanitized.includes('.')) {
    return Number(sanitized.replace(/\./g, '').replace(',', '.'))
  }

  if (sanitized.includes(',')) {
    return Number(sanitized.replace(/\./g, '').replace(',', '.'))
  }

  return Number(sanitized)
}

function coalesce(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
      return row[key]
    }
  }
  return null
}

function toIsoDate(value) {
  if (!value) return null
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function normalizeChannel(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return 'other'

  if (VALID_CHANNELS.has(normalized)) return normalized
  if (['call', 'phone_call', 'telefono', 'fono'].includes(normalized)) return 'phone'
  if (['correo', 'mail'].includes(normalized)) return 'email'
  if (['wsp', 'wa'].includes(normalized)) return 'whatsapp'
  if (['presencial'].includes(normalized)) return 'in_person'
  return 'other'
}

function normalizeOutcome(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return 'unknown'

  if (VALID_OUTCOMES.has(normalized)) return normalized
  if (['contacto', 'contactado', 'gestionado'].includes(normalized)) return 'contacted'
  if (['sin_contacto', 'no_contesta', 'no responde', 'no_contactado'].includes(normalized)) return 'no_contact'
  if (['interesado', 'interes'].includes(normalized)) return 'interested'
  if (['callback_requested', 'rellamar', 'agendar_callback'].includes(normalized)) return 'callback'
  if (['rechazado', 'rechazo'].includes(normalized)) return 'rejected'
  if (['venta', 'sold'].includes(normalized)) return 'sale'
  if (['open', 'abierto'].includes(normalized)) return 'opened'
  if (['click'].includes(normalized)) return 'clicked'
  if (['bounce', 'rebotado'].includes(normalized)) return 'bounced'
  if (['do_not_call', 'do_not_contact', 'blacklist', 'opt_out'].includes(normalized)) return 'do_not_contact'
  return 'unknown'
}

function mapRow(row) {
  const externalEventId = coalesce(row, [SOURCE_ID_COLUMN, 'external_event_id', 'source_record_id', 'id', 'gestion_id', 'call_id', 'event_id'])
  const managedAt = coalesce(row, ['managed_at', 'gestion_at', 'event_at', 'created_at', 'occurred_at', 'fecha_gestion'])
  const sourceUpdatedAt = coalesce(row, [CURSOR_COLUMN, 'source_updated_at', 'updated_at', 'synced_at', 'modified_at', 'fecha_actualizacion'])

  if (!externalEventId || !managedAt) {
    return null
  }

  const rutid = normalizeRut(coalesce(row, ['rutid', 'rut', 'lead_rut', 'customer_rut']))
  const matchedRutid = normalizeRut(coalesce(row, ['matched_rutid', 'resolved_rutid']))
  const outcome = normalizeOutcome(coalesce(row, ['outcome', 'resultado', 'status']))
  const openedAt = toIsoDate(coalesce(row, ['opened_at', 'fecha_apertura']))
  const clickedAt = toIsoDate(coalesce(row, ['clicked_at', 'fecha_click']))
  const callbackAt = toIsoDate(coalesce(row, ['callback_at', 'fecha_callback']))
  const respondedAt = toIsoDate(coalesce(row, ['responded_at', 'fecha_respuesta']))
  const soldAt = toIsoDate(coalesce(row, ['sold_at', 'fecha_venta']))

  return {
    external_source: SOURCE_SYSTEM,
    external_event_id: String(externalEventId),
    external_record_type: coalesce(row, ['external_record_type', 'record_type', 'tipificacion', 'gestion_type']),
    rutid,
    matched_rutid: matchedRutid,
    match_method: coalesce(row, ['match_method']) ?? (matchedRutid ? 'crm_match' : rutid ? 'direct_rut' : null),
    contact_phone: normalizePhone(coalesce(row, ['contact_phone', 'phone_raw', 'phone', 'telefono', 'fono', 'mobile'])),
    contact_email: normalizeEmail(coalesce(row, ['contact_email', 'email_raw', 'email', 'correo', 'mail'])),
    channel: normalizeChannel(coalesce(row, ['channel', 'canal'])),
    managed_at: toIsoDate(managedAt),
    outcome,
    outcome_subtype: coalesce(row, ['outcome_subtype', 'suboutcome', 'subtipo_resultado', 'substatus']),
    outcome_reason: coalesce(row, ['outcome_reason', 'rejection_reason', 'motivo_rechazo', 'reason']),
    direction: coalesce(row, ['direction', 'sentido'])?.toString().toLowerCase() ?? null,
    duration_seconds: parseInteger(coalesce(row, ['duration_seconds', 'duration', 'duracion'])),
    talk_seconds: parseInteger(coalesce(row, ['talk_seconds', 'talk_time_seconds', 'tiempo_habla'])),
    wait_seconds: parseInteger(coalesce(row, ['wait_seconds', 'tiempo_espera'])),
    agent_id: coalesce(row, ['agent_id', 'user_id', 'asesor_id']),
    agent_name: coalesce(row, ['agent_name', 'agent', 'asesor', 'owner_name']),
    campaign_id: coalesce(row, ['campaign_id', 'campaign', 'campana_id']),
    campaign_name: coalesce(row, ['campaign_name', 'campana', 'campaign_label']),
    opened_at: openedAt,
    clicked_at: clickedAt,
    callback_at: callbackAt,
    responded_at: respondedAt,
    sold_at: soldAt,
    value_amount: parseNumeric(coalesce(row, ['value_amount', 'sale_amount', 'monto', 'valor', 'amount'])),
    mail_opened: parseBoolean(coalesce(row, ['mail_opened', 'opened', 'email_opened'])) || Boolean(openedAt) || outcome === 'opened',
    clicked: parseBoolean(coalesce(row, ['clicked', 'click', 'email_clicked'])) || Boolean(clickedAt) || outcome === 'clicked',
    callback_requested: parseBoolean(coalesce(row, ['callback_requested', 'callback', 'agendar_callback'])) || Boolean(callbackAt) || outcome === 'callback',
    interested: parseBoolean(coalesce(row, ['interested'])) || outcome === 'interested',
    contacted: parseBoolean(coalesce(row, ['contacted'])) || ['contacted', 'interested', 'callback', 'sale'].includes(outcome),
    effective_contact: parseBoolean(coalesce(row, ['effective_contact', 'contact_effective', 'contacto_efectivo'])) || ['contacted', 'interested', 'callback', 'sale'].includes(outcome),
    sale: parseBoolean(coalesce(row, ['sale', 'venta', 'sold'])) || Boolean(soldAt) || outcome === 'sale',
    is_best_management: parseBoolean(coalesce(row, ['is_best_management'])),
    raw_payload: row,
    metadata: {
      source_view: SOURCE_VIEW,
      source_updated_at: toIsoDate(sourceUpdatedAt),
    },
  }
}

function buildRemoteUrl(fromIso, offset) {
  const url = new URL(`/rest/v1/${SOURCE_VIEW}`, REMOTE_URL)
  url.searchParams.set('select', '*')
  url.searchParams.set(CURSOR_COLUMN, `gte.${fromIso}`)
  url.searchParams.set('order', `${CURSOR_COLUMN}.asc,${SOURCE_ID_COLUMN}.asc`)
  url.searchParams.set('limit', String(BATCH_SIZE))
  url.searchParams.set('offset', String(offset))
  return url
}

async function getLastCursor() {
  const { data, error } = await local
    .from('external_sync_runs')
    .select('cursor_value, completed_at')
    .eq('source_name', SOURCE_SYSTEM)
    .in('status', ['completed', 'partial'])
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`No pude leer cursor local: ${error.message}`)
  }

  if (!data?.cursor_value) {
    return new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString()
  }

  return new Date(new Date(data.cursor_value).getTime() - LOOKBACK_MINUTES * 60 * 1000).toISOString()
}

async function createRun(cursorStartedAt) {
  const { data, error } = await local
    .from('external_sync_runs')
    .insert({
      source_name: SOURCE_SYSTEM,
      source_kind: 'supabase_rest',
      status: 'running',
      requested_from: cursorStartedAt,
      cursor_value: cursorStartedAt,
      metadata: {
        source_view: SOURCE_VIEW,
        cursor_column: CURSOR_COLUMN,
        source_id_column: SOURCE_ID_COLUMN,
      },
    })
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(`No pude crear run de sync: ${error?.message}`)
  }

  return data.id
}

async function updateRun(runId, payload) {
  const { error } = await local
    .from('external_sync_runs')
    .update(payload)
    .eq('id', runId)

  if (error) {
    throw new Error(`No pude actualizar run ${runId}: ${error.message}`)
  }
}

async function fetchBatch(fromIso, offset) {
  const response = await fetch(buildRemoteUrl(fromIso, offset), {
    headers: {
      apikey: REMOTE_SERVICE_KEY,
      Authorization: `Bearer ${REMOTE_SERVICE_KEY}`,
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Error leyendo ${SOURCE_VIEW} en registro-intel: ${response.status} ${errorText}`)
  }

  return response.json()
}

async function fetchExistingMasterRuts(rutids) {
  const existing = new Set()
  const unique = [...new Set(rutids.filter(Boolean))]

  for (let i = 0; i < unique.length; i += LOCAL_RUT_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + LOCAL_RUT_CHUNK_SIZE)
    const { data, error } = await local
      .from('master_personas')
      .select('rutid')
      .in('rutid', chunk)

    if (error) {
      throw new Error(`No pude validar RUTs locales: ${error.message}`)
    }

    for (const row of data ?? []) {
      if (row.rutid) existing.add(row.rutid)
    }
  }

  return existing
}

function buildContactPoints(records, existingRuts) {
  const points = new Map()

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
      const key = `${rutid}:email:${record.contact_email}`
      points.set(key, {
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

async function upsertFeedbackBatch(records) {
  for (let i = 0; i < records.length; i += LOCAL_UPSERT_CHUNK_SIZE) {
    const chunk = records.slice(i, i + LOCAL_UPSERT_CHUNK_SIZE)
    const { error } = await local
      .from('contact_center_feedback')
      .upsert(chunk, { onConflict: 'external_source,external_event_id' })

    if (error) {
      throw new Error(`Error upsert local feedback: ${error.message}`)
    }
  }
}

async function upsertContactPointsBatch(records) {
  if (records.length === 0) return

  for (let i = 0; i < records.length; i += LOCAL_UPSERT_CHUNK_SIZE) {
    const chunk = records.slice(i, i + LOCAL_UPSERT_CHUNK_SIZE)
    const { error } = await local
      .from('persona_contact_points')
      .upsert(chunk, { onConflict: 'rutid,contact_type,normalized_value' })

    if (error) {
      throw new Error(`Error upsert local contact points: ${error.message}`)
    }
  }
}

async function refreshScoresForRutids(rutids) {
  const unique = [...new Set(rutids.filter(Boolean))]
  if (unique.length === 0) return 0

  let refreshed = 0

  for (let i = 0; i < unique.length; i += LOCAL_RUT_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + LOCAL_RUT_CHUNK_SIZE)
    const { data, error } = await local.rpc('refresh_persona_scores', {
      p_rutids: chunk,
    })

    if (error) {
      throw new Error(`Refresh scoring falló: ${error.message}`)
    }

    refreshed += Number(data ?? 0)
  }

  return refreshed
}

async function main() {
  const fromIso = await getLastCursor()
  const runId = await createRun(fromIso)

  let offset = 0
  let fetched = 0
  let loaded = 0
  let refreshed = 0
  let maxCursor = fromIso
  const affectedRuts = new Set()

  try {
    for (;;) {
      const remoteRows = await fetchBatch(fromIso, offset)
      if (!Array.isArray(remoteRows) || remoteRows.length === 0) break

      const mappedRows = remoteRows
        .map(mapRow)
        .filter(Boolean)

      if (mappedRows.length > 0) {
        await upsertFeedbackBatch(mappedRows)
        loaded += mappedRows.length

        const batchRutids = mappedRows
          .map(row => row.matched_rutid ?? row.rutid)
          .filter(Boolean)

        const existingRuts = await fetchExistingMasterRuts(batchRutids)
        const contactPoints = buildContactPoints(mappedRows, existingRuts)
        await upsertContactPointsBatch(contactPoints)

        for (const rutid of existingRuts) {
          affectedRuts.add(rutid)
        }

        refreshed += await refreshScoresForRutids([...existingRuts])

        for (const row of mappedRows) {
          const rowCursor = row.metadata?.source_updated_at
          if (rowCursor && rowCursor > maxCursor) {
            maxCursor = rowCursor
          }
        }
      }

      fetched += remoteRows.length
      offset += remoteRows.length

      await updateRun(runId, {
        cursor_value: maxCursor,
        records_fetched: fetched,
        records_loaded: loaded,
        affected_ruts: affectedRuts.size,
      })

      if (remoteRows.length < BATCH_SIZE) break
    }

    await updateRun(runId, {
      status: loaded > 0 ? 'completed' : 'partial',
      cursor_value: maxCursor,
      records_fetched: fetched,
      records_loaded: loaded,
      affected_ruts: affectedRuts.size,
      completed_at: new Date().toISOString(),
      metadata: {
        source_view: SOURCE_VIEW,
        cursor_column: CURSOR_COLUMN,
        source_id_column: SOURCE_ID_COLUMN,
        refreshed_scores: refreshed,
      },
    })

    console.log(JSON.stringify({
      ok: true,
      source_system: SOURCE_SYSTEM,
      source_view: SOURCE_VIEW,
      fetched,
      loaded,
      refreshed_scores: refreshed,
      affected_ruts: affectedRuts.size,
      cursor_started_at: fromIso,
      cursor_ended_at: maxCursor,
    }, null, 2))
  } catch (error) {
    await updateRun(runId, {
      status: loaded > 0 ? 'partial' : 'failed',
      cursor_value: maxCursor,
      records_fetched: fetched,
      records_loaded: loaded,
      affected_ruts: affectedRuts.size,
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
