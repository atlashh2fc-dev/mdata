import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.production')

const DEFAULT_INPUT = 'exports/vocalcom/vocalcom_dicom_disponible_sin_agendas_todos_colores_limpia_2026-04-29.csv'
const DEFAULT_CAMPAIGN_NAME = 'Dicom disponible consulta ejecutivos'
const SOURCE_SYSTEM = 'rut_intelligence_vocalcom_reference'
const SOURCE_KEY_PREFIX = 'dicom_clean_20260429'
const CHUNK_SIZE = 200
const CREATED_BY = process.env.REGISTRO_INTEL_DEFAULT_USER_ID || '14f638a7-9cfe-4502-94e6-9c7d1e7aa1c3'

function readFlag(name, fallback = null) {
  const arg = process.argv.find(item => item.startsWith(`--${name}=`))
  if (!arg) return fallback
  return arg.split('=').slice(1).join('=')
}

function readBooleanFlag(name, fallback = false) {
  const raw = readFlag(name)
  if (raw === null) return fallback
  return ['1', 'true', 'yes', 'y'].includes(raw.toLowerCase())
}

function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (char !== '\r') {
      cell += char
    }
  }

  if (cell.length || row.length) {
    row.push(cell)
    rows.push(row)
  }

  const headers = rows.shift() ?? []
  return rows
    .filter(item => item.some(value => String(value ?? '').trim()))
    .map(item => Object.fromEntries(headers.map((header, index) => [header, item[index] ?? ''])))
}

function chunk(items, size = CHUNK_SIZE) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

async function withRetry(label, operation, retries = 4) {
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)))
      }
    }
  }
  throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

function normalizeRut(value) {
  const compact = String(value ?? '').toUpperCase().replace(/[^0-9K]/g, '').replace(/^0+/, '')
  return compact || null
}

function formatRut(value) {
  const compact = normalizeRut(value)
  if (!compact || compact.length < 2) return value || ''
  return `${compact.slice(0, -1)}-${compact.slice(-1)}`
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

function mobilePhone(value) {
  const phone = normalizePhone(value)
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  return digits.startsWith('569') ? digits.slice(-9) : null
}

function uniqueStrings(values) {
  return [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))]
}

function toNumber(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : 0
}

function priorityBucket(row) {
  const order = Number(row.prioridad_orden)
  if (order === 2) return 2
  if (order === 3) return 3
  return 4
}

function sourceKey(rutid) {
  return `${SOURCE_KEY_PREFIX}:${normalizeRut(rutid)}`
}

function buildCustomPayload(row) {
  return {
    source_system: SOURCE_SYSTEM,
    loaded_at: new Date().toISOString(),
    vocalcom_file: path.basename(inputPath),
    rutid: row.rutid,
    tipo_registro: row.tipo_registro,
    color_propension: row.color_propension,
    modelo_color: row.modelo_color,
    prioridad_orden: Number(row.prioridad_orden || 0),
    prioridad_score: toNumber(row.prioridad_score),
    estado_disponible: row.estado_disponible,
    origen_base: row.origen_base,
    ai_temperature: row.ai_temperature,
    ai_confidence: row.ai_confidence,
    ai_contactability_score: toNumber(row.ai_contactability_score),
    ai_purchase_propensity_score: toNumber(row.ai_purchase_propensity_score),
    motivo: row.motivo,
    referencia_crm: row.referencia_crm,
    no_dial_from_crm: true,
    visible_to_executives: true,
  }
}

function buildLeadObservation(row) {
  return [
    'Disponible para consulta ejecutivos',
    'NO discar desde CRM',
    row.color_propension ? `propension ${row.color_propension}` : null,
    row.modelo_color ? `modelo ${row.modelo_color}` : null,
    row.estado_disponible,
  ].filter(Boolean).join(' | ')
}

const inputPath = readFlag('input', DEFAULT_INPUT)
const campaignName = readFlag('campaign-name', DEFAULT_CAMPAIGN_NAME)
const dryRun = readBooleanFlag('dry-run', false)

const url = process.env.REGISTRO_INTEL_SUPABASE_URL
const key = process.env.REGISTRO_INTEL_SERVICE_ROLE_KEY || process.env.REGISTRO_INTEL_SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  throw new Error('Faltan REGISTRO_INTEL_SUPABASE_URL o REGISTRO_INTEL_SERVICE_ROLE_KEY.')
}

