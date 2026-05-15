import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.production')
process.loadEnvFile?.('.env.local')

const { Client } = pg

const CAMPAIGN_ID = '7b8a2da9-789b-4642-ab2b-59fe93dd8785'
const CAMPAIGN_NAME = 'Dicom OT'
const CREATED_BY = process.env.REGISTRO_INTEL_DEFAULT_USER_ID || '14f638a7-9cfe-4502-94e6-9c7d1e7aa1c3'
const OUT_DIR = path.join(process.cwd(), 'outputs', 'dicom_ot_enrichment_2026-05-15')
const NOW = new Date().toISOString()

const AGENTS = new Map([
  ['381d7bab-54cb-43ae-9a4a-17a564a95cde', 'Cristian Rodriguez'],
  ['a8b02351-0e25-461a-924b-84cf097b092b', 'Benjamin Marroquin'],
  ['43f3d92e-7342-489e-8ffb-fcefde673abb', 'Daniela Ramos'],
])

const crmUrl = process.env.REGISTRO_INTEL_SUPABASE_URL
const crmKey = process.env.REGISTRO_INTEL_SERVICE_ROLE_KEY || process.env.REGISTRO_INTEL_SUPABASE_SERVICE_ROLE_KEY

if (!crmUrl || !crmKey) throw new Error('Faltan credenciales REGISTRO_INTEL para el CRM.')

const crm = createClient(crmUrl, crmKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function chunk(items, size = 500) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

function compact(value) {
  const text = String(value ?? '').trim()
  return text || null
}

function normalizeRut(value) {
  return String(value ?? '').toUpperCase().replace(/[^0-9K]/g, '').replace(/^0+/, '') || null
}

function formatRut(value) {
  const rut = normalizeRut(value)
  if (!rut || rut.length < 2) return String(value ?? '')
  return `${rut.slice(0, -1)}-${rut.slice(-1)}`
}

function normalizeEmail(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return text.includes('@') ? text : null
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

function phoneVariants(...values) {
  const variants = []
  for (const value of values) {
    const normalized = normalizePhone(value)
    if (!normalized) continue
    const digits = normalized.replace(/\D/g, '')
    variants.push(normalized, digits)
    if (digits.startsWith('56') && digits.length > 9) variants.push(digits.slice(-9))
  }
  return uniqueStrings(variants)
}

function uniqueStrings(values) {
  return [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))]
}

