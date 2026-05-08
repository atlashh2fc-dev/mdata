import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.production')

const CAMPAIGN_ID = process.env.EQUIFAX_CAMPAIGN_ID || 'b5df1732-476e-4475-a21a-bae8e0942829'
const SOURCE_SYSTEMS = (process.env.EQUIFAX_CLEANUP_SOURCE_SYSTEMS || 'rut_intelligence_equifax_reference,rut_intelligence_equifax_productive')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)
const MAX_SHARED_PHONE_RUTS = Number.parseInt(process.env.MAX_SHARED_PHONE_RUTS || '3', 10)
const APPLY = process.env.APPLY === '1'
const PAGE_SIZE = 1000
const CHUNK_SIZE = 150
const RUN_AT = new Date().toISOString()
const OUTPUT_DIR = path.join(process.cwd(), 'outputs', 'equifax_phone_cleanup', RUN_AT.replace(/[:.]/g, '-'))

const supabaseUrl = process.env.REGISTRO_INTEL_SUPABASE_URL
const serviceRoleKey = process.env.REGISTRO_INTEL_SERVICE_ROLE_KEY || process.env.REGISTRO_INTEL_SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Faltan REGISTRO_INTEL_SUPABASE_URL y REGISTRO_INTEL_SERVICE_ROLE_KEY.')
}

const crm = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function chunk(items, size = CHUNK_SIZE) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

function normalizeRut(value) {
  return String(value ?? '').toUpperCase().replace(/[^0-9K]/g, '').replace(/^0+/, '') || null
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

function localPhone(value) {
  const phone = normalizePhone(value)
  if (!phone) return null
  return phone.replace(/\D/g, '').slice(-9)
}

function hasLowInformationPhonePattern(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '')
  const local = digits.startsWith('56') ? digits.slice(2) : digits
  if (!local) return false
  if (/^(\d)\1{7,}$/.test(local)) return true
  if (/^(2|9)(0{7,}|1{7,}|2{7,}|5{7,}|9{7,})$/.test(local)) return true
  return false
}

function removeBadPhonesFromArray(value, badPhones) {
  if (!Array.isArray(value)) return []
  return value.filter(item => {
    const normalized = normalizePhone(item)
    return !normalized || !badPhones.has(normalized)
  })
}

function clearIfBad(value, badPhones) {
  const normalized = normalizePhone(value)
  return normalized && badPhones.has(normalized) ? null : value
}

function uniqueStrings(values) {
  return [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))]
}

async function fetchPaged(table, select, applyQuery) {
  const rows = []
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = crm.from(table).select(select).range(from, from + PAGE_SIZE - 1)
    query = applyQuery(query)
    const { data, error } = await query
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...(data ?? []))
    console.error(`[cleanup] ${table}: ${rows.length} filas leidas`)
    if (!data || data.length < PAGE_SIZE) break
  }
  return rows
}

async function fetchLeads() {
  const byId = new Map()
  for (const sourceSystem of SOURCE_SYSTEMS) {
    const rows = await fetchPaged(
      'campaign_base_leads',
      'id,campaign_id,contact_id,rut_empresa,razon_social,nombre_cliente,observacion_inicial,observacion_actual,sort_key,source_system,source_payload,updated_at',
      query => query.eq('campaign_id', CAMPAIGN_ID).eq('source_system', sourceSystem).order('id', { ascending: true })
    )
    for (const row of rows) byId.set(row.id, row)
  }
  return [...byId.values()]
}

async function fetchLeadPhones(leadIds) {
  const rows = []
  for (const ids of chunk(leadIds, 300)) {
    const { data, error } = await crm
      .from('campaign_base_lead_phones')
      .select('id,lead_id,position,label,phone_raw,phone_normalized,is_primary,is_callable,created_at')
      .in('lead_id', ids)
    if (error) throw new Error(`campaign_base_lead_phones: ${error.message}`)
    rows.push(...(data ?? []))
    if (rows.length % 3000 < (data?.length ?? 0)) console.error(`[cleanup] campaign_base_lead_phones: ${rows.length} filas leidas`)
  }
  return rows
}