if (!fs.existsSync(inputPath)) {
  throw new Error(`No existe el archivo de entrada: ${inputPath}`)
}

const crm = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function ensureCampaign() {
  const { data: existing, error: existingError } = await crm
    .from('campaigns')
    .select('id,name,base_flow_enabled,is_active,status')
    .eq('name', campaignName)
    .maybeSingle()

  if (existingError) throw new Error(`No pude consultar campaña CRM: ${existingError.message}`)
  if (existing?.id) {
    if (existing.base_flow_enabled !== false && !dryRun) {
      const { error } = await crm
        .from('campaigns')
        .update({
          base_flow_enabled: false,
          config_json: {
            managed_by: SOURCE_SYSTEM,
            purpose: 'reference_only_executive_lookup',
            no_dial_from_crm: true,
          },
        })
        .eq('id', existing.id)
      if (error) throw new Error(`No pude desactivar base_flow de campaña: ${error.message}`)
    }
    return existing.id
  }

  if (dryRun) return 'dry-run-campaign-id'

  const { data, error } = await crm
    .from('campaigns')
    .insert({
      name: campaignName,
      description: 'Base Dicom disponible cargada solo para consulta de ejecutivos. No usar como motor de discado CRM.',
      status: 'active',
      is_active: true,
      base_flow_enabled: false,
      campaign_channel: 'phone',
      created_by: CREATED_BY,
      config_json: {
        wizard_identity: {
          channel: 'phone',
          objective: 'Consulta ejecutivos Dicom disponible',
          campaign_type: 'referencia',
          draft_identity_pending: false,
        },
        managed_by: SOURCE_SYSTEM,
        no_dial_from_crm: true,
      },
    })
    .select('id')
    .single()

  if (error || !data?.id) throw new Error(`No pude crear campaña CRM de referencia: ${error?.message ?? 'sin id'}`)
  return data.id
}

async function createImportJob(campaignId, rows) {
  if (dryRun) return 'dry-run-import-job-id'

  const summary = rows.reduce((acc, row) => {
    acc.total += 1
    acc.by_type[row.tipo_registro] = (acc.by_type[row.tipo_registro] ?? 0) + 1
    acc.by_status[row.estado_disponible] = (acc.by_status[row.estado_disponible] ?? 0) + 1
    return acc
  }, { total: 0, by_type: {}, by_status: {}, calls_created: 0, no_dial_from_crm: true })

  const { data, error } = await crm
    .from('import_jobs')
    .insert({
      filename: path.basename(inputPath),
      file_type: 'csv',
      status: 'completed',
      dedup_strategy: 'rut',
      campaign_id: campaignId,
      created_by: CREATED_BY,
      template_code: 'rut_intelligence_reference',
      mapping: {
        source_system: SOURCE_SYSTEM,
        source_key_prefix: SOURCE_KEY_PREFIX,
        visible_to_executives: true,
        no_dial_from_crm: true,
      },
      summary,
    })
    .select('id')
    .single()

  if (error || !data?.id) throw new Error(`No pude crear import_job CRM: ${error?.message ?? 'sin id'}`)
  return data.id
}

async function fetchExistingContacts(rows) {
  const byRut = new Map()
  const byPhone = new Map()
  const rutVariants = uniqueStrings(rows.flatMap(row => [row.rutid, normalizeRut(row.rutid), formatRut(row.rutid)]))
  const phones = uniqueStrings(rows.map(row => normalizePhone(row.telefono_vocalcom)))

  for (const values of chunk(rutVariants)) {
    const { data, error } = await withRetry('leer contacts por RUT', () => crm
      .from('contacts')
      .select('id,rut,full_name,email,phones,phone_mobile,phone_contact,phone_normalized,comuna,region,tags,custom_fields,primary_campaign_id,created_by,updated_by')
      .in('rut', values))
    if (error) throw new Error(`No pude leer contacts por RUT: ${error.message}`)
    for (const contact of data ?? []) {
      const key = normalizeRut(contact.rut)
      if (key && !byRut.has(key)) byRut.set(key, contact)
      if (contact.phone_normalized && !byPhone.has(contact.phone_normalized)) byPhone.set(contact.phone_normalized, contact)
    }
  }

  for (const values of chunk(phones)) {
    const { data, error } = await withRetry('leer contacts por telefono', () => crm
      .from('contacts')
      .select('id,rut,full_name,email,phones,phone_mobile,phone_contact,phone_normalized,comuna,region,tags,custom_fields,primary_campaign_id,created_by,updated_by')
      .in('phone_normalized', values))
    if (error) throw new Error(`No pude leer contacts por teléfono: ${error.message}`)
    for (const contact of data ?? []) {
      const key = normalizeRut(contact.rut)
      if (key && !byRut.has(key)) byRut.set(key, contact)
      if (contact.phone_normalized && !byPhone.has(contact.phone_normalized)) byPhone.set(contact.phone_normalized, contact)
    }
  }

  return { byRut, byPhone }
}

