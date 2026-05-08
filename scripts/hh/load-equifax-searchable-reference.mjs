import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import Papa from 'papaparse'
import { createClient } from '@supabase/supabase-js'

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.production')

const INPUT_CSV = path.join(process.cwd(), 'outputs', 'bdd_equifax_gestiones_2026-05-07', 'BDD_pendientes_sin_gestion_target_limpio_con_colores.csv')
const CAMPAIGN_ID = 'b5df1732-476e-4475-a21a-bae8e0942829'
const CAMPAIGN_NAME = 'Equifax'
const SOURCE_SYSTEM = 'rut_intelligence_equifax_reference'
const SOURCE_KEY_PREFIX = 'equifax_search_ref_20260507'
const CREATED_BY = process.env.REGISTRO_INTEL_DEFAULT_USER_ID || '14f638a7-9cfe-4502-94e6-9c7d1e7aa1c3'
const CHUNK_SIZE = 150
const MAX_SHARED_PHONE_RUTS = Number.parseInt(process.env.MAX_SHARED_PHONE_RUTS || '3', 10)

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

function hasLowInformationPhonePattern(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '')
  const local = digits.startsWith('56') ? digits.slice(2) : digits
  if (!local) return false
  if (/^(\d)\1{7,}$/.test(local)) return true
  if (/^(2|9)(0{7,}|1{7,}|2{7,}|5{7,}|9{7,})$/.test(local)) return true
  return false
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
  if (digits.startsWith('569')) return digits.slice(-9)
  return digits.slice(-9)
}

