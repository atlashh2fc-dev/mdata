import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import Papa from 'papaparse'
import { createClient } from '@supabase/supabase-js'

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.production')

const INPUT_CSV = process.argv.find(arg => arg.startsWith('--input='))?.split('=').slice(1).join('=')
  || path.join(process.cwd(), 'outputs', 'bdd_equifax_gestiones_2026-05-07', 'BDD_pendientes_sin_gestion_target_limpio_con_colores.csv')
const CAMPAIGN_NAME = process.argv.find(arg => arg.startsWith('--campaign-name='))?.split('=').slice(1).join('=')
  || 'Equifax'
const SOURCE_SYSTEM = 'rut_intelligence_equifax_productive'
const SOURCE_KEY_PREFIX = 'equifax_productive_20260507'
const CREATED_BY = process.env.REGISTRO_INTEL_DEFAULT_USER_ID || '14f638a7-9cfe-4502-94e6-9c7d1e7aa1c3'
const CHUNK_SIZE = 200
const DRY_RUN = process.argv.includes('--dry-run')

const url = process.env.REGISTRO_INTEL_SUPABASE_URL
const key = process.env.REGISTRO_INTEL_SERVICE_ROLE_KEY || process.env.REGISTRO_INTEL_SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) throw new Error('Faltan credenciales REGISTRO_INTEL para cargar CRM.')
if (!fs.existsSync(INPUT_CSV)) throw new Error(`No existe input: ${INPUT_CSV}`)

const crm = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function chunk(items, size = CHUNK_SIZE) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

async function withRetry(label, operation, retries = 4) {
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)))
    }
  }
  throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

function uniqueStrings(values) {
  return [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))]
}

function normalizeRut(value) {
  return String(value ?? '').toUpperCase().replace(/[^0-9K]/g, '').replace(/^0+/, '') || null
}

function formatRut(value) {
  const rut = normalizeRut(value)
  if (!rut || rut.length < 2) return String(value ?? '')
  return `${rut.slice(0, -1)}-${rut.slice(-1)}`
}

function normalizePhone(value) {
  let digits = String(value ?? '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (!digits.startsWith('56')) {
    if (digits.length === 9) digits = `56${digits}`
    else if (digits.length === 8) digits = `562${digits}`
  }
  return digits.length >= 10 ? `+${digits}` : null
}

function phoneVariants(value) {
  const normalized = normalizePhone(value)
  if (!normalized) return []
  const digits = normalized.replace(/\D/g, '')
  const variants = [normalized, digits]
  if (digits.startsWith('56') && digits.length > 9) variants.push(digits.slice(-9))
  return uniqueStrings(variants)
}

function mobilePhone(value) {
  const phone = normalizePhone(value)
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  return digits.startsWith('569') ? digits.slice(-9) : null
}

function toNumber(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : 0
}

function priorityBucket(row) {
  const color = String(row.color_equifax ?? '').toLowerCase()
  if (color === 'green') return 1
  if (color === 'yellow') return 2
  return 4
}

function priorityScore(row) {
  const leadScore = toNumber(row.lead_score)
  const contact = toNumber(row.contact_probability)
  const purchase = toNumber(row.purchase_probability)
  const colorBoost = row.color_equifax === 'green' ? 200 : row.color_equifax === 'yellow' ? 100 : 0
  return Math.round(colorBoost + leadScore + contact * 0.25 + purchase * 0.25)
}

function sourceKey(rutid) {
  return `${SOURCE_KEY_PREFIX}:${normalizeRut(rutid)}`
}

function displayName(row) {
  return row.razon_social_empresa || row.nombre_completo || row.rut_formateado || row.rutid
}

function sourcePayload(row) {
  return {
    source_system: SOURCE_SYSTEM,
    loaded_at: new Date().toISOString(),
    input_file: path.basename(INPUT_CSV),
    original_row: row.fila_origen,
    rutid: row.rutid,
    rut_formateado: row.rut_formateado,
    color_equifax: row.color_equifax,
    lead_score: toNumber(row.lead_score),
    contact_probability: toNumber(row.contact_probability),
    purchase_probability: toNumber(row.purchase_probability),
    fit_score: toNumber(row.fit_score),
    segmentacion: {
      segmento_tamano_empresa: row.segmento_tamano_empresa,
      ultimo_tramo_ventas: row.ultimo_tramo_ventas,
      trabajadores_2024: row.trabajadores_2024,
      rubro_economico_ultimo: row.rubro_economico_ultimo,
      actividad_economica_ultima: row.actividad_economica_ultima,
    },
    exclusion_pipeline: {
      sin_gestion_equifax_dicom: true,
      no_target_excluido: true,
      final_clean_rows: 46266,
    },
  }
}