async function insertContacts(rows, campaignId, existing) {
  const contactByRut = new Map(existing.byRut)
  const contactByPhone = new Map(existing.byPhone)
  const newRows = []

  for (const row of rows) {
    const rut = normalizeRut(row.rutid)
    const phone = normalizePhone(row.telefono_vocalcom)
    if (!rut || !phone) continue
    const found = contactByRut.get(rut) || contactByPhone.get(phone)
    if (found) continue

    newRows.push({
      rut: formatRut(row.rutid),
      full_name: row.nombre || row.rutid,
      email: row.email || null,
      phones: [phone],
      phone_mobile: mobilePhone(phone),
      phone_contact: row.telefono_original || phone,
      phone_normalized: phone,
      comuna: row.comuna || null,
      region: row.region || null,
      tags: ['rut-intelligence', 'dicom-disponible', 'consulta-ejecutivos'],
      custom_fields: {
        rut_intelligence_dicom: buildCustomPayload(row),
      },
      primary_campaign_id: campaignId,
      created_by: CREATED_BY,
      updated_by: CREATED_BY,
    })
  }

  let inserted = 0
  if (!dryRun) {
    for (const batch of chunk(newRows)) {
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
  }

  return { inserted, contactByRut, contactByPhone, planned: newRows.length }
}

async function updateExistingContacts(rows, campaignId, contactMaps) {
  let updated = 0

  for (const batch of chunk(rows, 100)) {
    const updates = []
    for (const row of batch) {
      const rut = normalizeRut(row.rutid)
      const phone = normalizePhone(row.telefono_vocalcom)
      const contact = contactMaps.contactByRut.get(rut) || contactMaps.contactByPhone.get(phone)
      if (!contact?.id) continue

      const tags = uniqueStrings([...(contact.tags ?? []), 'rut-intelligence', 'dicom-disponible', 'consulta-ejecutivos'])
      const phones = uniqueStrings([...(contact.phones ?? []), phone])
      updates.push({
        id: contact.id,
        full_name: contact.full_name || row.nombre || row.rutid,
        email: contact.email || row.email || null,
        phones,
        phone_mobile: contact.phone_mobile || mobilePhone(phone),
        phone_contact: contact.phone_contact || row.telefono_original || phone,
        phone_normalized: contact.phone_normalized || phone,
        comuna: contact.comuna || row.comuna || null,
        region: contact.region || row.region || null,
        tags,
        custom_fields: {
          ...(contact.custom_fields ?? {}),
          rut_intelligence_dicom: buildCustomPayload(row),
        },
        primary_campaign_id: contact.primary_campaign_id || campaignId,
        created_by: contact.created_by || CREATED_BY,
        updated_by: CREATED_BY,
        updated_at: new Date().toISOString(),
      })
    }

    if (!dryRun) {
      const { error } = await withRetry('actualizar contacts por lote', () => crm
        .from('contacts')
        .upsert(updates, { onConflict: 'id' }))
      if (error) throw new Error(`No pude actualizar contacts por lote: ${error.message}`)
    }
    updated += updates.length
  }

  return updated
}

async function fetchExistingReferenceLeads(rows) {
  const keys = rows.map(row => sourceKey(row.rutid))
  const map = new Map()

  for (const values of chunk(keys)) {
    const { data, error } = await withRetry('leer leads de referencia existentes', () => crm
      .from('campaign_base_leads')
      .select('id,source_external_key')
      .eq('source_system', SOURCE_SYSTEM)
      .in('source_external_key', values))

    if (error) throw new Error(`No pude leer leads de referencia existentes: ${error.message}`)
    for (const lead of data ?? []) map.set(lead.source_external_key, lead)
  }

  return map
}

async function syncReferenceLeads(rows, campaignId, importJobId, contactMaps) {
  const existing = await fetchExistingReferenceLeads(rows)
  const inserts = []
  const updates = []

  rows.forEach((row, index) => {
    const rut = normalizeRut(row.rutid)
    const phone = normalizePhone(row.telefono_vocalcom)
    const contact = contactMaps.contactByRut.get(rut) || contactMaps.contactByPhone.get(phone)
    if (!rut || !phone || !contact?.id) return

    const payload = buildCustomPayload(row)
    const lead = {
      campaign_id: campaignId,
      import_job_id: importJobId,
      row_number: index + 1,
      contact_id: contact.id,
      origin_raw: row.origen_base || 'rut_intelligence',
      origin_normalized: 'unknown',
      rut_empresa: formatRut(row.rutid),
      razon_social: row.nombre || null,
      mail: row.email || null,
      nombre_cliente: row.nombre || null,
      tipificacion_inicial: row.color_propension || null,
      observacion_inicial: buildLeadObservation(row),
      tipificacion_actual: 'DISPONIBLE_CONSULTA_CRM',
      observacion_actual: buildLeadObservation(row),
      assignment_rule: 'unassigned',
      assignment_status: 'managed',
      workflow_status: 'managed',
      priority_bucket: priorityBucket(row),
      priority_score: toNumber(row.prioridad_score),
      sort_key: `DICOM CONSULTA | ${String(row.color_propension || '').padEnd(8)} | ${String(row.prioridad_score || '').padStart(3, '0')} | ${String(row.nombre || '').toLowerCase()} | ${rut}`,
      attempts_count: 0,
      source_system: SOURCE_SYSTEM,
      source_external_key: sourceKey(row.rutid),
      source_payload: payload,
      injected_at: new Date().toISOString(),
      last_synced_at: new Date().toISOString(),
      mail_review_stage: 'pending_review',
    }

    const current = existing.get(lead.source_external_key)
    if (current?.id) updates.push({ id: current.id, ...lead })
    else inserts.push(lead)
  })

  let inserted = 0
  let updated = 0

  if (!dryRun) {
    for (const batch of chunk(inserts)) {
      const { data, error } = await crm
        .from('campaign_base_leads')
        .insert(batch)
        .select('id')
      if (error) throw new Error(`No pude insertar campaign_base_leads: ${error.message}`)
      inserted += data?.length ?? 0
    }

    for (const batch of chunk(updates)) {
      const { error } = await withRetry('actualizar campaign_base_leads por lote', () => crm
        .from('campaign_base_leads')
        .upsert(batch, { onConflict: 'id' }))
      if (error) throw new Error(`No pude actualizar campaign_base_leads por lote: ${error.message}`)
      updated += batch.length
    }
  }

  return { inserted, updated, planned_inserts: inserts.length, planned_updates: updates.length }
}

async function main() {
  const rows = parseCsv(fs.readFileSync(inputPath, 'utf8'))
  if (!rows.length) throw new Error(`CSV sin filas: ${inputPath}`)

  const invalid = rows.filter(row => !normalizeRut(row.rutid) || !normalizePhone(row.telefono_vocalcom))
  if (invalid.length) {
    throw new Error(`La base trae ${invalid.length} filas sin RUT o teléfono normalizado.`)
  }

  const campaignId = await ensureCampaign()
  const importJobId = await createImportJob(campaignId, rows)
  const existingContacts = await fetchExistingContacts(rows)
  const insertedContacts = await insertContacts(rows, campaignId, existingContacts)
  const updatedContacts = await updateExistingContacts(rows, campaignId, insertedContacts)
  const leadSync = await syncReferenceLeads(rows, campaignId, importJobId, insertedContacts)

  const summary = {
    ok: true,
    dry_run: dryRun,
    input: inputPath,
    campaign_name: campaignName,
    campaign_id: campaignId,
    import_job_id: importJobId,
    source_system: SOURCE_SYSTEM,
    rows: rows.length,
    contacts: {
      planned_insert: insertedContacts.planned,
      inserted: insertedContacts.inserted,
      updated: updatedContacts,
    },
    reference_leads: leadSync,
    no_dial_from_crm: true,
    loaded_at: new Date().toISOString(),
  }

  process.stdout.write(JSON.stringify(summary, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
