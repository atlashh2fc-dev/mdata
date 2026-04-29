import { createClient } from '@supabase/supabase-js'
import { db } from '@/lib/db/supabase'

const FETCH_CHUNK_SIZE = 1000
const SCORE_LOOKUP_CHUNK_SIZE = 1000
const DICOM_BASES_FROM = '2026-03-01'
const CONTACT_OUTCOMES = new Set(['interested', 'callback', 'sale', 'not_interested'])
const BAD_NUMBER_PATTERN = /(FUERA DE SERVICIO|NUMERO ERRONEO|N[UÚ]MERO ERR[OÓ]NEO|NO CORRESPONDE|NUMERO EQUIVOCADO|N[UÚ]MERO EQUIVOCADO|TELEFONO NO LLAMABLE|TEL[EÉ]FONO NO LLAMABLE)/i

type CrmLeadRow = {
  id: string
  contact_id: string | null
  origin_raw: string | null
  origin_normalized: string | null
  assignment_status: string | null
  workflow_status: string | null
  attempts_count: number | null
  last_call_id: string | null
  last_outcome: string | null
  tipificacion_actual: string | null
  tipificacion_inicial: string | null
  exception_reason: string | null
  nombre_cliente: string | null
  razon_social: string | null
  rut_empresa: string | null
  mail: string | null
  created_at: string | null
}

type CrmContactRow = {
  id: string
  rut: string | null
  email: string | null
  phone_mobile: string | null
  phone_contact: string | null
  phone_normalized: string | null
  full_name: string | null
  region: string | null
  comuna: string | null
}

type CrmCallRow = {
  id: string
  lead_id: string | null
  contact_id: string | null
  status: string | null
  outcome: string | null
  reason: string | null
}

type EquifaxScoreRow = {
  rutid: string
  lead_temperature: 'green' | 'yellow' | 'red' | null
  lead_score: number | null
  contact_probability: number | null
  interest_probability: number | null
  purchase_probability: number | null
  recommended_channel: string | null
  recommended_hour: number | null
}

export type UnifiedCrmPropensityColor = 'green' | 'yellow' | 'red' | 'sin_score'

export type UnifiedCrmUntouchedBaseRow = {
  base_name: string
  total: number
  green: number
  yellow: number
  red: number
  sin_score: number
  untouched: number
  recorridos_sin_contacto: number
}

export type UnifiedCrmUntouchedSummary = {
  generated_at: string
  bases_from: string
  crm_base_rows: number
  eligible_rows_before_dedupe: number
  unique_universe: number
  duplicate_rows_removed: number
  untouched_unique: number
  recorridos_sin_contacto: number
  excluded_contacted_rows: number
  excluded_bad_number_rows: number
  excluded_exception_rows: number
  scored: number
  green: number
  yellow: number
  red: number
  sin_score: number
  by_color: Array<{
    color: UnifiedCrmPropensityColor
    total: number
    untouched: number
    recorridos_sin_contacto: number
    avg_lead_score: number
    avg_contact_probability: number
    avg_purchase_probability: number
  }>
  by_base: UnifiedCrmUntouchedBaseRow[]
}

type UnifiedCandidate = {
  rutid: string
  base_name: string
  bases: Set<string>
  untouched: boolean
  recorrido_sin_contacto: boolean
  attempts_count: number
  call_count: number
  name: string | null
  email: string | null
  phone: string | null
  region: string | null
  comuna: string | null
  lead_rows: number
  lead_temperature: UnifiedCrmPropensityColor
  lead_score: number
  contact_probability: number
  purchase_probability: number
}