async function fetchContacts(contactIds) {
  const rows = []
  for (const ids of chunk(uniqueStrings(contactIds), 300)) {
    const { data, error } = await crm
      .from('contacts')
      .select('id,rut,full_name,email,phones,phone_mobile,phone_contact,phone_normalized,tags,custom_fields,updated_at')
      .in('id', ids)
    if (error) throw new Error(`contacts: ${error.message}`)
    rows.push(...(data ?? []))
    if (rows.length % 3000 < (data?.length ?? 0)) console.error(`[cleanup] contacts: ${rows.length} filas leidas`)
  }
  return rows
}

function collectPhoneEvidence(leads, leadPhones, contactsById) {
  const rutidsByPhone = new Map()
  const evidenceByLeadId = new Map()

  const addEvidence = (lead, source, value) => {
    const phone = normalizePhone(value)
    if (!phone) return
    const rut = normalizeRut(lead.rut_empresa) || lead.id
    if (!rutidsByPhone.has(phone)) rutidsByPhone.set(phone, new Set())
    rutidsByPhone.get(phone).add(rut)
    if (!evidenceByLeadId.has(lead.id)) evidenceByLeadId.set(lead.id, new Set())
    evidenceByLeadId.get(lead.id).add(phone)
  }

  const leadsById = new Map(leads.map(lead => [lead.id, lead]))
  for (const phoneRow of leadPhones) {
    const lead = leadsById.get(phoneRow.lead_id)
    if (lead) addEvidence(lead, 'lead_phone', phoneRow.phone_normalized || phoneRow.phone_raw)
  }
  for (const lead of leads) {
    const contact = contactsById.get(lead.contact_id)
    addEvidence(lead, 'source_payload', lead.source_payload?.telefono)
    addEvidence(lead, 'contact_normalized', contact?.phone_normalized)
    addEvidence(lead, 'contact_mobile', contact?.phone_mobile)
    addEvidence(lead, 'contact_phone', contact?.phone_contact)
    for (const phone of contact?.phones ?? []) addEvidence(lead, 'contact_phones', phone)
  }

  return { rutidsByPhone, evidenceByLeadId }
}

function buildCleanupPlan(leads, leadPhones, contacts) {
  const contactsById = new Map(contacts.map(contact => [contact.id, contact]))
  const { rutidsByPhone, evidenceByLeadId } = collectPhoneEvidence(leads, leadPhones, contactsById)
  const badPhones = new Set()
  const badPhoneSummary = []

  for (const [phone, rutids] of rutidsByPhone.entries()) {
    const reason = hasLowInformationPhonePattern(phone)
      ? 'patron_generico'
      : rutids.size > MAX_SHARED_PHONE_RUTS
        ? `telefono_compartido_${rutids.size}_ruts`
        : null
    if (!reason) continue
    badPhones.add(phone)
    badPhoneSummary.push({ phone, rutids: rutids.size, reason })
  }

  const impactedLeadIds = new Set()
  for (const [leadId, phones] of evidenceByLeadId.entries()) {
    if ([...phones].some(phone => badPhones.has(phone))) impactedLeadIds.add(leadId)
  }

  const badLeadPhones = leadPhones.filter(row => badPhones.has(normalizePhone(row.phone_normalized || row.phone_raw)))
  const impactedContactIds = new Set(
    leads
      .filter(lead => impactedLeadIds.has(lead.id) && lead.contact_id)
      .map(lead => lead.contact_id)
  )
  const impactedContacts = contacts.filter(contact => impactedContactIds.has(contact.id))

  return {
    badPhones,
    badPhoneSummary: badPhoneSummary.sort((a, b) => b.rutids - a.rutids || a.phone.localeCompare(b.phone)),
    impactedLeadIds,
    badLeadPhones,
    impactedContacts,
  }
}