function leadObservation(row) {
  return [
    'Base final limpia Equifax',
    'Sin gestion previa Equifax/Dicom',
    `Color ${row.color_equifax}`,
    `Lead score ${row.lead_score || 0}`,
    row.rubro_economico_ultimo,
  ].filter(Boolean).join(' | ')
}

function parseRows() {
  const parsed = Papa.parse(fs.readFileSync(INPUT_CSV, 'utf8'), {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  })
  if (parsed.errors.length) throw new Error(parsed.errors[0].message)

  const seen = new Set()
  const rows = []
  const invalid = []
  for (const row of parsed.data) {
    const rut = normalizeRut(row.rutid)
    const phone = normalizePhone(row.mejor_telefono)
    if (!rut || !phone) {
      invalid.push(row)
      continue
    }
    if (seen.has(rut)) continue
    seen.add(rut)
    rows.push({ ...row, rutid_normalized: rut, telefono_vocalcom: phone })
  }
  return { rows, invalid }
}

async function getCampaign() {
  const { data, error } = await crm
    .from('campaigns')
    .select('id,name,status,is_active,base_flow_enabled,campaign_channel,created_by')
    .eq('name', CAMPAIGN_NAME)
    .maybeSingle()
  if (error) throw new Error(`No pude consultar campaña ${CAMPAIGN_NAME}: ${error.message}`)
  if (!data?.id) throw new Error(`No existe campaña CRM: ${CAMPAIGN_NAME}`)
  if (!DRY_RUN && (data.base_flow_enabled !== true || data.is_active !== true || data.status !== 'active')) {
    const { error: updateError } = await crm
      .from('campaigns')
      .update({
        status: 'active',
        is_active: true,
        base_flow_enabled: true,
        campaign_channel: 'phone',
      })
      .eq('id', data.id)
    if (updateError) throw new Error(`No pude activar campaña ${CAMPAIGN_NAME}: ${updateError.message}`)
  }
  return data
}

async function getCampaignAgents(campaignId) {
  const { data, error } = await crm
    .from('user_campaigns')
    .select('user_id,role,is_default')
    .eq('campaign_id', campaignId)
  if (error) throw new Error(`No pude leer agentes campaña: ${error.message}`)
  const rawAgentIds = (data ?? []).filter(row => row.role === 'agent').map(row => row.user_id)
  const { data: profiles, error: profileError } = rawAgentIds.length
    ? await crm
      .from('profiles')
      .select('user_id,full_name,role')
      .in('user_id', rawAgentIds)
    : { data: [], error: null }
  if (profileError) throw new Error(`No pude leer perfiles de agentes: ${profileError.message}`)
  const blockedName = /test|debug|help|vocalcom/i
  const allowed = new Set((profiles ?? [])
    .filter(profile => profile.role === 'agent' && !blockedName.test(String(profile.full_name ?? '')))
    .map(profile => profile.user_id))
  const agentIds = rawAgentIds.filter(userId => allowed.has(userId))
  if (!agentIds.length) throw new Error(`Campaña ${CAMPAIGN_NAME} no tiene agentes asignados.`)
  return agentIds
}