function phoneRaw(value) {
  const phone = normalizePhone(value)
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  return digits.startsWith('56') ? digits.slice(-9) : digits
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

function payload(row) {
  return {
    source_system: SOURCE_SYSTEM,
    loaded_at: new Date().toISOString(),
    rutid: row.rutid,
    rut_formateado: row.rut_formateado,
    telefono: row.mejor_telefono,
    color_equifax: row.color_equifax,
    lead_score: toNumber(row.lead_score),
    contact_probability: toNumber(row.contact_probability),
    purchase_probability: toNumber(row.purchase_probability),
    final_clean_rows: 46266,
    searchable_reference_only: true,
    no_auto_dial: true,
  }
}

function parseRows() {
  const parsed = Papa.parse(fs.readFileSync(INPUT_CSV, 'utf8'), {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  })
  if (parsed.errors.length) throw new Error(parsed.errors[0].message)
  const candidateRows = parsed.data.flatMap(row => {
    const rut = normalizeRut(row.rutid)
    const phone = normalizePhone(row.mejor_telefono)
    if (!rut || !phone) return []
    return [{ ...row, rut_norm: rut, rut_fmt: formatRut(rut), phone_norm: phone }]
  })

  const rutidsByPhone = new Map()
  for (const row of candidateRows) {
    if (!rutidsByPhone.has(row.phone_norm)) rutidsByPhone.set(row.phone_norm, new Set())
    rutidsByPhone.get(row.phone_norm).add(row.rut_norm)
  }

  const seen = new Set()
  return candidateRows.flatMap(row => {
    if (seen.has(row.rut_norm)) return []
    const rutCount = rutidsByPhone.get(row.phone_norm)?.size ?? 0
    if (rutCount > MAX_SHARED_PHONE_RUTS || hasLowInformationPhonePattern(row.phone_norm)) return []
    seen.add(row.rut_norm)
    return [row]
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
    template_code: 'rut_intelligence_equifax_search_reference',
    mapping: {
      rut: 'rutid',
      full_name: 'razon_social_empresa',
      phone_mobile: 'mejor_telefono',
      email: 'mejor_email',
    },
    summary: {
      total: rows.length,
      source_system: SOURCE_SYSTEM,
      searchable_reference_only: true,
      no_auto_dial: true,
    },
  }).select('id').single()
  if (error || !data?.id) throw new Error(`import job: ${error?.message ?? 'sin id'}`)
  return data.id
}

async function fetchContacts(rows) {
  const map = new Map()
  for (const values of chunk(rows.map(row => row.rut_fmt), 250)) {
    const { data, error } = await crm.from('contacts').select('id,rut,phone_normalized').in('rut', values)
    if (error) throw new Error(`contacts: ${error.message}`)
    for (const contact of data ?? []) {
      const rut = normalizeRut(contact.rut)
      if (rut) map.set(rut, contact)
    }
  }
  return map
}

async function insertMissingContacts(rows, contacts) {
  const missing = rows.filter(row => !contacts.has(row.rut_norm))
  let inserted = 0
  for (const batch of chunk(missing, 150)) {
    const { data, error } = await crm.from('contacts').insert(batch.map(row => ({
      rut: row.rut_fmt,
      full_name: displayName(row),
      email: row.mejor_email || null,
      phones: phoneVariants(row.phone_norm),
      phone_mobile: mobilePhone(row.phone_norm),
      phone_contact: row.phone_norm,
      phone_normalized: row.phone_norm,
      tags: ['rut-intelligence', 'equifax', 'busqueda-operativa'],
      custom_fields: { rut_intelligence_equifax_reference: payload(row) },
      primary_campaign_id: CAMPAIGN_ID,
      created_by: CREATED_BY,
      updated_by: CREATED_BY,
    }))).select('id,rut,phone_normalized')
    if (error) throw new Error(`insert contacts: ${error.message}`)
    inserted += data?.length ?? 0
    for (const contact of data ?? []) {
      const rut = normalizeRut(contact.rut)
      if (rut) contacts.set(rut, contact)
    }
  }
  return inserted
}

async function fetchExistingLeads(rows) {
  const existing = new Map()
  for (const values of chunk(rows.map(row => sourceKey(row.rut_norm)), 250)) {
    const { data, error } = await crm.from('campaign_base_leads').select('id,source_external_key').eq('source_system', SOURCE_SYSTEM).in('source_external_key', values)
    if (error) throw new Error(`existing leads: ${error.message}`)
    for (const row of data ?? []) existing.set(row.source_external_key, row)
  }
  return existing
}

async function upsertReferenceLeads(rows, contacts, importJobId) {
  const existing = await fetchExistingLeads(rows)
  let inserted = 0
  let updated = 0
  let skipped = 0
  for (const batch of chunk(rows, 150)) {
    const inserts = []
    const updates = []
    for (const row of batch) {
      const contact = contacts.get(row.rut_norm)
      if (!contact?.id) {
        skipped += 1
        continue
      }
      const key = sourceKey(row.rut_norm)
      const lead = {
        campaign_id: CAMPAIGN_ID,
        import_job_id: importJobId,
        row_number: Number(row.fila_origen || 0),
        contact_id: contact.id,
        origin_raw: 'RUT Intelligence Equifax búsqueda',
        origin_normalized: 'unknown',
        rut_empresa: row.rut_fmt,
        razon_social: displayName(row),
        mail: row.mejor_email || null,
        nombre_cliente: displayName(row),
        asesor_raw: 'Equifax búsqueda operativa',
        direccion_empresa: row.direccion_preferida || null,
        tipificacion_inicial: 'DISPONIBLE_BUSQUEDA',
        observacion_inicial: `Disponible para búsqueda operativa Equifax | Tel ${row.phone_norm} | Color ${row.color_equifax} | Sin gestión previa`,
        tipificacion_actual: 'DISPONIBLE_BUSQUEDA',
        observacion_actual: `Disponible para búsqueda por RUT/teléfono. No auto-discado. Tel ${row.phone_norm}`,
        assignment_rule: 'unassigned',
        assignment_status: 'managed',
        workflow_status: 'managed',
        priority_bucket: 100,
        priority_score: toNumber(row.lead_score),
        sort_key: `EQUIFAX BUSQUEDA | ${row.phone_norm} | ${row.rut_norm}`,
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
    }
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

async function syncLeadPhones(rows) {
  const existing = await fetchExistingLeads(rows)
  let inserted = 0
  let skipped = 0

  for (const batch of chunk(rows, 150)) {
    const leadRows = batch.flatMap(row => {
      const lead = existing.get(sourceKey(row.rut_norm))
      if (!lead?.id) return []
      return [{ lead, row }]
    })
    const leadIds = leadRows.map(item => item.lead.id)
    if (!leadIds.length) continue

    const phoneLeadIds = new Set()
    for (const ids of chunk(leadIds, 150)) {
      const { data, error } = await crm.from('campaign_base_lead_phones').select('lead_id').in('lead_id', ids)
      if (error) throw new Error(`lead phones: ${error.message}`)
      for (const item of data ?? []) phoneLeadIds.add(item.lead_id)
    }

    const inserts = leadRows.flatMap(({ lead, row }) => {
      if (phoneLeadIds.has(lead.id)) return []
      const raw = phoneRaw(row.phone_norm)
      if (!raw) {
        skipped += 1
        return []
      }
      return [{
        lead_id: lead.id,
        position: 1,
        label: 'principal',
        phone_raw: raw,
        phone_normalized: row.phone_norm,
        is_primary: true,
        is_callable: true,
      }]
    })
    if (inserts.length) {
      const { data, error } = await crm.from('campaign_base_lead_phones').insert(inserts).select('id')
      if (error) throw new Error(`insert lead phones: ${error.message}`)
      inserted += data?.length ?? 0
    }
  }

  return { inserted, skipped }
}

async function verify(importJobId) {
  const { count: total } = await crm.from('campaign_base_leads').select('id', { count: 'exact', head: true }).eq('campaign_id', CAMPAIGN_ID).eq('source_system', SOURCE_SYSTEM)
  const { count: imported } = await crm.from('campaign_base_leads').select('id', { count: 'exact', head: true }).eq('import_job_id', importJobId)
  return { total_reference_leads: total, import_reference_leads: imported }
}

async function main() {
  const rows = parseRows()
  const importJobId = await ensureImportJob(rows)
  const contacts = await fetchContacts(rows)
  const insertedContacts = await insertMissingContacts(rows, contacts)
  const leads = await upsertReferenceLeads(rows, contacts, importJobId)
  const leadPhones = await syncLeadPhones(rows)
  const verification = await verify(importJobId)
  console.log(JSON.stringify({
    ok: true,
    campaign: CAMPAIGN_NAME,
    campaign_id: CAMPAIGN_ID,
    rows: rows.length,
    inserted_contacts: insertedContacts,
    contacts_available: contacts.size,
    import_job_id: importJobId,
    leads,
    lead_phones: leadPhones,
    verification,
    finished_at: new Date().toISOString(),
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