function cleanedLeadRow(lead, badPhones) {
  const removedPhones = uniqueStrings([
    normalizePhone(lead.source_payload?.telefono),
    ...String(lead.observacion_inicial ?? '').match(/\+?\d[\d\s().-]{7,}/g)?.map(normalizePhone) ?? [],
    ...String(lead.observacion_actual ?? '').match(/\+?\d[\d\s().-]{7,}/g)?.map(normalizePhone) ?? [],
    ...String(lead.sort_key ?? '').match(/\+?\d[\d\s().-]{7,}/g)?.map(normalizePhone) ?? [],
  ].filter(phone => phone && badPhones.has(phone)))

  const sourcePayload = {
    ...(lead.source_payload ?? {}),
    telefono: badPhones.has(normalizePhone(lead.source_payload?.telefono)) ? null : lead.source_payload?.telefono,
    telefonos_limpiados_masivos_count: removedPhones.length,
    telefono_limpiado_at: RUN_AT,
    cleanup_reason: 'telefono_masivo_no_confiable',
  }

  const stripPhones = value => {
    let text = String(value ?? '')
    for (const phone of badPhones) {
      const local = localPhone(phone)
      text = text
        .replaceAll(phone, '[telefono removido]')
        .replaceAll(phone.replace(/\D/g, ''), '[telefono removido]')
      if (local) text = text.replaceAll(local, '[telefono removido]')
    }
    return text.trim() || null
  }

  return {
    id: lead.id,
    observacion_inicial: stripPhones(lead.observacion_inicial),
    observacion_actual: stripPhones(lead.observacion_actual),
    sort_key: `EQUIFAX BUSQUEDA | SIN TELEFONO MASIVO | ${normalizeRut(lead.rut_empresa) ?? lead.id}`,
    source_payload: sourcePayload,
    last_synced_at: RUN_AT,
    updated_at: RUN_AT,
  }
}

function cleanedContactRow(contact, badPhones) {
  const cleanedPhones = removeBadPhonesFromArray(contact.phones, badPhones)
  const removedPhones = uniqueStrings([
    normalizePhone(contact.phone_normalized),
    normalizePhone(contact.phone_contact),
    normalizePhone(contact.phone_mobile),
    ...(contact.phones ?? []).map(normalizePhone),
  ].filter(phone => phone && badPhones.has(phone)))

  const customFields = {
    ...(contact.custom_fields ?? {}),
      equifax_phone_cleanup: {
        cleaned_at: RUN_AT,
      removed_phones_count: removedPhones.length,
      reason: 'telefono_masivo_no_confiable',
      source_systems: SOURCE_SYSTEMS,
    },
  }

  return {
    id: contact.id,
    phones: cleanedPhones,
    phone_mobile: clearIfBad(contact.phone_mobile, badPhones),
    phone_contact: clearIfBad(contact.phone_contact, badPhones),
    phone_normalized: clearIfBad(contact.phone_normalized, badPhones),
    custom_fields: customFields,
    updated_at: RUN_AT,
  }
}

async function writeBackup({ leads, leadPhones, contacts, plan }) {
  await fs.promises.mkdir(OUTPUT_DIR, { recursive: true })
  const impactedLeadSet = plan.impactedLeadIds
  const impactedContactIds = new Set(plan.impactedContacts.map(contact => contact.id))
  await fs.promises.writeFile(
    path.join(OUTPUT_DIR, 'summary.json'),
    JSON.stringify({
      run_at: RUN_AT,
      apply: APPLY,
      campaign_id: CAMPAIGN_ID,
      source_systems: SOURCE_SYSTEMS,
      max_shared_phone_ruts: MAX_SHARED_PHONE_RUTS,
      total_leads_scanned: leads.length,
      bad_phones: plan.badPhoneSummary,
      impacted_leads: impactedLeadSet.size,
      impacted_lead_phone_rows: plan.badLeadPhones.length,
      impacted_contacts: impactedContactIds.size,
    }, null, 2)
  )
  await fs.promises.writeFile(
    path.join(OUTPUT_DIR, 'backup-before.json'),
    JSON.stringify({
      leads: leads.filter(lead => impactedLeadSet.has(lead.id)),
      lead_phones: leadPhones.filter(row => plan.badLeadPhones.some(bad => bad.id === row.id)),
      contacts: contacts.filter(contact => impactedContactIds.has(contact.id)),
    }, null, 2)
  )
}