function getCrmClient() {
  const url = process.env.REGISTRO_INTEL_SUPABASE_URL
  const key =
    process.env.REGISTRO_INTEL_SERVICE_ROLE_KEY ||
    process.env.REGISTRO_INTEL_SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('Faltan credenciales del CRM operativo para leer las bases unificadas.')
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

function normalizeRutid(value?: string | null) {
  if (!value) return null
  const compact = value.toUpperCase().replace(/[^0-9K]/g, '').replace(/^0+/, '')
  return compact || null
}

function rutidLookupVariants(value?: string | null) {
  const normalized = normalizeRutid(value)
  if (!normalized) return []
  return [...new Set([
    normalized,
    normalized.padStart(9, '0'),
    normalized.padStart(10, '0'),
  ])]
}

function isContactedOutcome(value?: string | null) {
  return CONTACT_OUTCOMES.has(value?.toLowerCase() ?? '')
}

function isContactedCall(row: CrmCallRow) {
  const outcome = row.outcome?.toLowerCase() ?? ''
  return CONTACT_OUTCOMES.has(outcome)
}

function hasBadNumberSignal(...values: Array<string | null | undefined>) {
  return values.some(value => BAD_NUMBER_PATTERN.test(value ?? ''))
}

function isExceptionLead(row: CrmLeadRow) {
  return row.assignment_status === 'exception' || row.workflow_status === 'exception'
}

function safeAverage(values: number[]) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function round(value: number, decimals = 1) {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

async function fetchAllCrmRows<T>(table: string, select: string): Promise<T[]> {
  const crm = getCrmClient()
  const rows: T[] = []

  for (let start = 0; ; start += FETCH_CHUNK_SIZE) {
    const { data, error } = await crm
      .from(table)
      .select(select)
      .range(start, start + FETCH_CHUNK_SIZE - 1)

    if (error) {
      throw new Error(`No pude leer ${table} desde el CRM: ${error.message}`)
    }

    const chunk = (data ?? []) as T[]
    rows.push(...chunk)
    if (chunk.length < FETCH_CHUNK_SIZE) break
  }

  return rows
}

async function fetchEquifaxScores(rutids: string[]) {
  const lookupRutids = [...new Set(rutids.flatMap(rutidLookupVariants))]
  const scores = new Map<string, EquifaxScoreRow>()

  for (let start = 0; start < lookupRutids.length; start += SCORE_LOOKUP_CHUNK_SIZE) {
    const { data, error } = await db
      .from('equifax_lead_scores')
      .select('rutid,lead_temperature,lead_score,contact_probability,interest_probability,purchase_probability,recommended_channel,recommended_hour')
      .in('rutid', lookupRutids.slice(start, start + SCORE_LOOKUP_CHUNK_SIZE))

    if (error) {
      throw new Error(`No pude cruzar el scoring Equifax: ${error.message}`)
    }

    for (const row of (data ?? []) as EquifaxScoreRow[]) {
      for (const variant of rutidLookupVariants(row.rutid)) {
        scores.set(variant, row)
      }
    }
  }

  return scores
}

function buildColorBucket(color: UnifiedCrmPropensityColor, rows: UnifiedCandidate[]) {
  return {
    color,
    total: rows.length,
    untouched: rows.filter(row => row.untouched).length,
    recorridos_sin_contacto: rows.filter(row => row.recorrido_sin_contacto && !row.untouched).length,
    avg_lead_score: round(safeAverage(rows.map(row => row.lead_score))),
    avg_contact_probability: round(safeAverage(rows.map(row => row.contact_probability))),
    avg_purchase_probability: round(safeAverage(rows.map(row => row.purchase_probability))),
  }
}

export async function getUnifiedCrmUntouchedPropensitySummary(): Promise<UnifiedCrmUntouchedSummary> {
  const [leads, contacts, calls] = await Promise.all([
    fetchAllCrmRows<CrmLeadRow>(
      'campaign_base_leads',
      'id,contact_id,origin_raw,origin_normalized,assignment_status,workflow_status,attempts_count,last_call_id,last_outcome,tipificacion_actual,tipificacion_inicial,exception_reason,nombre_cliente,razon_social,rut_empresa,mail,created_at'
    ),
    fetchAllCrmRows<CrmContactRow>(
      'contacts',
      'id,rut,email,phone_mobile,phone_contact,phone_normalized,full_name,region,comuna'
    ),
    fetchAllCrmRows<CrmCallRow>(
      'calls',
      'id,lead_id,contact_id,status,outcome,reason'
    ),
  ])

  const contactsById = new Map(contacts.map(contact => [contact.id, contact]))
  const callsByLeadId = new Map<string, CrmCallRow[]>()
  const callsByContactId = new Map<string, CrmCallRow[]>()

  for (const call of calls) {
    if (call.lead_id) {
      const bucket = callsByLeadId.get(call.lead_id) ?? []
      bucket.push(call)
      callsByLeadId.set(call.lead_id, bucket)
    }
    if (call.contact_id) {
      const bucket = callsByContactId.get(call.contact_id) ?? []
      bucket.push(call)
      callsByContactId.set(call.contact_id, bucket)
    }
  }

  const eligibleRows: UnifiedCandidate[] = []
  const sourceLeads = leads.filter(lead => (lead.created_at ?? '') >= DICOM_BASES_FROM)
  let excludedContactedRows = 0
  let excludedBadNumberRows = 0
  let excludedExceptionRows = 0

  for (const lead of sourceLeads) {
    const contact = lead.contact_id ? contactsById.get(lead.contact_id) : null
    const rutid = normalizeRutid(contact?.rut) ?? normalizeRutid(lead.rut_empresa)
    if (!rutid) continue

    const leadCalls = callsByLeadId.get(lead.id) ?? []
    const contactCalls = lead.contact_id
      ? (callsByContactId.get(lead.contact_id) ?? []).filter(call => call.lead_id !== lead.id)
      : []
    const allCalls = [...leadCalls, ...contactCalls]
    if (isContactedOutcome(lead.last_outcome) || allCalls.some(isContactedCall)) {
      excludedContactedRows += 1
      continue
    }
    if (
      hasBadNumberSignal(lead.tipificacion_actual, lead.tipificacion_inicial, lead.exception_reason) ||
      allCalls.some(call => hasBadNumberSignal(call.reason, call.status))
    ) {
      excludedBadNumberRows += 1
      continue
    }
    if (isExceptionLead(lead)) {
      excludedExceptionRows += 1
      continue
    }

    const attemptsCount = Number(lead.attempts_count ?? 0)
    const baseName = lead.origin_raw || lead.origin_normalized || 'Sin base vinculada'

    eligibleRows.push({
      rutid,
      base_name: baseName,
      bases: new Set([baseName]),
      untouched: attemptsCount === 0 && !lead.last_call_id && allCalls.length === 0,
      recorrido_sin_contacto: attemptsCount > 0 || allCalls.length > 0,
      attempts_count: attemptsCount,
      call_count: allCalls.length,
      name: lead.razon_social || lead.nombre_cliente || contact?.full_name || null,
      email: lead.mail || contact?.email || null,
      phone: contact?.phone_normalized || contact?.phone_mobile || contact?.phone_contact || null,
      region: contact?.region ?? null,
      comuna: contact?.comuna ?? null,
      lead_rows: 1,
      lead_temperature: 'sin_score',
      lead_score: 0,
      contact_probability: 0,
      purchase_probability: 0,
    })
  }

  const unifiedMap = new Map<string, UnifiedCandidate>()
  for (const row of eligibleRows) {
    const existing = unifiedMap.get(row.rutid)
    if (!existing) {
      unifiedMap.set(row.rutid, row)
      continue
    }

    existing.bases.add(row.base_name)
    existing.lead_rows += 1
    existing.untouched = existing.untouched && row.untouched
    existing.recorrido_sin_contacto = existing.recorrido_sin_contacto || row.recorrido_sin_contacto
    existing.attempts_count += row.attempts_count
    existing.call_count += row.call_count
    existing.email = existing.email || row.email
    existing.phone = existing.phone || row.phone
    existing.region = existing.region || row.region
    existing.comuna = existing.comuna || row.comuna
  }

  const unifiedRows = [...unifiedMap.values()]
  const scoreMap = await fetchEquifaxScores(unifiedRows.map(row => row.rutid))

  for (const row of unifiedRows) {
    const score =
      scoreMap.get(row.rutid) ??
      scoreMap.get(row.rutid.padStart(10, '0')) ??
      scoreMap.get(row.rutid.padStart(9, '0'))

    row.lead_temperature = score?.lead_temperature ?? 'sin_score'
    row.lead_score = Number(score?.lead_score ?? 0)
    row.contact_probability = Number(score?.contact_probability ?? 0)
    row.purchase_probability = Number(score?.purchase_probability ?? 0)
  }

  const byBase = new Map<string, UnifiedCrmUntouchedBaseRow>()
  for (const row of unifiedRows) {
    for (const baseName of row.bases) {
      const current = byBase.get(baseName) ?? {
        base_name: baseName,
        total: 0,
        green: 0,
        yellow: 0,
        red: 0,
        sin_score: 0,
        untouched: 0,
        recorridos_sin_contacto: 0,
      }

      current.total += 1
      current[row.lead_temperature] += 1
      if (row.untouched) current.untouched += 1
      if (row.recorrido_sin_contacto && !row.untouched) current.recorridos_sin_contacto += 1
      byBase.set(baseName, current)
    }
  }

  const green = unifiedRows.filter(row => row.lead_temperature === 'green').length
  const yellow = unifiedRows.filter(row => row.lead_temperature === 'yellow').length
  const red = unifiedRows.filter(row => row.lead_temperature === 'red').length
  const sinScore = unifiedRows.filter(row => row.lead_temperature === 'sin_score').length

  return {
    generated_at: new Date().toISOString(),
    bases_from: DICOM_BASES_FROM,
    crm_base_rows: sourceLeads.length,
    eligible_rows_before_dedupe: eligibleRows.length,
    unique_universe: unifiedRows.length,
    duplicate_rows_removed: eligibleRows.length - unifiedRows.length,
    untouched_unique: unifiedRows.filter(row => row.untouched).length,
    recorridos_sin_contacto: unifiedRows.filter(row => row.recorrido_sin_contacto && !row.untouched).length,
    excluded_contacted_rows: excludedContactedRows,
    excluded_bad_number_rows: excludedBadNumberRows,
    excluded_exception_rows: excludedExceptionRows,
    scored: unifiedRows.length - sinScore,
    green,
    yellow,
    red,
    sin_score: sinScore,
    by_color: (['green', 'yellow', 'red', 'sin_score'] as const).map(color =>
      buildColorBucket(color, unifiedRows.filter(row => row.lead_temperature === color))
    ),
    by_base: [...byBase.values()].sort((left, right) => right.total - left.total),
  }
}
