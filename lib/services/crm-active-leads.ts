import 'server-only'

import { createClient } from '@supabase/supabase-js'
import type { PersonaContactDetail, PersonaView } from '@/types'
import { formatRut } from '@/lib/utils/rut'

type ActiveCrmLeadRow = {
  id: string
  rut_empresa: string | null
  nombre_cliente: string | null
  razon_social: string | null
  mail: string | null
  assignment_status: string | null
  workflow_status: string | null
  last_outcome: string | null
  updated_at: string | null
  source_external_key: string | null
  source_payload: Record<string, unknown> | null
}

export type ActiveCrmLead = {
  rutid: string
  display_name: string | null
  email: string | null
  phone: string | null
  source_updated_at: string | null
  source_external_key: string | null
  status: string | null
  raw: ActiveCrmLeadRow
}

let crmClient: ReturnType<typeof createClient> | null = null

function getCrmClient() {
  const url = process.env.REGISTRO_INTEL_SUPABASE_URL
  const key = process.env.REGISTRO_INTEL_SERVICE_ROLE_KEY
    ?? process.env.REGISTRO_INTEL_SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) return null

  if (!crmClient) {
    crmClient = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  }

  return crmClient
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized || null
}

function normalizeRutid(value: string): string | null {
  const cleaned = value.replace(/[^0-9Kk]/g, '').toUpperCase()
  if (cleaned.length < 2) return null
  return cleaned.padStart(10, '0')
}

function normalizePhone(value: unknown): string | null {
  const digits = String(value ?? '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.length === 8) return `+569${digits}`
  if (digits.length === 9 && digits.startsWith('9')) return `+56${digits}`
  if (digits.length === 10 && digits.startsWith('0')) return `+56${digits.slice(1)}`
  if (digits.length === 11 && digits.startsWith('56')) return `+${digits}`
  if (digits.startsWith('569')) return `+${digits}`
  return null
}

function extractFirstEmail(...values: unknown[]): string | null {
  for (const value of values) {
    const candidates = Array.isArray(value) ? value : String(value ?? '').split(/[,\s|;]+/)
    for (const candidate of candidates) {
      const email = String(candidate).trim().toLowerCase()
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email
    }
  }
  return null
}

function extractBestPhone(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload) return null

  const preferredKeys = [
    'mejor_telefono',
    'telefono',
    'telefono_raw',
    'phone',
    'phone_normalized',
    'phone_mobile',
    'telefonos',
    'telefonos_raw',
  ]

  for (const key of preferredKeys) {
    const value = payload[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        const phone = normalizePhone(item)
        if (phone) return phone
      }
      continue
    }

    const direct = normalizePhone(value)
    if (direct) return direct

    for (const token of String(value ?? '').split(/[,\s|;/]+/)) {
      const phone = normalizePhone(token)
      if (phone) return phone
    }
  }

  return null
}

function buildRutVariants(rutid: string): string[] {
  const compact = rutid.replace(/^0+/, '') || rutid
  return [...new Set([
    rutid,
    compact,
    formatRut(rutid),
    formatRut(compact),
    `${compact.slice(0, -1)}-${compact.slice(-1)}`,
  ].filter(Boolean))]
}

function mapLead(row: ActiveCrmLeadRow, rutid: string): ActiveCrmLead {
  const payload = row.source_payload ?? {}
  const displayName =
    normalizeText(row.nombre_cliente)
    ?? normalizeText(row.razon_social)
    ?? normalizeText(payload.nombre_comercial)
    ?? normalizeText(payload.razon_social_empresa)

  const email = extractFirstEmail(
    row.mail,
    payload.correo,
    payload.email,
    payload.mail,
    payload.emails
  )

  return {
    rutid,
    display_name: displayName,
    email,
    phone: extractBestPhone(payload),
    source_updated_at: row.updated_at,
    source_external_key: row.source_external_key,
    status: [row.assignment_status, row.workflow_status, row.last_outcome].filter(Boolean).join(' / ') || null,
    raw: row,
  }
}

export async function getActiveCrmLeadByRut(rut: string): Promise<ActiveCrmLead | null> {
  const crm = getCrmClient()
  const rutid = normalizeRutid(rut)
  if (!crm || !rutid) return null

  const variants = buildRutVariants(rutid)
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

  const exactResult = await crm
    .from('campaign_base_leads')
    .select(select)
    .in('rut_empresa', variants)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (exactResult.error) {
    console.error('[getActiveCrmLeadByRut.exact]', exactResult.error)
  }

  if (exactResult.data) {
    return mapLead(exactResult.data as ActiveCrmLeadRow, rutid)
  }

  const sourceKey = rutid.replace(/^0+/, '') || rutid
  const sourceResult = await crm
    .from('campaign_base_leads')
    .select(select)
    .ilike('source_external_key', `%${sourceKey}%`)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (sourceResult.error) {
    console.error('[getActiveCrmLeadByRut.source_key]', sourceResult.error)
    return null
  }

  return sourceResult.data ? mapLead(sourceResult.data as ActiveCrmLeadRow, rutid) : null
}

export async function enrichPersonaWithActiveCrmLead(persona: PersonaView): Promise<PersonaView> {
  if (persona.nombre_completo && persona.email && persona.fono_cel) return persona

  const lead = await getActiveCrmLeadByRut(persona.rutid)
  if (!lead) return persona

  return {
    ...persona,
    nombre_completo: persona.nombre_completo ?? lead.display_name,
    email: persona.email ?? lead.email,
    fono_cel: persona.fono_cel ?? lead.phone,
    razon_social_empresa: persona.razon_social_empresa ?? lead.display_name,
    tiene_empresa: persona.tiene_empresa || Boolean(lead.display_name),
  }
}

export function activeCrmLeadToContactDetails(lead: ActiveCrmLead | null): PersonaContactDetail[] {
  if (!lead) return []

  const baseMetadata = {
    source_external_key: lead.source_external_key,
    status: lead.status,
  }

  const contacts: PersonaContactDetail[] = []

  if (lead.phone) {
    contacts.push({
      id: `crm-active-lead-phone-${lead.rutid}`,
      contact_type: 'phone',
      contact_value: lead.phone,
      source_name: 'registro_intel.campaign_base_leads',
      quality_score: 78,
      is_primary: true,
      is_verified: false,
      last_seen_at: lead.source_updated_at,
      metadata: baseMetadata,
    })
  }

  if (lead.email) {
    contacts.push({
      id: `crm-active-lead-email-${lead.rutid}`,
      contact_type: 'email',
      contact_value: lead.email,
      source_name: 'registro_intel.campaign_base_leads',
      quality_score: 72,
      is_primary: !lead.phone,
      is_verified: false,
      last_seen_at: lead.source_updated_at,
      metadata: baseMetadata,
    })
  }

  return contacts
}
