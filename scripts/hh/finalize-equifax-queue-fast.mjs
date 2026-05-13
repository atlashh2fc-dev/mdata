import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import Papa from 'papaparse'
import { createClient } from '@supabase/supabase-js'

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.production')

const INPUT_CSV = path.join(process.cwd(), 'outputs', 'bdd_equifax_gestiones_2026-05-07', 'BDD_pendientes_sin_gestion_target_limpio_con_colores.csv')
const CAMPAIGN_ID = 'b5df1732-476e-4475-a21a-bae8e0942829'
const CAMPAIGN_NAME = 'Equifax'
const SOURCE_SYSTEM = 'rut_intelligence_equifax_productive'
const SOURCE_KEY_PREFIX = 'equifax_productive_20260507'
const CREATED_BY = process.env.REGISTRO_INTEL_DEFAULT_USER_ID || '14f638a7-9cfe-4502-94e6-9c7d1e7aa1c3'
const CHUNK_SIZE = 150

const crm = createClient(
  process.env.REGISTRO_INTEL_SUPABASE_URL,
  process.env.REGISTRO_INTEL_SERVICE_ROLE_KEY || process.env.REGISTRO_INTEL_SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

function chunk(items, size = CHUNK_SIZE) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
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
  const phone = normalizePhone(value)
  if (!phone) return []
  const digits = phone.replace(/\D/g, '')
  const variants = [phone, digits]
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

function displayName(row) {
  return row.razon_social_empresa || row.nombre_completo || row.rut_formateado || row.rutid
}

function sourceKey(rutid) {
  return `${SOURCE_KEY_PREFIX}:${normalizeRut(rutid)}`
}

function priorityBucket(row) {
  if (row.color_equifax === 'green') return 1
  if (row.color_equifax === 'yellow') return 2
  return 4
}

function priorityScore(row) {
  const colorBoost = row.color_equifax === 'green' ? 200 : row.color_equifax === 'yellow' ? 100 : 0
  return Math.round(colorBoost + toNumber(row.lead_score) + toNumber(row.contact_probability) * 0.25 + toNumber(row.purchase_probability) * 0.25)
}

function payload(row) {
  return {
    source_system: SOURCE_SYSTEM,
    loaded_at: new Date().toISOString(),
    rutid: row.rutid,
    rut_formateado: row.rut_formateado,
    color_equifax: row.color_equifax,
    lead_score: toNumber(row.lead_score),
    contact_probability: toNumber(row.contact_probability),
    purchase_probability: toNumber(row.purchase_probability),
    final_clean_rows: 46266,
    input_file: path.basename(INPUT_CSV),
  }
}

function parseRows() {
  const parsed = Papa.parse(fs.readFileSync(INPUT_CSV, 'utf8'), {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  })
  if (parsed.errors.length) throw new Error(parsed.errors[0].message)
  const seen = new Set()
  return parsed.data.flatMap(row => {
    const rut = normalizeRut(row.rutid)
    const phone = normalizePhone(row.mejor_telefono)
    if (!rut || !phone || seen.has(rut)) return []
    seen.add(rut)
    return [{ ...row, rutid_normalized: rut, rut_formatted: formatRut(rut), phone_normalized: phone }]
  })
}

async function ensureImportJob(rows) {
  const { data, error } = await crm.from('import_jobs').insert({
    filename: path.basename(INPUT_CSV),
    file_type: 'csv',
    status: 'completed',
    dedup_strategy: 'rut',
    campaign_id: CAMPAIGN_ID,
    created_by: CREATED_BY,
    template_code: 'rut_intelligence_equifax_productive_fast',
    mapping: {
      rut: 'rutid',
      full_name: 'razon_social_empresa',
      phone_mobile: 'mejor_telefono',
      email: 'mejor_email',
    },
    summary: {
      total: rows.length,
      source_system: SOURCE_SYSTEM,
      productive_dialing: true,
      fast_finalize: true,
    },
  }).select('id').single()
  if (error || !data?.id) throw new Error(`import_job: ${error?.message ?? 'sin id'}`)
  return data.id
}

async function fetchAgents() {
  const { data, error } = await crm.from('user_campaigns').select('user_id,role').eq('campaign_id', CAMPAIGN_ID)
  if (error) throw new Error(`agents: ${error.message}`)
  const rawIds = (data ?? []).filter(row => row.role === 'agent').map(row => row.user_id)
  const { data: profiles, error: profileError } = await crm.from('profiles').select('user_id,full_name,role').in('user_id', rawIds)
  if (profileError) throw new Error(`profiles: ${profileError.message}`)
  const blocked = /test|debug|help|vocalcom/i
  const ids = (profiles ?? []).filter(profile => profile.role === 'agent' && !blocked.test(String(profile.full_name ?? ''))).map(profile => profile.user_id)
  if (!ids.length) throw new Error('No hay agentes reales para Equifax.')
  return ids
}

async function fetchContactsByRut(rows) {
  const contacts = new Map()
  for (const values of chunk(rows.map(row => row.rut_formatted), 250)) {
    const { data, error } = await crm.from('contacts').select('id,rut,phone_normalized').in('rut', values)
    if (error) throw new Error(`contacts read: ${error.message}`)
    for (const contact of data ?? []) {
      const rut = normalizeRut(contact.rut)
      if (rut) contacts.set(rut, contact)
    }
  }
  return contacts
}

async function insertMissingContacts(rows, contacts) {
  const missing = rows.filter(row => !contacts.has(row.rutid_normalized))
  let inserted = 0
  for (const batchRows of chunk(missing, 150)) {
    const insertRows = batchRows.map(row => ({
      rut: row.rut_formatted,
      full_name: displayName(row),
      email: row.mejor_email || null,
      phones: phoneVariants(row.phone_normalized),
      phone_mobile: mobilePhone(row.phone_normalized),
      phone_contact: row.mejor_telefono || row.phone_normalized,
      phone_normalized: row.phone_normalized,
      tags: ['rut-intelligence', 'equifax', 'discado-productivo'],
      custom_fields: { rut_intelligence_equifax_productive: payload(row) },
      primary_campaign_id: CAMPAIGN_ID,
      created_by: CREATED_BY,
      updated_by: CREATED_BY,
    }))
    const { data, error } = await crm.from('contacts').insert(insertRows).select('id,rut,phone_normalized')
    if (error) throw new Error(`insert missing contacts: ${error.message}`)
    inserted += data?.length ?? 0
    for (const contact of data ?? []) {
      const rut = normalizeRut(contact.rut)
      if (rut) contacts.set(rut, contact)
    }
  }
  return inserted
}

async function upsertCampaignContacts(rows, contacts) {
  let count = 0
  const pairsByContact = new Map()
  for (const row of rows) {
    const contact = contacts.get(row.rutid_normalized)
    if (contact?.id) pairsByContact.set(contact.id, { campaign_id: CAMPAIGN_ID, contact_id: contact.id })
  }
  for (const batchRows of chunk([...pairsByContact.values()], 300)) {
    const { error } = await crm.from('campaign_contacts').upsert(batchRows, { onConflict: 'campaign_id,contact_id', ignoreDuplicates: true })
    if (error) throw new Error(`campaign_contacts: ${error.message}`)
    count += batchRows.length
  }
  return count
}

async function fetchExistingLeads(rows) {
  const byKey = new Map()
  for (const values of chunk(rows.map(row => sourceKey(row.rutid_normalized)), 250)) {
    const { data, error } = await crm.from('campaign_base_leads').select('id,source_external_key').eq('source_system', SOURCE_SYSTEM).in('source_external_key', values)
    if (error) throw new Error(`existing leads: ${error.message}`)
    for (const lead of data ?? []) byKey.set(lead.source_external_key, lead)
  }
  return byKey
}

async function upsertLeads(rows, contacts, agents, importJobId) {
  const existing = await fetchExistingLeads(rows)
  let inserted = 0
  let updated = 0
  let skipped = 0
  for (const batchRows of chunk(rows, 150)) {
    const inserts = []
    const updates = []
    batchRows.forEach((row, index) => {
      const contact = contacts.get(row.rutid_normalized)
      if (!contact?.id) {
        skipped += 1
        return
      }
      const key = sourceKey(row.rutid_normalized)
      const assignedUserId = agents[(inserted + updated + index) % agents.length]
      const lead = {
        campaign_id: CAMPAIGN_ID,
        import_job_id: importJobId,
        row_number: Number(row.fila_origen || 0),
        contact_id: contact.id,
        origin_raw: 'RUT Intelligence Final Limpio',
        origin_normalized: 'rut_intelligence_final_limpio',
        rut_empresa: row.rut_formatted,
        razon_social: displayName(row),
        mail: row.mejor_email || null,
        nombre_cliente: displayName(row),
        asesor_raw: 'Equifax productivo',
        tipificacion_inicial: `COLOR_${String(row.color_equifax || 'red').toUpperCase()}`,
        observacion_inicial: `Base final limpia Equifax | Sin gestion previa | Color ${row.color_equifax} | Lead score ${row.lead_score || 0}`,
        assigned_user_id: assignedUserId,
        assignment_rule: 'round_robin_rut_intelligence_fast',
        assignment_status: 'assigned',
        workflow_status: 'pending',
        priority_bucket: priorityBucket(row),
        priority_score: priorityScore(row),
        sort_key: `EQUIFAX | ${priorityBucket(row)} | ${String(priorityScore(row)).padStart(4, '0')} | ${String(displayName(row)).toLowerCase()} | ${row.rutid_normalized}`,
        attempts_count: 0,
        source_system: SOURCE_SYSTEM,
        source_external_key: key,
        source_payload: payload(row),
        injected_at: new Date().toISOString(),
        last_synced_at: new Date().toISOString(),
        mail_review_stage: 'pending_review',
      }
      const current = existing.get(key)
      if (current?.id) updates.push({ id: current.id, ...lead })
      else inserts.push(lead)
    })
    if (inserts.length) {
      const { data, error } = await crm.from('campaign_base_leads').insert(inserts).select('id')
      if (error) throw new Error(`insert leads: ${error.message}`)
      inserted += data?.length ?? 0
    }
    if (updates.length) {
      const { data, error } = await crm.from('campaign_base_leads').upsert(updates, { onConflict: 'id' }).select('id')
      if (error) throw new Error(`update leads: ${error.message}`)
      updated += data?.length ?? updates.length
    }
  }
  return { inserted, updated, skipped }
}

async function countLoaded(importJobId) {
  const [sourceTotal, sourcePending, importTotal] = await Promise.all([
    crm.from('campaign_base_leads').select('id', { count: 'exact', head: true }).eq('campaign_id', CAMPAIGN_ID).eq('source_system', SOURCE_SYSTEM),
    crm.from('campaign_base_leads').select('id', { count: 'exact', head: true }).eq('campaign_id', CAMPAIGN_ID).eq('source_system', SOURCE_SYSTEM).eq('workflow_status', 'pending'),
    crm.from('campaign_base_leads').select('id', { count: 'exact', head: true }).eq('import_job_id', importJobId),
  ])
  return {
    source_total: sourceTotal.count,
    source_pending: sourcePending.count,
    import_total: importTotal.count,
  }
}

async function main() {
  const rows = parseRows()
  const importJobId = await ensureImportJob(rows)
  const agents = await fetchAgents()
  const contacts = await fetchContactsByRut(rows)
  const insertedContacts = await insertMissingContacts(rows, contacts)
  const campaignContacts = await upsertCampaignContacts(rows, contacts)
  const leads = await upsertLeads(rows, contacts, agents, importJobId)
  const verification = await countLoaded(importJobId)
  console.log(JSON.stringify({
    ok: true,
    campaign_name: CAMPAIGN_NAME,
    campaign_id: CAMPAIGN_ID,
    target_rows: rows.length,
    import_job_id: importJobId,
    agents: agents.length,
    contacts_found_or_created: contacts.size,
    inserted_missing_contacts: insertedContacts,
    campaign_contacts: campaignContacts,
    leads,
    verification,
    finished_at: new Date().toISOString(),
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