async function addAdditionalAgentsIfNeeded(campaignId, existingAgentIds) {
  if (existingAgentIds.length >= 8) {
    return { added: 0, agents: [...existingAgentIds], addedProfiles: [] }
  }

  const existing = new Set(existingAgentIds)
  const { data: profiles, error } = await crm
    .from('profiles')
    .select('user_id,full_name,role,shift_start_time,shift_end_time')
    .eq('role', 'agent')
  if (error) throw new Error(`No pude leer perfiles agentes: ${error.message}`)

  const candidates = (profiles ?? []).filter(profile => {
    const name = String(profile.full_name ?? '').toLowerCase()
    if (existing.has(profile.user_id)) return false
    if (name.includes('test') || name.includes('debug') || name.includes('help') || name.includes('vocalcom')) return false
    return profile.shift_start_time === '09:00:00' && profile.shift_end_time === '18:00:00'
  })

  // Urgent productive load: keep the roster broad enough but avoid test/debug users.
  const selected = candidates.slice(0, Math.max(0, 8 - existingAgentIds.length))
  if (!selected.length) return { added: 0, agents: [...existingAgentIds], addedProfiles: [] }

  const rows = selected.map((profile, index) => ({
    user_id: profile.user_id,
    campaign_id: campaignId,
    role: 'agent',
    is_default: index < 4,
  }))

  if (!DRY_RUN) {
    const { error: insertError } = await crm
      .from('user_campaigns')
      .insert(rows)
    if (insertError) throw new Error(`No pude sumar agentes a campaña: ${insertError.message}`)
  }

  return {
    added: selected.length,
    agents: [...existingAgentIds, ...selected.map(profile => profile.user_id)],
    addedProfiles: selected.map(profile => ({ user_id: profile.user_id, full_name: profile.full_name })),
  }
}

async function createImportJob(campaignId, rows) {
  if (DRY_RUN) return 'dry-run-import-job-id'
  const byColor = rows.reduce((acc, row) => {
    acc[row.color_equifax || 'sin_color'] = (acc[row.color_equifax || 'sin_color'] ?? 0) + 1
    return acc
  }, {})
  const { data, error } = await crm
    .from('import_jobs')
    .insert({
      filename: path.basename(INPUT_CSV),
      file_type: 'csv',
      status: 'completed',
      dedup_strategy: 'rut',
      campaign_id: campaignId,
      created_by: CREATED_BY,
      template_code: 'rut_intelligence_dicom_productive',
      mapping: {
        rut: 'rutid',
        full_name: 'razon_social_empresa',
        phone_mobile: 'mejor_telefono',
        email: 'mejor_email',
      },
      summary: {
        total: rows.length,
        by_color: byColor,
        source_system: SOURCE_SYSTEM,
        productive_dialing: true,
      },
    })
    .select('id')
    .single()
  if (error || !data?.id) throw new Error(`No pude crear import_job: ${error?.message ?? 'sin id'}`)
  return data.id
}

async function fetchExistingContacts(rows) {
  const byRut = new Map()
  const byPhone = new Map()
  const rutVariants = uniqueStrings(rows.flatMap(row => [row.rutid_normalized, formatRut(row.rutid_normalized), row.rutid]))
  const phones = uniqueStrings(rows.map(row => row.telefono_vocalcom))

  for (const values of chunk(rutVariants, 200)) {
    const { data, error } = await withRetry('leer contacts por RUT', () => crm
      .from('contacts')
      .select('id,rut,full_name,email,phones,phone_mobile,phone_contact,phone_normalized,comuna,region,tags,custom_fields,primary_campaign_id,created_by,updated_by')
      .in('rut', values))
    if (error) throw new Error(`No pude leer contacts por RUT: ${error.message}`)
    for (const contact of data ?? []) {
      const rut = normalizeRut(contact.rut)
      if (rut && !byRut.has(rut)) byRut.set(rut, contact)
      if (contact.phone_normalized && !byPhone.has(contact.phone_normalized)) byPhone.set(contact.phone_normalized, contact)
    }
  }

  for (const values of chunk(phones, 200)) {
    const { data, error } = await withRetry('leer contacts por teléfono', () => crm
      .from('contacts')
      .select('id,rut,full_name,email,phones,phone_mobile,phone_contact,phone_normalized,comuna,region,tags,custom_fields,primary_campaign_id,created_by,updated_by')
      .in('phone_normalized', values))
    if (error) throw new Error(`No pude leer contacts por teléfono: ${error.message}`)
    for (const contact of data ?? []) {
      const rut = normalizeRut(contact.rut)
      if (rut && !byRut.has(rut)) byRut.set(rut, contact)
      if (contact.phone_normalized && !byPhone.has(contact.phone_normalized)) byPhone.set(contact.phone_normalized, contact)
    }
  }

  return { byRut, byPhone }
}