async function applyCleanup(leads, contacts, plan) {
  const impactedContactIds = new Set(plan.impactedContacts.map(contact => contact.id))
  const leadRows = leads
    .filter(lead => plan.impactedLeadIds.has(lead.id))
    .map(lead => cleanedLeadRow(lead, plan.badPhones))
  const contactRows = contacts
    .filter(contact => impactedContactIds.has(contact.id))
    .map(contact => cleanedContactRow(contact, plan.badPhones))

  let deletedLeadPhones = 0
  for (const rows of chunk(plan.badLeadPhones, 300)) {
    const { error } = await crm.from('campaign_base_lead_phones').delete().in('id', rows.map(row => row.id))
    if (error) throw new Error(`delete campaign_base_lead_phones: ${error.message}`)
    deletedLeadPhones += rows.length
  }

  let updatedLeads = 0
  for (const row of leadRows) {
    const { id, ...patch } = row
    const { error } = await crm.from('campaign_base_leads').update(patch).eq('id', id)
    if (error) throw new Error(`update campaign_base_leads ${id}: ${error.message}`)
    updatedLeads += 1
    if (updatedLeads % 250 === 0) console.error(`[cleanup] campaign_base_leads actualizados: ${updatedLeads}`)
  }

  let updatedContacts = 0
  for (const row of contactRows) {
    const { id, ...patch } = row
    const { error } = await crm.from('contacts').update(patch).eq('id', id)
    if (error) throw new Error(`update contacts ${id}: ${error.message}`)
    updatedContacts += 1
    if (updatedContacts % 250 === 0) console.error(`[cleanup] contacts actualizados: ${updatedContacts}`)
  }

  return { deletedLeadPhones, updatedLeads, updatedContacts }
}

async function verifySpecificRecords() {
  const ruts = ['77.364.393-8', '76.757.284-0', '76.079.074-5', '96.604.120-K']
  const { data, error } = await crm
    .from('campaign_base_leads')
    .select('id,rut_empresa,razon_social,contact_id,source_system')
    .eq('campaign_id', CAMPAIGN_ID)
    .eq('source_system', 'rut_intelligence_equifax_reference')
    .in('rut_empresa', ruts)
  if (error) throw new Error(`verify leads: ${error.message}`)
  return data ?? []
}

async function main() {
  console.error(`[cleanup] inicio ${APPLY ? 'APPLY' : 'DRY-RUN'} fuentes=${SOURCE_SYSTEMS.join(',')}`)
  const leads = await fetchLeads()
  console.error(`[cleanup] leads cargados: ${leads.length}`)
  const leadPhones = await fetchLeadPhones(leads.map(lead => lead.id))
  console.error(`[cleanup] telefonos de leads cargados: ${leadPhones.length}`)
  const contacts = await fetchContacts(leads.map(lead => lead.contact_id).filter(Boolean))
  console.error(`[cleanup] contactos cargados: ${contacts.length}`)
  const plan = buildCleanupPlan(leads, leadPhones, contacts)
  console.error(`[cleanup] plan: ${plan.badPhoneSummary.length} telefonos malos, ${plan.impactedLeadIds.size} leads impactados`)

  await writeBackup({ leads, leadPhones, contacts, plan })
  console.error(`[cleanup] respaldo escrito: ${OUTPUT_DIR}`)

  const result = APPLY
    ? await applyCleanup(leads, contacts, plan)
    : { deletedLeadPhones: 0, updatedLeads: 0, updatedContacts: 0 }
  const verifiedRecords = APPLY ? await verifySpecificRecords() : []

  console.log(JSON.stringify({
    ok: true,
    mode: APPLY ? 'apply' : 'dry-run',
    backup_dir: OUTPUT_DIR,
    scanned: {
      leads: leads.length,
      lead_phone_rows: leadPhones.length,
      contacts: contacts.length,
    },
    detected: {
      bad_phones: plan.badPhoneSummary.length,
      impacted_leads: plan.impactedLeadIds.size,
      impacted_lead_phone_rows: plan.badLeadPhones.length,
      impacted_contacts: plan.impactedContacts.length,
      top_bad_phones: plan.badPhoneSummary.slice(0, 12),
    },
    applied: result,
    verified_records: verifiedRecords.map(row => ({
      rut_empresa: row.rut_empresa,
      razon_social: row.razon_social,
      source_system: row.source_system,
    })),
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