function truncate(value, maxLength = 900) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`
}

function mergeCustomFields(existing, patch) {
  return {
    ...(existing && typeof existing === 'object' ? existing : {}),
    ...patch,
  }
}

function postgresConnectionString() {
  const raw = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL
  if (!raw) throw new Error('Falta POSTGRES_URL para leer la base local enriquecida.')
  const url = new URL(raw)
  url.searchParams.delete('sslmode')
  return url.toString()
}

function buildDisplaySummary(row) {
  const parts = []
  if (row?.rubro_economico_ultimo) parts.push(`Rubro: ${row.rubro_economico_ultimo}`)
  if (row?.actividad_economica_ultima) parts.push(`Actividad: ${row.actividad_economica_ultima}`)
  if (row?.segmento_tamano_empresa) parts.push(`Segmento: ${row.segmento_tamano_empresa}`)
  if (row?.ultimo_tramo_ventas) parts.push(`Ventas 2024: ${row.ultimo_tramo_ventas}`)
  if (row?.trabajadores_2024 !== null && row?.trabajadores_2024 !== undefined) parts.push(`Trabajadores: ${row.trabajadores_2024}`)
  if (row?.resultado_tendencia) parts.push(`Tendencia: ${row.resultado_tendencia}`)
  if (row?.lead_temperature) parts.push(`Color IA: ${row.lead_temperature}`)
  if (row?.lead_score !== null && row?.lead_score !== undefined) parts.push(`Score: ${Math.round(Number(row.lead_score))}`)
  if (row?.n_bienes_raices !== null && row?.n_bienes_raices !== undefined) parts.push(`BBRR: ${row.n_bienes_raices}`)
  if (row?.n_autos !== null && row?.n_autos !== undefined) parts.push(`Autos: ${row.n_autos}`)
  return truncate(parts.join(' | '), 700)
}

function buildCustomPayload(row, executive) {
  return {
    enriched_at: NOW,
    source: 'rut_intelligence_empresas_comercial_unificada',
    company: {
      rutid: row?.rutid ?? null,
      rut_formateado: row?.rut_formateado ?? null,
      razon_social: row?.company_name ?? null,
      tipo_contribuyente: row?.tipo_contribuyente_ultimo ?? null,
      subtipo_contribuyente: row?.subtipo_contribuyente_ultimo ?? null,
      segmento_tamano_empresa: row?.segmento_tamano_empresa ?? null,
      es_pyme: row?.es_pyme ?? null,
      es_gran_empresa: row?.es_gran_empresa ?? null,
      rubro_economico: row?.rubro_economico_ultimo ?? null,
      subrubro_economico: row?.subrubro_economico_ultimo ?? null,
      actividad_economica: row?.actividad_economica_ultima ?? null,
      region: row?.region ?? null,
      comuna: row?.comuna ?? null,
      direccion: row?.domicilio_direccion ?? null,
      domicilio_fuente: row?.domicilio_fuente ?? null,
    },
    commercial: {
      ultimo_tramo_ventas: row?.ultimo_tramo_ventas ?? null,
      tramo_ventas_2020: row?.tramo_ventas_2020 ?? null,
      tramo_ventas_2021: row?.tramo_ventas_2021 ?? null,
      tramo_ventas_2022: row?.tramo_ventas_2022 ?? null,
      tramo_ventas_2023: row?.tramo_ventas_2023 ?? null,
      tramo_ventas_2024: row?.tramo_ventas_2024 ?? null,
      trabajadores_2024: row?.trabajadores_2024 ?? null,
      resultado_tendencia: row?.resultado_tendencia ?? null,
      movimientos_alza: row?.movimientos_alza ?? null,
      movimientos_baja: row?.movimientos_baja ?? null,
      termino_giro: row?.fecha_termino_giro_ultima ?? null,
    },
    assets: {
      n_autos: row?.n_autos ?? null,
      n_bienes_raices: row?.n_bienes_raices ?? null,
      totalavaluos: row?.totalavaluos ?? null,
      score_patrimonial: row?.score_patrimonial ?? null,
      cobertura_pct: row?.cobertura_pct ?? null,
    },
    contactability: {
      best_phone: row?.best_phone ?? null,
      best_email: row?.best_email ?? null,
      contactability_score: row?.contactability_score ?? null,
      priority_score: row?.persona_priority_score ?? null,
      known_phone_count: row?.known_phone_count ?? null,
      known_email_count: row?.known_email_count ?? null,
      opened_events: row?.opened_events ?? null,
      clicked_events: row?.clicked_events ?? null,
      next_best_action: row?.next_best_action ?? null,
    },
    equifax_ai: {
      lead_temperature: row?.lead_temperature ?? null,
      lead_score: row?.lead_score ?? null,
      contact_probability: row?.contact_probability ?? null,
      interest_probability: row?.interest_probability ?? null,
      purchase_probability: row?.purchase_probability ?? null,
      recommended_channel: row?.recommended_channel ?? null,
      recommended_hour: row?.recommended_hour ?? null,
      reason_tags: row?.reason_tags ?? null,
    },
    executive_contact: executive ?? null,
    display_summary: buildDisplaySummary(row),
  }
}

async function fetchCrmLeads() {
  const rows = []
  for (let start = 0; ; start += 1000) {
    const { data, error } = await crm
      .from('campaign_base_leads')
      .select('id,campaign_id,contact_id,row_number,rut_empresa,razon_social,mail,nombre_cliente,direccion_empresa,observacion_inicial,assigned_user_id,assignment_status,workflow_status,priority_score,created_at,updated_at,mail_engagement_boost')
      .eq('campaign_id', CAMPAIGN_ID)
      .in('assigned_user_id', [...AGENTS.keys()])
      .range(start, start + 999)

    if (error) throw new Error(`No pude leer leads CRM: ${error.message}`)
    rows.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }
  return rows
}

async function fetchExistingContacts(rutids, emails) {
  const byRut = new Map()
  const byEmail = new Map()
  const select = 'id,rut,full_name,email,phones,phone_mobile,phone_contact,phone_normalized,address_line1,comuna,ciudad,region,product_plan,tags,custom_fields,primary_campaign_id,created_by,updated_by'

  for (const values of chunk([...rutids].map(formatRut), 200)) {
    const { data, error } = await crm.from('contacts').select(select).in('rut', values)
    if (error) throw new Error(`No pude leer contactos por RUT: ${error.message}`)
    for (const contact of data ?? []) {
      const rut = normalizeRut(contact.rut)
      const email = normalizeEmail(contact.email)
      if (rut && !byRut.has(rut)) byRut.set(rut, contact)
      if (email && !byEmail.has(email)) byEmail.set(email, contact)
    }
  }

  for (const values of chunk([...emails], 200)) {
    const { data, error } = await crm.from('contacts').select(select).in('email', values)
    if (error) throw new Error(`No pude leer contactos por email: ${error.message}`)
    for (const contact of data ?? []) {
      const rut = normalizeRut(contact.rut)
      const email = normalizeEmail(contact.email)
      if (rut && !byRut.has(rut)) byRut.set(rut, contact)
      if (email && !byEmail.has(email)) byEmail.set(email, contact)
    }
  }

  return { byRut, byEmail }
}

async function fetchLocalEnrichment(rutids) {
  const client = new Client({
    connectionString: postgresConnectionString(),
    ssl: { rejectUnauthorized: false },
  })
  await client.connect()
  await client.query('set statement_timeout = 0')
  await client.query('create temporary table temp_dicom_rutids (rutid text primary key, rutid_padded text not null)')

  for (const values of chunk([...rutids], 1000)) {
    const placeholders = values.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`).join(',')
    const params = values.flatMap(value => [value, value.padStart(10, '0')])
    await client.query(`insert into temp_dicom_rutids (rutid, rutid_padded) values ${placeholders} on conflict do nothing`, params)
  }

  const { rows } = await client.query(`
    with base as (
      select
        t.rutid as lookup_rutid,
        ecu.*
      from temp_dicom_rutids t
      left join public.empresas_comercial_unificada ecu
        on ecu.rutid = t.rutid or ecu.rutid = t.rutid_padded
    ),
    contact_points as (
      select
        t.rutid as lookup_rutid,
        string_agg(distinct contact_value, ' | ') filter (
          where lower(contact_type) in ('email','mail')
             or contact_value ~* '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
        ) as emails_contactos,
        string_agg(distinct contact_value, ' | ') filter (
          where lower(contact_type) in ('phone','telefono','teléfono','fono','celular','mobile')
             or regexp_replace(contact_value, '[^0-9]', '', 'g') ~ '^[0-9]{8,}$'
        ) as telefonos_contactos,
        count(*) as total_contact_points
      from public.persona_contact_points
      join temp_dicom_rutids t
        on persona_contact_points.rutid = t.rutid or persona_contact_points.rutid = t.rutid_padded
      group by t.rutid
    )
    select
      b.lookup_rutid as rutid,
      coalesce(b.razon_social, els.company_name, elf.company_name) as company_name,
      b.rut as rut_numero,
      b.dv,
      case
        when b.lookup_rutid is not null and length(b.lookup_rutid) >= 2
          then substring(b.lookup_rutid, 1, length(b.lookup_rutid)-1) || '-' || substring(b.lookup_rutid, length(b.lookup_rutid), 1)
        else b.lookup_rutid
      end as rut_formateado,
      b.fuente_universo_empresa,
      b.segmento_tamano_empresa,
      b.es_pyme,
      b.es_gran_empresa,
      b.es_corporacion,
      b.email,
      b.fono_cel,
      b.domicilio_direccion,
      b.domicilio_fuente,
      coalesce(b.region, elf.region) as region,
      coalesce(b.comuna, elf.comuna) as comuna,
      b.n_autos,
      b.n_bienes_raices,
      b.totalavaluos,
      b.score_patrimonial,
      b.cobertura_pct,
      b.tipo_contribuyente_ultimo,
      b.subtipo_contribuyente_ultimo,
      b.rubro_economico_ultimo,
      b.subrubro_economico_ultimo,
      b.actividad_economica_ultima,
      b.tramo_ventas_2020,
      b.tramo_ventas_2021,
      b.tramo_ventas_2022,
      b.tramo_ventas_2023,
      b.tramo_ventas_2024,
      b.trabajadores_2024,
      b.ultimo_tramo_ventas,
      b.resultado_tendencia,
      b.movimientos_alza,
      b.movimientos_baja,
      b.fecha_termino_giro_ultima,
      ps.contactability_score,
      ps.priority_score as persona_priority_score,
      ps.best_phone,
      ps.best_email,
      ps.known_phone_count,
      ps.known_email_count,
      ps.opened_events,
      ps.clicked_events,
      ps.next_best_action,
      els.lead_temperature,
      els.lead_score,
      els.contact_probability,
      els.interest_probability,
      els.purchase_probability,
      els.recommended_channel,
      els.recommended_hour,
      els.reason_tags,
      cp.emails_contactos,
      cp.telefonos_contactos,
      cp.total_contact_points
    from base b
    left join public.persona_scores ps
      on ps.rutid = b.lookup_rutid or ps.rutid = lpad(b.lookup_rutid, 10, '0')
    left join public.equifax_lead_scores els
      on els.rutid = b.lookup_rutid or els.rutid = lpad(b.lookup_rutid, 10, '0')
    left join public.equifax_lead_features elf
      on elf.rutid = b.lookup_rutid or elf.rutid = lpad(b.lookup_rutid, 10, '0')
    left join contact_points cp
      on cp.lookup_rutid = b.lookup_rutid
  `)

  const { rows: executiveRows } = await client.query(`
    select
      t.rutid,
      razon_social,
      rutid_ejecutivo,
      nombre_ejecutivo,
      area,
      cargo,
      email,
      celular,
      telefono_comercial,
      mejor_telefono,
      contact_priority
    from public.company_best_executive_contact
    join temp_dicom_rutids t
      on company_best_executive_contact.rutid = t.rutid or company_best_executive_contact.rutid = t.rutid_padded
  `)

  await client.end()

  return {
    enrichmentByRut: new Map(rows.map(row => [row.rutid, row])),
    executivesByRut: new Map(executiveRows.map(row => [row.rutid, row])),
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const leads = await fetchCrmLeads()
  const rutids = new Set(leads.map(lead => normalizeRut(lead.rut_empresa)).filter(Boolean))
  const emails = new Set(leads.map(lead => normalizeEmail(lead.mail)).filter(Boolean))
  const before = {
    total_leads: leads.length,
    with_contact_before: leads.filter(lead => lead.contact_id).length,
    by_agent: Object.fromEntries([...AGENTS.entries()].map(([id, name]) => [
      name,
      leads.filter(lead => lead.assigned_user_id === id).length,
    ])),
  }

  fs.writeFileSync(path.join(OUT_DIR, 'backup-leads-before.json'), JSON.stringify(leads, null, 2))

  const [existingContacts, local] = await Promise.all([
    fetchExistingContacts(rutids, emails),
    fetchLocalEnrichment(rutids),
  ])

  const contactByRut = new Map(existingContacts.byRut)
  const contactByEmail = new Map(existingContacts.byEmail)
  const contactInserts = []
  const contactUpdates = []
  const leadUpdates = []
  let matchedCompanyRows = 0
  let plannedExistingLinks = 0

  for (const lead of leads) {
    const rut = normalizeRut(lead.rut_empresa)
    if (!rut) continue

    const currentEmail = normalizeEmail(lead.mail)
    const enrichment = local.enrichmentByRut.get(rut) ?? null
    const executive = local.executivesByRut.get(rut) ?? null
    if (enrichment?.company_name) matchedCompanyRows += 1

    const payload = buildCustomPayload(enrichment, executive)
    const bestEmail =
      currentEmail ||
      normalizeEmail(enrichment?.best_email) ||
      normalizeEmail(enrichment?.email) ||
      normalizeEmail(enrichment?.emails_contactos)
    const bestPhone =
      normalizePhone(enrichment?.best_phone) ||
      normalizePhone(enrichment?.fono_cel) ||
      normalizePhone(enrichment?.telefonos_contactos) ||
      normalizePhone(executive?.mejor_telefono)
    const companyName =
      compact(enrichment?.company_name) ||
      compact(lead.razon_social) ||
      compact(lead.nombre_cliente) ||
      formatRut(rut)
    const address = compact(enrichment?.domicilio_direccion) || compact(lead.direccion_empresa)
    const comuna = compact(enrichment?.comuna)
    const region = compact(enrichment?.region)
    const tags = ['rut-intelligence', 'dicom-ot', 'empresa-enriquecida']
    if (enrichment?.lead_temperature) tags.push(`ia:${enrichment.lead_temperature}`)

    const customPatch = {
      rut_intelligence_empresa: payload,
      dicom_ot_enrichment: {
        enriched_at: NOW,
        campaign_id: CAMPAIGN_ID,
        campaign_name: CAMPAIGN_NAME,
        assigned_agent_id: lead.assigned_user_id,
        assigned_agent_name: AGENTS.get(lead.assigned_user_id),
        lead_id: lead.id,
      },
    }

    const existingContact = !lead.contact_id
      ? (contactByRut.get(rut) || (currentEmail ? contactByEmail.get(currentEmail) : null))
      : null

    if (existingContact?.id) {
      plannedExistingLinks += 1
      contactUpdates.push({
        id: existingContact.id,
        rut: existingContact.rut || formatRut(rut),
        full_name: existingContact.full_name || companyName,
        email: existingContact.email || bestEmail || null,
        phones: uniqueStrings([...(existingContact.phones ?? []), ...phoneVariants(bestPhone, existingContact.phone_normalized, existingContact.phone_mobile, existingContact.phone_contact)]),
        phone_mobile: existingContact.phone_mobile || mobilePhone(bestPhone),
        phone_contact: existingContact.phone_contact || bestPhone,
        phone_normalized: existingContact.phone_normalized || bestPhone,
        address_line1: existingContact.address_line1 || address,
        comuna: existingContact.comuna || comuna,
        ciudad: existingContact.ciudad || comuna,
        region: existingContact.region || region,
        product_plan: existingContact.product_plan || enrichment?.rubro_economico_ultimo || enrichment?.segmento_tamano_empresa || null,
        tags: uniqueStrings([...(existingContact.tags ?? []), ...tags]),
        custom_fields: mergeCustomFields(existingContact.custom_fields, customPatch),
        primary_campaign_id: existingContact.primary_campaign_id || CAMPAIGN_ID,
        created_by: existingContact.created_by || CREATED_BY,
        updated_by: CREATED_BY,
        updated_at: NOW,
      })
    } else if (!lead.contact_id) {
      contactInserts.push({
        leadId: lead.id,
        row: {
          rut: formatRut(rut),
          full_name: companyName,
          email: bestEmail || null,
          phones: phoneVariants(bestPhone),
          phone_mobile: mobilePhone(bestPhone),
          phone_contact: bestPhone,
          phone_normalized: bestPhone,
          address_line1: address,
          comuna,
          ciudad: comuna,
          region,
          product_plan: enrichment?.rubro_economico_ultimo || enrichment?.segmento_tamano_empresa || null,
          tags: uniqueStrings(tags),
          custom_fields: customPatch,
          primary_campaign_id: CAMPAIGN_ID,
          created_by: CREATED_BY,
          updated_by: CREATED_BY,
        },
      })
    }

    const displaySummary = buildDisplaySummary(enrichment)
    const enrichmentNote = displaySummary
      ? `RI empresa: ${displaySummary}`
      : 'RI empresa: sin match ampliado en base empresas; ficha normalizada por RUT.'
    const currentObservation = compact(lead.observacion_inicial)
    const nextObservation = currentObservation?.includes('RI empresa:')
      ? currentObservation
      : truncate([currentObservation, enrichmentNote].filter(Boolean).join(' | '), 950)

    leadUpdates.push({
      id: lead.id,
      contact_id: lead.contact_id,
      rut_empresa: lead.rut_empresa || formatRut(rut),
      razon_social: lead.razon_social || companyName,
      mail: lead.mail || bestEmail || null,
      nombre_cliente: lead.nombre_cliente || companyName,
      direccion_empresa: lead.direccion_empresa || address,
      observacion_inicial: nextObservation,
    })
  }

  const dedupedContactUpdates = new Map()
  for (const update of contactUpdates) {
    const existing = dedupedContactUpdates.get(update.id)
    dedupedContactUpdates.set(update.id, !existing ? update : {
      ...existing,
      ...update,
      phones: uniqueStrings([...(existing.phones ?? []), ...(update.phones ?? [])]),
      tags: uniqueStrings([...(existing.tags ?? []), ...(update.tags ?? [])]),
      custom_fields: mergeCustomFields(existing.custom_fields, update.custom_fields),
    })
  }

  let insertedContacts = 0
  let updatedContacts = 0
  let updatedLeads = 0
  const leadContactId = new Map()

  for (const batch of chunk(contactInserts, 200)) {
    const { data, error } = await crm
      .from('contacts')
      .insert(batch.map(item => item.row))
      .select('id,rut,email')
    if (error) throw new Error(`No pude insertar contactos: ${error.message}`)
    insertedContacts += data?.length ?? 0
    for (const [index, contact] of (data ?? []).entries()) {
      leadContactId.set(batch[index].leadId, contact.id)
      const rut = normalizeRut(contact.rut)
      const email = normalizeEmail(contact.email)
      if (rut) contactByRut.set(rut, contact)
      if (email) contactByEmail.set(email, contact)
    }
  }

  for (const batch of chunk([...dedupedContactUpdates.values()], 100)) {
    if (!batch.length) continue
    const { error } = await crm.from('contacts').upsert(batch, { onConflict: 'id' })
    if (error) throw new Error(`No pude actualizar contactos: ${error.message}`)
    updatedContacts += batch.length
  }

  for (const leadUpdate of leadUpdates) {
    if (!leadUpdate.contact_id && leadContactId.has(leadUpdate.id)) {
      leadUpdate.contact_id = leadContactId.get(leadUpdate.id)
    }
    if (leadUpdate.contact_id) continue

    const sourceLead = leads.find(lead => lead.id === leadUpdate.id)
    const rut = normalizeRut(sourceLead?.rut_empresa)
    const email = normalizeEmail(sourceLead?.mail)
    const contact = (rut ? contactByRut.get(rut) : null) || (email ? contactByEmail.get(email) : null)
    if (contact?.id) leadUpdate.contact_id = contact.id
  }

  for (const batch of chunk(leadUpdates, 100)) {
    for (const leadUpdate of batch) {
      const { id, ...patch } = leadUpdate
      const { error } = await crm.from('campaign_base_leads').update(patch).eq('id', id)
      if (error) throw new Error(`No pude actualizar lead ${id}: ${error.message}`)
      updatedLeads += 1
    }
  }

  const afterRows = []
  for (let start = 0; ; start += 1000) {
    const { data, error } = await crm
      .from('campaign_base_leads')
      .select('id,assigned_user_id,contact_id')
      .eq('campaign_id', CAMPAIGN_ID)
      .in('assigned_user_id', [...AGENTS.keys()])
      .range(start, start + 999)
    if (error) throw new Error(`No pude verificar leads: ${error.message}`)
    afterRows.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }

  const summary = {
    ok: true,
    generated_at: NOW,
    campaign: CAMPAIGN_NAME,
    before,
    matched_company_enrichment_rows: matchedCompanyRows,
    contacts_inserted: insertedContacts,
    contacts_updated: updatedContacts,
    existing_contacts_linked_planned: plannedExistingLinks,
    leads_updated: updatedLeads,
    leads_with_contact_after: afterRows.filter(row => row.contact_id).length,
    by_agent_after: Object.fromEntries([...AGENTS.entries()].map(([id, name]) => [
      name,
      {
        total: afterRows.filter(row => row.assigned_user_id === id).length,
        with_contact: afterRows.filter(row => row.assigned_user_id === id && row.contact_id).length,
      },
    ])),
    output_dir: OUT_DIR,
  }

  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