async function syncContacts(rows, campaignId, existing) {
  const contactByRut = new Map(existing.byRut)
  const contactByPhone = new Map(existing.byPhone)
  const inserts = []
  const updates = []

  for (const row of rows) {
    const contact = contactByRut.get(row.rutid_normalized) || contactByPhone.get(row.telefono_vocalcom)
    const payload = sourcePayload(row)
    if (contact?.id) {
      updates.push({
        id: contact.id,
        rut: contact.rut || formatRut(row.rutid_normalized),
        full_name: contact.full_name || displayName(row),
        email: contact.email || row.mejor_email || null,
        phones: uniqueStrings([...(contact.phones ?? []), ...phoneVariants(row.telefono_vocalcom)]),
        phone_mobile: mobilePhone(row.telefono_vocalcom) || contact.phone_mobile,
        phone_contact: contact.phone_contact || row.mejor_telefono || row.telefono_vocalcom,
        phone_normalized: contact.phone_normalized || row.telefono_vocalcom,
        comuna: contact.comuna || row.direccion_preferida_comuna || null,
        region: contact.region || row.direccion_preferida_region || null,
        tags: uniqueStrings([...(contact.tags ?? []), 'rut-intelligence', 'equifax', 'discado-productivo']),
        custom_fields: {
          ...(contact.custom_fields ?? {}),
          rut_intelligence_dicom_productive: payload,
        },
        primary_campaign_id: contact.primary_campaign_id || campaignId,
        created_by: contact.created_by || CREATED_BY,
        updated_by: CREATED_BY,
        updated_at: new Date().toISOString(),
      })
    } else {
      inserts.push({
        rut: formatRut(row.rutid_normalized),
        full_name: displayName(row),
        email: row.mejor_email || null,
        phones: phoneVariants(row.telefono_vocalcom),
        phone_mobile: mobilePhone(row.telefono_vocalcom),
        phone_contact: row.mejor_telefono || row.telefono_vocalcom,
        phone_normalized: row.telefono_vocalcom,
        comuna: row.direccion_preferida_comuna || null,
        region: row.direccion_preferida_region || null,
        tags: ['rut-intelligence', 'equifax', 'discado-productivo'],
        custom_fields: {
          rut_intelligence_dicom_productive: payload,
        },
        primary_campaign_id: campaignId,
        created_by: CREATED_BY,
        updated_by: CREATED_BY,
      })
    }
  }

  const dedupedUpdatesById = new Map()
  for (const update of updates) {
    const existing = dedupedUpdatesById.get(update.id)
    if (!existing) {
      dedupedUpdatesById.set(update.id, update)
      continue
    }
    dedupedUpdatesById.set(update.id, {
      ...existing,
      ...update,
      phones: uniqueStrings([...(existing.phones ?? []), ...(update.phones ?? [])]),
      tags: uniqueStrings([...(existing.tags ?? []), ...(update.tags ?? [])]),
      custom_fields: {
        ...(existing.custom_fields ?? {}),
        ...(update.custom_fields ?? {}),
      },
    })
  }
  const dedupedUpdates = [...dedupedUpdatesById.values()]

  let inserted = 0
  let updated = 0
  if (!DRY_RUN) {
    for (const batch of chunk(inserts)) {
      const { data, error } = await crm
        .from('contacts')
        .insert(batch)
        .select('id,rut,full_name,email,phones,phone_mobile,phone_contact,phone_normalized,comuna,region,tags,custom_fields,primary_campaign_id,created_by,updated_by')
      if (error) throw new Error(`No pude insertar contacts: ${error.message}`)
      inserted += data?.length ?? 0
      for (const contact of data ?? []) {
        const rut = normalizeRut(contact.rut)
        if (rut) contactByRut.set(rut, contact)
        if (contact.phone_normalized) contactByPhone.set(contact.phone_normalized, contact)
      }
    }

    for (const batch of chunk(dedupedUpdates, 100)) {
      const { data, error } = await crm
        .from('contacts')
        .upsert(batch, { onConflict: 'id' })
        .select('id,rut,full_name,email,phones,phone_mobile,phone_contact,phone_normalized,comuna,region,tags,custom_fields,primary_campaign_id,created_by,updated_by')
      if (error) throw new Error(`No pude actualizar contacts: ${error.message}`)
      updated += data?.length ?? batch.length
      for (const contact of data ?? []) {
        const rut = normalizeRut(contact.rut)
        if (rut) contactByRut.set(rut, contact)
        if (contact.phone_normalized) contactByPhone.set(contact.phone_normalized, contact)
      }
    }
  }

  return { contactByRut, contactByPhone, inserted, updated, planned_insert: inserts.length, planned_update: dedupedUpdates.length }
}

async function syncCampaignContacts(rows, campaignId, contactMaps) {
  const pairs = []
  const seen = new Set()
  for (const row of rows) {
    const contact = contactMaps.contactByRut.get(row.rutid_normalized) || contactMaps.contactByPhone.get(row.telefono_vocalcom)
    if (!contact?.id || seen.has(contact.id)) continue
    seen.add(contact.id)
    pairs.push({ campaign_id: campaignId, contact_id: contact.id })
  }

  let insertedOrExisting = 0
  if (!DRY_RUN) {
    for (const batch of chunk(pairs, 500)) {
      const { error } = await crm
        .from('campaign_contacts')
        .upsert(batch, { onConflict: 'campaign_id,contact_id', ignoreDuplicates: true })
      if (error) throw new Error(`No pude asociar contacts a campaña: ${error.message}`)
      insertedOrExisting += batch.length
    }
  }

  return { planned: pairs.length, inserted_or_existing: insertedOrExisting }
}

async function fetchExistingProductiveLeads(rows, campaignId) {
  const bySource = new Map()
  const byRut = new Map()
  const keys = rows.map(row => sourceKey(row.rutid_normalized))
  const rutFormatted = uniqueStrings(rows.map(row => formatRut(row.rutid_normalized)))

  for (const values of chunk(keys, 200)) {
    const { data, error } = await crm
      .from('campaign_base_leads')
      .select('id,source_external_key,rut_empresa,campaign_id,workflow_status,assignment_status')
      .eq('source_system', SOURCE_SYSTEM)
      .in('source_external_key', values)
    if (error) throw new Error(`No pude leer leads existentes por source: ${error.message}`)
    for (const lead of data ?? []) bySource.set(lead.source_external_key, lead)
  }

  for (const values of chunk(rutFormatted, 200)) {
    const { data, error } = await crm
      .from('campaign_base_leads')
      .select('id,source_external_key,rut_empresa,campaign_id,workflow_status,assignment_status')
      .eq('campaign_id', campaignId)
      .in('rut_empresa', values)
    if (error) throw new Error(`No pude leer leads existentes por RUT/campaña: ${error.message}`)
    for (const lead of data ?? []) {
      const rut = normalizeRut(lead.rut_empresa)
      if (rut && !byRut.has(rut)) byRut.set(rut, lead)
    }
  }

  return { bySource, byRut }
}

async function syncLeads(rows, campaignId, importJobId, contactMaps, agentIds) {
  const existing = await fetchExistingProductiveLeads(rows, campaignId)
  const inserts = []
  const updates = []
  let skippedNoContact = 0

  rows.forEach((row, index) => {
    const contact = contactMaps.contactByRut.get(row.rutid_normalized) || contactMaps.contactByPhone.get(row.telefono_vocalcom)
    if (!contact?.id) {
      skippedNoContact += 1
      return
    }
    const assignedUserId = agentIds[index % agentIds.length]
    const payload = sourcePayload(row)
    const baseLead = {
      campaign_id: campaignId,
      import_job_id: importJobId,
      row_number: Number(row.fila_origen || index + 1),
      contact_id: contact.id,
      origin_raw: 'RUT Intelligence Final Limpio',
      origin_normalized: 'rut_intelligence_final_limpio',
      rut_empresa: formatRut(row.rutid_normalized),
      razon_social: displayName(row),
      mail: row.mejor_email || null,
      nombre_cliente: displayName(row),
      asesor_raw: 'Equifax productivo',
      tipificacion_inicial: `COLOR_${String(row.color_equifax || 'red').toUpperCase()}`,
      observacion_inicial: leadObservation(row),
      tipificacion_actual: null,
      observacion_actual: null,
      assigned_user_id: assignedUserId,
      assignment_rule: 'round_robin_rut_intelligence',
      assignment_status: 'assigned',
      workflow_status: 'pending',
      priority_bucket: priorityBucket(row),
      priority_score: priorityScore(row),
      sort_key: `EQUIFAX | ${priorityBucket(row)} | ${String(priorityScore(row)).padStart(4, '0')} | ${String(displayName(row)).toLowerCase()} | ${row.rutid_normalized}`,
      attempts_count: 0,
      source_system: SOURCE_SYSTEM,
      source_external_key: sourceKey(row.rutid_normalized),
      source_payload: payload,
      injected_at: new Date().toISOString(),
      last_synced_at: new Date().toISOString(),
      mail_review_stage: 'pending_review',
    }
    const current = existing.bySource.get(baseLead.source_external_key) || existing.byRut.get(row.rutid_normalized)
    if (current?.id) updates.push({ id: current.id, ...baseLead })
    else inserts.push(baseLead)
  })

  let inserted = 0
  let updated = 0
  const upsertedIds = []
  if (!DRY_RUN) {
    for (const batch of chunk(inserts)) {
      const { data, error } = await crm.from('campaign_base_leads').insert(batch).select('id')
      if (error) throw new Error(`No pude insertar campaign_base_leads: ${error.message}`)
      inserted += data?.length ?? 0
      upsertedIds.push(...(data ?? []).map(row => row.id))
    }
    for (const batch of chunk(updates)) {
      const { data, error } = await crm.from('campaign_base_leads').upsert(batch, { onConflict: 'id' }).select('id')
      if (error) throw new Error(`No pude actualizar campaign_base_leads: ${error.message}`)
      updated += data?.length ?? batch.length
      upsertedIds.push(...(data ?? []).map(row => row.id))
    }
  }

  return {
    inserted,
    updated,
    planned_inserts: inserts.length,
    planned_updates: updates.length,
    skipped_no_contact: skippedNoContact,
    lead_ids: upsertedIds,
  }
}

async function verify(campaignId, importJobId) {
  const { count: totalLoaded, error: totalError } = await crm
    .from('campaign_base_leads')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('source_system', SOURCE_SYSTEM)
  if (totalError) throw new Error(`No pude verificar total leads: ${totalError.message}`)

  const { count: pendingLoaded, error: pendingError } = await crm
    .from('campaign_base_leads')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('source_system', SOURCE_SYSTEM)
    .eq('workflow_status', 'pending')
  if (pendingError) throw new Error(`No pude verificar pending leads: ${pendingError.message}`)

  const { count: importLoaded, error: importError } = await crm
    .from('campaign_base_leads')
    .select('id', { count: 'exact', head: true })
    .eq('import_job_id', importJobId)
  if (importError) throw new Error(`No pude verificar import leads: ${importError.message}`)

  return { totalLoaded, pendingLoaded, importLoaded }
}

async function main() {
  const { rows, invalid } = parseRows()
  if (invalid.length) throw new Error(`Base trae ${invalid.length} filas sin RUT/teléfono válido.`)
  if (!rows.length) throw new Error('Base sin filas.')

  const campaign = await getCampaign()
  const currentAgents = await getCampaignAgents(campaign.id)
  const agentUpdate = await addAdditionalAgentsIfNeeded(campaign.id, currentAgents)
  const agentIds = agentUpdate.agents
  const importJobId = await createImportJob(campaign.id, rows)
  const existingContacts = await fetchExistingContacts(rows)
  const contacts = await syncContacts(rows, campaign.id, existingContacts)
  const campaignContacts = await syncCampaignContacts(rows, campaign.id, contacts)
  const leads = await syncLeads(rows, campaign.id, importJobId, contacts, agentIds)
  const verification = DRY_RUN ? null : await verify(campaign.id, importJobId)

  console.log(JSON.stringify({
    ok: true,
    dry_run: DRY_RUN,
    input: INPUT_CSV,
    campaign_name: campaign.name,
    campaign_id: campaign.id,
    source_system: SOURCE_SYSTEM,
    import_job_id: importJobId,
    rows: rows.length,
    agents: {
      existing: currentAgents.length,
      added: agentUpdate.added,
      total_for_round_robin: agentIds.length,
      added_profiles: agentUpdate.addedProfiles,
    },
    contacts,
    campaign_contacts: campaignContacts,
    leads: {
      inserted: leads.inserted,
      updated: leads.updated,
      planned_inserts: leads.planned_inserts,
      planned_updates: leads.planned_updates,
      skipped_no_contact: leads.skipped_no_contact,
    },
    verification,
    loaded_at: new Date().toISOString(),
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
