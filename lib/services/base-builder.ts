'use server'

import { db, hasSupabaseAdminEnv } from '@/lib/db/supabase'
import { cleanRut, displayRut, validateRut } from '@/lib/utils/rut'
import { normalizeCompanyName } from '@/lib/utils/company-match'
import { enrichCompanyContacts } from '@/lib/services/company-contact-enrichment'
import type {
  BaseBuilderAnalysisResult,
  BaseBuilderCoverageItem,
  BaseBuilderExportRow,
  BaseBuilderFieldKey,
  BaseBuilderMatchMode,
  BaseBuilderWebEnrichmentResult,
} from '@/types/base-builder'
import type { PersonaView } from '@/types'
import { BASE_BUILDER_FIELDS } from '@/types/base-builder'

const BATCH_SIZE = 500
const COMPANY_MATCH_BATCH_SIZE = 500
const PERSON_NAME_MATCH_BATCH_SIZE = 500
const VALID_FIELDS = new Set<BaseBuilderFieldKey>(
  BASE_BUILDER_FIELDS.map(field => field.key)
)

type BaseBuilderValue = string | number | boolean | null
type PersonaSubset = { rutid: string } & Partial<Record<BaseBuilderFieldKey, BaseBuilderValue>>

const MASTER_VIEW_FIELDS = new Set<BaseBuilderFieldKey>([
  'nombre_completo',
  'nombres',
  'paterno',
  'materno',
  'email',
  'fono_cel',
  'region_canonica',
  'comuna_canonica',
  'domicilio_region',
  'domicilio_comuna',
  'razon_social_empresa',
  'rubro',
  'facturacion_sub_rango',
  'tamano_empresas',
  'fecha_direccion_comer',
  'con_cargo_ejecutivo',
  'con_email_ejecutivo',
  'con_fono_celular_ejecutivo',
  'con_fono_comercial_ejecutivo',
  'n_autos',
  'n_bienes_raices',
  'totalavaluos',
  'uso_propiedad_inferido',
  'bbrr_destinos',
  'n_propiedades_detalle',
  'n_propiedades_residenciales',
  'n_propiedades_comerciales',
  'n_propiedades_rurales',
  'n_propiedades_indeterminadas',
  'avaluo_residencial',
  'avaluo_comercial',
  'avaluo_rural',
  'avaluo_indeterminado',
  'score_patrimonial',
  'cobertura_pct',
  'tiene_autos',
  'tiene_empresa',
  'tiene_bienes_raices',
])

const CONTACT_META_FIELDS = new Set<BaseBuilderFieldKey>([
  'email_fuente',
  'fono_cel_fuente',
  'email_verificado',
  'fono_cel_verificado',
  'email_quality_score',
  'fono_cel_quality_score',
])

const EXECUTIVE_FIELDS = new Set<BaseBuilderFieldKey>([
  'ejecutivo_nombre',
  'ejecutivo_cargo',
  'ejecutivo_area',
  'ejecutivo_email',
  'ejecutivo_telefono',
  'ejecutivo_rutid',
  'ejecutivo_contact_priority',
])

const EQUIFAX_FIELDS = new Set<BaseBuilderFieldKey>([
  'equifax_lead_score',
  'equifax_lead_temperature',
  'equifax_contact_probability',
  'equifax_interest_probability',
  'equifax_purchase_probability',
  'equifax_fit_score',
  'equifax_recommended_channel',
  'equifax_recommended_hour',
  'equifax_scored_at',
  'equifax_reason_tags',
])

const SALES_TREND_FIELDS = new Set<BaseBuilderFieldKey>([
  'ventas_anio_ultimo',
  'ventas_resultado_tendencia',
  'ventas_ultimo_tramo',
  'ventas_tramo_promedio',
  'ventas_cambio_promedio_anual',
  'ventas_pendiente_tendencia',
  'ventas_movimientos_alza',
  'ventas_movimientos_baja',
  'ventas_trabajadores_2024',
  'ventas_rubro_economico',
  'ventas_subrubro_economico',
  'ventas_actividad_economica',
  'ventas_region',
  'ventas_comuna',
])

const WOM_FIELDS = new Set<BaseBuilderFieldKey>([
  'wom_nombre',
  'wom_direccion',
  'wom_comuna',
  'wom_lineas',
  'wom_valor',
  'wom_ciclo',
])

const BLACKLIST_FIELDS = new Set<BaseBuilderFieldKey>([
  'blacklist_phone_count',
  'blacklist_email_count',
  'blacklist_last_seen_at',
  'blacklist_reasons',
])

type ContactPointSubset = {
  rutid: string
  contact_type: 'email' | 'phone'
  contact_value: string | null
  source_name: string | null
  quality_score: number | null
  is_primary: boolean | null
  is_verified: boolean | null
  last_seen_at: string | null
}

type ContactPointFields = Partial<Record<BaseBuilderFieldKey, BaseBuilderValue>>

function hasAnySelected(selectedFields: BaseBuilderFieldKey[], fieldSet: Set<BaseBuilderFieldKey>): boolean {
  return selectedFields.some(field => fieldSet.has(field))
}

function toBaseBuilderValue(value: unknown): BaseBuilderValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(item => String(item ?? '').trim()).filter(Boolean).join(', ')
  return JSON.stringify(value)
}

function normalizeColumnKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
}

function toPaddedRut(rut: string): string {
  return cleanRut(rut).padStart(10, '0')
}

function normalizeRutJoinKey(rut: string): string {
  return cleanRut(rut).replace(/^0+/, '')
}

function buildRutLookup(rutIds: string[]): {
  lookupRutIds: string[]
  canonicalByLookup: Map<string, string>
} {
  const canonicalByLookup = new Map<string, string>()

  for (const rutid of rutIds) {
    const cleaned = cleanRut(rutid)
    const unpadded = normalizeRutJoinKey(rutid)
    if (cleaned) canonicalByLookup.set(cleaned, rutid)
    if (unpadded) canonicalByLookup.set(unpadded, rutid)
  }

  return {
    lookupRutIds: [...canonicalByLookup.keys()],
    canonicalByLookup,
  }
}

function canonicalRutFromLookup(rowRutid: unknown, canonicalByLookup: Map<string, string>): string | null {
  const cleaned = cleanRut(String(rowRutid ?? ''))
  if (!cleaned) return null
  return canonicalByLookup.get(cleaned) ?? canonicalByLookup.get(cleaned.replace(/^0+/, '')) ?? null
}

function normalizePersonName(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

function isMissingPersonMatchFunctionError(error: { code?: string; message?: string }): boolean {
  const message = String(error.message ?? '').toLowerCase()
  return error.code === 'PGRST202' ||
    error.code === '42883' ||
    message.includes('match_person_names')
}

function sanitizeSelectedFields(fields: string[]): BaseBuilderFieldKey[] {
  const seen = new Set<BaseBuilderFieldKey>()
  const validFields: BaseBuilderFieldKey[] = []

  for (const field of fields) {
    if (!VALID_FIELDS.has(field as BaseBuilderFieldKey)) continue
    const typedField = field as BaseBuilderFieldKey
    if (seen.has(typedField)) continue
    seen.add(typedField)
    validFields.push(typedField)
  }

  return validFields
}

function isPresent(value: string | number | boolean | null | undefined): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  return true
}

function buildFieldLabelMap() {
  return new Map(BASE_BUILDER_FIELDS.map(field => [field.key, `Maestro - ${field.label}`]))
}

function getFieldValue(row: PersonaSubset | undefined, field: BaseBuilderFieldKey) {
  const value = row?.[field]
  return value === undefined ? null : toBaseBuilderValue(value)
}

function contactRank(row: ContactPointSubset): number {
  const lastSeenTime = row.last_seen_at ? Date.parse(row.last_seen_at) : 0

  return (
    (row.is_primary ? 1_000_000 : 0) +
    (row.is_verified ? 100_000 : 0) +
    Number(row.quality_score ?? 0) * 1_000 +
    (Number.isFinite(lastSeenTime) ? Math.floor(lastSeenTime / 1_000_000_000) : 0)
  )
}

async function fetchBestContactPointsByRutIds(
  rutIds: string[],
  selectedFields: BaseBuilderFieldKey[]
): Promise<Map<string, ContactPointFields>> {
  const contactsByRut = new Map<string, ContactPointFields>()

  if (
    !hasSupabaseAdminEnv ||
    rutIds.length === 0 ||
    (
      !selectedFields.includes('email') &&
      !selectedFields.includes('fono_cel') &&
      !hasAnySelected(selectedFields, CONTACT_META_FIELDS)
    )
  ) {
    return contactsByRut
  }

  const contactTypes: Array<'email' | 'phone'> = []
  if (
    selectedFields.includes('email') ||
    selectedFields.includes('email_fuente') ||
    selectedFields.includes('email_verificado') ||
    selectedFields.includes('email_quality_score')
  ) contactTypes.push('email')
  if (
    selectedFields.includes('fono_cel') ||
    selectedFields.includes('fono_cel_fuente') ||
    selectedFields.includes('fono_cel_verificado') ||
    selectedFields.includes('fono_cel_quality_score')
  ) contactTypes.push('phone')

  const bestByRutAndType = new Map<string, ContactPointSubset>()
  const { lookupRutIds, canonicalByLookup } = buildRutLookup(rutIds)

  for (let i = 0; i < lookupRutIds.length; i += BATCH_SIZE) {
    const batch = lookupRutIds.slice(i, i + BATCH_SIZE)
    const { data, error } = await db
      .from('persona_contact_points')
      .select('rutid,contact_type,contact_value,source_name,quality_score,is_primary,is_verified,last_seen_at')
      .in('rutid', batch)
      .in('contact_type', contactTypes)

    if (error) {
      console.error('[fetchBestContactPointsByRutIds]', error)
      throw new Error('No se pudo consultar los contactos enriquecidos.')
    }

    for (const row of (data ?? []) as ContactPointSubset[]) {
      const canonicalRutid = canonicalRutFromLookup(row.rutid, canonicalByLookup)
      if (!canonicalRutid || !row.contact_value || !row.contact_type) continue

      const normalizedRow = { ...row, rutid: canonicalRutid }
      const key = `${canonicalRutid}:${row.contact_type}`
      const current = bestByRutAndType.get(key)
      if (!current || contactRank(normalizedRow) > contactRank(current)) {
        bestByRutAndType.set(key, normalizedRow)
      }
    }
  }

  for (const row of bestByRutAndType.values()) {
    const existing = contactsByRut.get(row.rutid) ?? {}
    if (row.contact_type === 'email') {
      existing.email = row.contact_value ?? null
      existing.email_fuente = row.source_name ?? null
      existing.email_verificado = row.is_verified ?? null
      existing.email_quality_score = row.quality_score ?? null
    }
    if (row.contact_type === 'phone') {
      existing.fono_cel = row.contact_value ?? null
      existing.fono_cel_fuente = row.source_name ?? null
      existing.fono_cel_verificado = row.is_verified ?? null
      existing.fono_cel_quality_score = row.quality_score ?? null
    }
    contactsByRut.set(row.rutid, existing)
  }

  return contactsByRut
}

async function fetchExecutiveFieldsByRutIds(
  rutIds: string[],
  selectedFields: BaseBuilderFieldKey[]
): Promise<Map<string, ContactPointFields>> {
  const rowsByRut = new Map<string, ContactPointFields>()
  if (!hasSupabaseAdminEnv || rutIds.length === 0 || !hasAnySelected(selectedFields, EXECUTIVE_FIELDS)) return rowsByRut

  const { lookupRutIds, canonicalByLookup } = buildRutLookup(rutIds)
  for (let i = 0; i < lookupRutIds.length; i += BATCH_SIZE) {
    const batch = lookupRutIds.slice(i, i + BATCH_SIZE)
    const { data, error } = await db
      .from('company_best_executive_contact')
      .select('rutid,rutid_ejecutivo,nombre_ejecutivo,area,cargo,email,mejor_telefono,contact_priority')
      .in('rutid', batch)

    if (error) {
      console.error('[fetchExecutiveFieldsByRutIds]', error)
      throw new Error('No se pudo consultar contactos ejecutivos.')
    }

    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const rutid = canonicalRutFromLookup(row.rutid, canonicalByLookup)
      if (!rutid) continue
      rowsByRut.set(rutid, {
        ejecutivo_nombre: toBaseBuilderValue(row.nombre_ejecutivo),
        ejecutivo_cargo: toBaseBuilderValue(row.cargo),
        ejecutivo_area: toBaseBuilderValue(row.area),
        ejecutivo_email: toBaseBuilderValue(row.email),
        ejecutivo_telefono: toBaseBuilderValue(row.mejor_telefono),
        ejecutivo_rutid: toBaseBuilderValue(row.rutid_ejecutivo),
        ejecutivo_contact_priority: toBaseBuilderValue(row.contact_priority),
      })
    }
  }

  return rowsByRut
}

async function fetchEquifaxFieldsByRutIds(
  rutIds: string[],
  selectedFields: BaseBuilderFieldKey[]
): Promise<Map<string, ContactPointFields>> {
  const rowsByRut = new Map<string, ContactPointFields>()
  if (!hasSupabaseAdminEnv || rutIds.length === 0 || !hasAnySelected(selectedFields, EQUIFAX_FIELDS)) return rowsByRut

  const { lookupRutIds, canonicalByLookup } = buildRutLookup(rutIds)
  for (let i = 0; i < lookupRutIds.length; i += BATCH_SIZE) {
    const batch = lookupRutIds.slice(i, i + BATCH_SIZE)
    const { data, error } = await db
      .from('equifax_lead_scores')
      .select('rutid,contact_probability,interest_probability,purchase_probability,fit_score,lead_score,lead_temperature,recommended_channel,recommended_hour,reason_tags,scored_at')
      .in('rutid', batch)

    if (error) {
      console.error('[fetchEquifaxFieldsByRutIds]', error)
      throw new Error('No se pudo consultar scores Equifax.')
    }

    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const rutid = canonicalRutFromLookup(row.rutid, canonicalByLookup)
      if (!rutid) continue
      rowsByRut.set(rutid, {
        equifax_lead_score: toBaseBuilderValue(row.lead_score),
        equifax_lead_temperature: toBaseBuilderValue(row.lead_temperature),
        equifax_contact_probability: toBaseBuilderValue(row.contact_probability),
        equifax_interest_probability: toBaseBuilderValue(row.interest_probability),
        equifax_purchase_probability: toBaseBuilderValue(row.purchase_probability),
        equifax_fit_score: toBaseBuilderValue(row.fit_score),
        equifax_recommended_channel: toBaseBuilderValue(row.recommended_channel),
        equifax_recommended_hour: toBaseBuilderValue(row.recommended_hour),
        equifax_scored_at: toBaseBuilderValue(row.scored_at),
        equifax_reason_tags: toBaseBuilderValue(row.reason_tags),
      })
    }
  }

  return rowsByRut
}

async function fetchSalesTrendFieldsByRutIds(
  rutIds: string[],
  selectedFields: BaseBuilderFieldKey[]
): Promise<Map<string, ContactPointFields>> {
  const rowsByRut = new Map<string, ContactPointFields>()
  if (!hasSupabaseAdminEnv || rutIds.length === 0 || !hasAnySelected(selectedFields, SALES_TREND_FIELDS)) return rowsByRut

  const { lookupRutIds, canonicalByLookup } = buildRutLookup(rutIds)
  for (let i = 0; i < lookupRutIds.length; i += BATCH_SIZE) {
    const batch = lookupRutIds.slice(i, i + BATCH_SIZE)
    const { data, error } = await db
      .from('empresas_ventas_tendencia')
      .select('rutid,anio_ultimo,rubro_economico_ultimo,subrubro_economico_ultimo,actividad_economica_ultima,region_ultima,comuna_ultima,trabajadores_2024,ultimo_tramo_ventas,tramo_ventas_promedio_2020_2024,cambio_promedio_anual_tramo,pendiente_tendencia_tramo,movimientos_alza,movimientos_baja,resultado_tendencia')
      .in('rutid', batch)

    if (error) {
      console.error('[fetchSalesTrendFieldsByRutIds]', error)
      throw new Error('No se pudo consultar tendencia de ventas.')
    }

    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const rutid = canonicalRutFromLookup(row.rutid, canonicalByLookup)
      if (!rutid) continue
      rowsByRut.set(rutid, {
        ventas_anio_ultimo: toBaseBuilderValue(row.anio_ultimo),
        ventas_resultado_tendencia: toBaseBuilderValue(row.resultado_tendencia),
        ventas_ultimo_tramo: toBaseBuilderValue(row.ultimo_tramo_ventas),
        ventas_tramo_promedio: toBaseBuilderValue(row.tramo_ventas_promedio_2020_2024),
        ventas_cambio_promedio_anual: toBaseBuilderValue(row.cambio_promedio_anual_tramo),
        ventas_pendiente_tendencia: toBaseBuilderValue(row.pendiente_tendencia_tramo),
        ventas_movimientos_alza: toBaseBuilderValue(row.movimientos_alza),
        ventas_movimientos_baja: toBaseBuilderValue(row.movimientos_baja),
        ventas_trabajadores_2024: toBaseBuilderValue(row.trabajadores_2024),
        ventas_rubro_economico: toBaseBuilderValue(row.rubro_economico_ultimo),
        ventas_subrubro_economico: toBaseBuilderValue(row.subrubro_economico_ultimo),
        ventas_actividad_economica: toBaseBuilderValue(row.actividad_economica_ultima),
        ventas_region: toBaseBuilderValue(row.region_ultima),
        ventas_comuna: toBaseBuilderValue(row.comuna_ultima),
      })
    }
  }

  return rowsByRut
}

async function fetchWomFieldsByRutIds(
  rutIds: string[],
  selectedFields: BaseBuilderFieldKey[]
): Promise<Map<string, ContactPointFields>> {
  const rowsByRut = new Map<string, ContactPointFields>()
  if (!hasSupabaseAdminEnv || rutIds.length === 0 || !hasAnySelected(selectedFields, WOM_FIELDS)) return rowsByRut

  const { lookupRutIds, canonicalByLookup } = buildRutLookup(rutIds)
  for (let i = 0; i < lookupRutIds.length; i += BATCH_SIZE) {
    const batch = lookupRutIds.slice(i, i + BATCH_SIZE)
    const { data, error } = await db
      .from('wom_customer_signals')
      .select('rutid,nombre,direccion,comuna,lineas,valor,ciclo_date,updated_at,loaded_at')
      .in('rutid', batch)

    if (error) {
      console.error('[fetchWomFieldsByRutIds]', error)
      throw new Error('No se pudo consultar señales WOM.')
    }

    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const rutid = canonicalRutFromLookup(row.rutid, canonicalByLookup)
      if (!rutid || rowsByRut.has(rutid)) continue
      rowsByRut.set(rutid, {
        wom_nombre: toBaseBuilderValue(row.nombre),
        wom_direccion: toBaseBuilderValue(row.direccion),
        wom_comuna: toBaseBuilderValue(row.comuna),
        wom_lineas: toBaseBuilderValue(row.lineas),
        wom_valor: toBaseBuilderValue(row.valor),
        wom_ciclo: toBaseBuilderValue(row.ciclo_date),
      })
    }
  }

  return rowsByRut
}

async function fetchBlacklistFieldsByRutIds(
  rutIds: string[],
  selectedFields: BaseBuilderFieldKey[]
): Promise<Map<string, ContactPointFields>> {
  const rowsByRut = new Map<string, ContactPointFields>()
  if (!hasSupabaseAdminEnv || rutIds.length === 0 || !hasAnySelected(selectedFields, BLACKLIST_FIELDS)) return rowsByRut

  const { lookupRutIds, canonicalByLookup } = buildRutLookup(rutIds)
  for (let i = 0; i < lookupRutIds.length; i += BATCH_SIZE) {
    const batch = lookupRutIds.slice(i, i + BATCH_SIZE)
    const { data, error } = await db
      .from('contact_blacklist')
      .select('rutid,contact_type,blacklist_reason,event_count,last_seen_at')
      .in('rutid', batch)

    if (error) {
      console.error('[fetchBlacklistFieldsByRutIds]', error)
      throw new Error('No se pudo consultar blacklist de contactos.')
    }

    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const rutid = canonicalRutFromLookup(row.rutid, canonicalByLookup)
      if (!rutid) continue

      const existing = rowsByRut.get(rutid) ?? {
        blacklist_phone_count: 0,
        blacklist_email_count: 0,
        blacklist_last_seen_at: null,
        blacklist_reasons: null,
      }
      const count = Number(row.event_count ?? 0)
      const contactType = String(row.contact_type ?? '')
      const reason = String(row.blacklist_reason ?? '').trim()
      const currentReasons = String(existing.blacklist_reasons ?? '').split(', ').filter(Boolean)
      if (contactType === 'phone') existing.blacklist_phone_count = Number(existing.blacklist_phone_count ?? 0) + count
      if (contactType === 'email') existing.blacklist_email_count = Number(existing.blacklist_email_count ?? 0) + count
      if (reason && !currentReasons.includes(reason)) {
        existing.blacklist_reasons = [...currentReasons, reason].join(', ')
      }
      if (
        row.last_seen_at &&
        (!existing.blacklist_last_seen_at || String(row.last_seen_at) > String(existing.blacklist_last_seen_at))
      ) {
        existing.blacklist_last_seen_at = toBaseBuilderValue(row.last_seen_at)
      }
      rowsByRut.set(rutid, existing)
    }
  }

  return rowsByRut
}

function mergeFieldsIntoRows(
  rowsByRut: Map<string, PersonaSubset>,
  fieldsByRut: Map<string, ContactPointFields>
) {
  for (const [rutid, fields] of fieldsByRut.entries()) {
    const row = rowsByRut.get(rutid)
    if (!row) continue
    for (const [field, value] of Object.entries(fields) as Array<[BaseBuilderFieldKey, BaseBuilderValue]>) {
      row[field] = value
    }
  }
}

function buildWebEnrichmentColumns(
  row: BaseBuilderExportRow,
  emailSource: string | null,
  phoneSource: string | null,
  website: string | null
) {
  row['Fuente Email'] = emailSource
  row['Fuente Teléfono'] = phoneSource
  row['Web - Sitio'] = website
}

async function fetchMasterRowsByRutIds(
  rutIds: string[],
  selectedFields: BaseBuilderFieldKey[]
): Promise<Map<string, PersonaSubset>> {
  const rowsByRut = new Map<string, PersonaSubset>()

  if (!hasSupabaseAdminEnv || rutIds.length === 0) return rowsByRut

  const internalFields = new Set<BaseBuilderFieldKey>(selectedFields)
  internalFields.add('razon_social_empresa')

  const masterFields = [...internalFields].filter(field => MASTER_VIEW_FIELDS.has(field))
  const selectColumns = ['rutid', ...masterFields].join(',')

  for (let i = 0; i < rutIds.length; i += BATCH_SIZE) {
    const batch = rutIds.slice(i, i + BATCH_SIZE)
    const { data, error } = await db
      .from('master_personas_view')
      .select(selectColumns)
      .in('rutid', batch)

    if (error) {
      console.error('[fetchMasterRowsByRutIds]', error)
      throw new Error('No se pudo consultar la base maestra.')
    }

    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      if (!row.rutid) continue
      const typedRow: PersonaSubset = { rutid: String(row.rutid) }
      for (const [field, value] of Object.entries(row) as Array<[BaseBuilderFieldKey | 'rutid', unknown]>) {
        if (field === 'rutid') continue
        typedRow[field] = toBaseBuilderValue(value)
      }
      rowsByRut.set(typedRow.rutid, typedRow)
    }
  }

  const contactPointsByRut = await fetchBestContactPointsByRutIds(rutIds, selectedFields)
  for (const [rutid, contactPointFields] of contactPointsByRut.entries()) {
    const row = rowsByRut.get(rutid)
    if (!row) continue

    if (selectedFields.includes('email') && !isPresent(row.email) && isPresent(contactPointFields.email)) {
      row.email = contactPointFields.email
    }

    if (selectedFields.includes('fono_cel') && !isPresent(row.fono_cel) && isPresent(contactPointFields.fono_cel)) {
      row.fono_cel = contactPointFields.fono_cel
    }

    for (const field of CONTACT_META_FIELDS) {
      if (selectedFields.includes(field)) row[field] = contactPointFields[field] ?? null
    }
  }

  const [
    executiveFieldsByRut,
    equifaxFieldsByRut,
    salesTrendFieldsByRut,
    womFieldsByRut,
    blacklistFieldsByRut,
  ] = await Promise.all([
    fetchExecutiveFieldsByRutIds(rutIds, selectedFields),
    fetchEquifaxFieldsByRutIds(rutIds, selectedFields),
    fetchSalesTrendFieldsByRutIds(rutIds, selectedFields),
    fetchWomFieldsByRutIds(rutIds, selectedFields),
    fetchBlacklistFieldsByRutIds(rutIds, selectedFields),
  ])

  mergeFieldsIntoRows(rowsByRut, executiveFieldsByRut)
  mergeFieldsIntoRows(rowsByRut, equifaxFieldsByRut)
  mergeFieldsIntoRows(rowsByRut, salesTrendFieldsByRut)
  mergeFieldsIntoRows(rowsByRut, womFieldsByRut)
  mergeFieldsIntoRows(rowsByRut, blacklistFieldsByRut)

  return rowsByRut
}

async function fetchCompanyMatches(matchKeys: string[]): Promise<Map<string, Set<string>>> {
  const companyMap = new Map<string, Set<string>>()

  if (!hasSupabaseAdminEnv || matchKeys.length === 0) return companyMap

  for (let i = 0; i < matchKeys.length; i += COMPANY_MATCH_BATCH_SIZE) {
    const batch = matchKeys.slice(i, i + COMPANY_MATCH_BATCH_SIZE)
    const { data, error } = await db.rpc('match_company_names', {
      input_names: batch,
    })

    if (error) {
      console.error('[fetchCompanyMatches]', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      })
      throw new Error('No se pudo consultar la base empresarial.')
    }

    for (const row of (data ?? []) as {
      match_key: string | null
      rutid: string | null
      razon_social_empresa: string | null
    }[]) {
      if (!row.match_key || !row.rutid) continue

      const existing = companyMap.get(row.match_key) ?? new Set<string>()
      existing.add(row.rutid)
      companyMap.set(row.match_key, existing)
    }
  }

  return companyMap
}

async function fetchPersonNameMatchesFallback(matchKeys: string[]): Promise<Map<string, Set<string>>> {
  const personMap = new Map<string, Set<string>>()
  const fallbackLimit = 250

  if (matchKeys.length > fallbackLimit) {
    throw new Error(
      'Para cruzar bases grandes por nombre debes aplicar la migración match_person_names en Supabase.'
    )
  }

  for (const matchKey of matchKeys) {
    const tokens = matchKey
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token.length >= 2)
      .slice(0, 5)

    if (tokens.length < 2) continue

    let query = db
      .from('master_personas_view')
      .select('rutid,nombre_completo')
      .limit(25)

    for (const token of tokens) {
      query = query.ilike('nombre_completo', `%${token}%`)
    }

    const { data, error } = await query
    if (error) {
      console.error('[fetchPersonNameMatchesFallback]', error)
      throw new Error('No se pudo consultar personas por nombre.')
    }

    for (const row of (data ?? []) as {
      rutid: string | null
      nombre_completo: string | null
    }[]) {
      if (!row.rutid || !row.nombre_completo) continue

      const normalizedRowName = normalizePersonName(row.nombre_completo)
      const allTokensPresent = tokens.every(token => normalizedRowName.includes(token))
      if (!allTokensPresent) continue

      const existing = personMap.get(matchKey) ?? new Set<string>()
      existing.add(row.rutid)
      personMap.set(matchKey, existing)
    }
  }

  return personMap
}

async function fetchPersonNameMatches(matchKeys: string[]): Promise<Map<string, Set<string>>> {
  const personMap = new Map<string, Set<string>>()

  if (!hasSupabaseAdminEnv || matchKeys.length === 0) return personMap

  for (let i = 0; i < matchKeys.length; i += PERSON_NAME_MATCH_BATCH_SIZE) {
    const batch = matchKeys.slice(i, i + PERSON_NAME_MATCH_BATCH_SIZE)
    const { data, error } = await db.rpc('match_person_names', {
      input_names: batch,
    })

    if (error) {
      if (isMissingPersonMatchFunctionError(error)) {
        return fetchPersonNameMatchesFallback(matchKeys)
      }

      console.error('[fetchPersonNameMatches]', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      })
      throw new Error('No se pudo consultar personas por nombre.')
    }

    for (const row of (data ?? []) as {
      match_key: string | null
      rutid: string | null
      nombre_completo: string | null
    }[]) {
      if (!row.match_key || !row.rutid) continue

      const existing = personMap.get(row.match_key) ?? new Set<string>()
      existing.add(row.rutid)
      personMap.set(row.match_key, existing)
    }
  }

  return personMap
}

function findDvValue(row: Record<string, string>, rutColumnName: string): string | null {
  const rutKey = normalizeColumnKey(rutColumnName)

  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = normalizeColumnKey(key)
    if (normalizedKey === rutKey) continue

    if (
      normalizedKey === 'dv' ||
      normalizedKey === 'digitoverificador' ||
      normalizedKey === 'digverificador' ||
      normalizedKey === 'verificador'
    ) {
      const cleaned = String(value ?? '').trim().toUpperCase()
      if (/^[0-9K]$/i.test(cleaned)) return cleaned
    }
  }

  return null
}

function resolveRutFromRow(
  row: Record<string, string>,
  rutColumnName: string
): {
  raw: string | null
  formatted: string | null
  paddedRut: string | null
  isValid: boolean
} {
  const rawBase = String(row[rutColumnName] ?? '').trim()
  if (!rawBase) {
    return { raw: null, formatted: null, paddedRut: null, isValid: false }
  }

  if (validateRut(rawBase)) {
    return {
      raw: rawBase,
      formatted: displayRut(rawBase),
      paddedRut: toPaddedRut(rawBase),
      isValid: true,
    }
  }

  const dv = findDvValue(row, rutColumnName)
  if (dv) {
    const combined = `${rawBase}${dv}`
    if (validateRut(combined)) {
      return {
        raw: combined,
        formatted: displayRut(combined),
        paddedRut: toPaddedRut(combined),
        isValid: true,
      }
    }
  }

  return {
    raw: rawBase,
    formatted: rawBase,
    paddedRut: null,
    isValid: false,
  }
}

export async function analyzeRutsForBaseBuilder(
  rawRuts: string[],
  requestedFields: string[]
): Promise<BaseBuilderAnalysisResult> {
  const selectedFields = sanitizeSelectedFields(requestedFields)
  const requestedCount = rawRuts.filter(value => String(value ?? '').trim().length > 0).length

  const preparedEntries: {
    raw: string
    paddedRut: string | null
    formattedRut: string
    isValid: boolean
  }[] = []

  let duplicateCount = 0
  const dedupe = new Set<string>()

  for (const value of rawRuts) {
    const raw = String(value ?? '').trim()
    if (!raw) continue

    const cleaned = cleanRut(raw)
    if (!cleaned) continue

    const isValid = validateRut(raw)
    const paddedRut = isValid ? toPaddedRut(raw) : null
    const dedupeKey = isValid ? `rut:${paddedRut}` : `raw:${cleaned}`

    if (dedupe.has(dedupeKey)) {
      duplicateCount += 1
      continue
    }

    dedupe.add(dedupeKey)
    preparedEntries.push({
      raw,
      paddedRut,
      formattedRut: isValid ? displayRut(raw) : raw,
      isValid,
    })
  }

  const validEntries = preparedEntries.filter(entry => entry.isValid && entry.paddedRut)
  const validRuts = validEntries.map(entry => entry.paddedRut as string)

  const rowsByRut = await fetchMasterRowsByRutIds(validRuts, selectedFields)

  const exportRows: BaseBuilderExportRow[] = preparedEntries.map(entry => {
    if (!entry.isValid || !entry.paddedRut) {
      const invalidRow: BaseBuilderExportRow = {
        rut_input: entry.raw,
        rut_formateado: entry.formattedRut,
        rutid: null,
        match_status: 'invalid',
      }

      for (const field of selectedFields) {
        invalidRow[field] = null
      }

      return invalidRow
    }

    const matchedRow = rowsByRut.get(entry.paddedRut)
    const baseRow: BaseBuilderExportRow = {
      rut_input: entry.raw,
      rut_formateado: entry.formattedRut,
      rutid: matchedRow?.rutid ?? entry.paddedRut,
      match_status: matchedRow ? 'matched' : 'not_found',
    }

    for (const field of selectedFields) {
      const value = matchedRow?.[field]
      baseRow[field] =
        value === undefined ? null : (value as string | number | boolean | null)
    }

    return baseRow
  })

  const matchedCount = exportRows.filter(row => row.match_status === 'matched').length
  const validRutCount = validEntries.length
  const unmatchedCount = validRutCount - matchedCount
  const invalidRutCount = exportRows.filter(row => row.match_status === 'invalid').length
  const matchRate = validRutCount > 0 ? (matchedCount / validRutCount) * 100 : 0

  const coverage: BaseBuilderCoverageItem[] = selectedFields.map(field => {
    const definition = BASE_BUILDER_FIELDS.find(item => item.key === field)
    const count = exportRows.reduce((acc, row) => {
      if (row.match_status !== 'matched') return acc
      return acc + (isPresent(row[field]) ? 1 : 0)
    }, 0)

    return {
      field,
      label: definition?.label ?? field,
      count,
      total: validRutCount,
      matched_total: matchedCount,
      pct: validRutCount > 0 ? (count / validRutCount) * 100 : 0,
      matched_pct: matchedCount > 0 ? (count / matchedCount) * 100 : 0,
    }
  })

  return {
    match_mode: 'rut',
    match_column: null,
    valid_input_count: validRutCount,
    invalid_input_count: invalidRutCount,
    requested_count: requestedCount,
    unique_count: preparedEntries.length,
    valid_rut_count: validRutCount,
    invalid_rut_count: invalidRutCount,
    duplicate_count: duplicateCount,
    matched_count: matchedCount,
    unmatched_count: unmatchedCount,
    ambiguous_count: 0,
    match_rate: matchRate,
    rut_column: null,
    original_columns: [],
    selected_fields: selectedFields,
    coverage,
    rows: exportRows,
  }
}

export async function analyzeRowsForBaseBuilder(
  sourceRows: Record<string, string>[],
  matchColumn: string,
  companyColumn: string | null,
  requestedFields: string[],
  matchMode: BaseBuilderMatchMode = 'rut',
  enrichMissingContactsWithWeb = false
): Promise<BaseBuilderAnalysisResult> {
  const selectedFields = sanitizeSelectedFields(requestedFields)
  const fieldLabelMap = buildFieldLabelMap()
  const originalColumns = sourceRows[0] ? Object.keys(sourceRows[0]) : []

  if (matchMode === 'nombre_persona') {
    const preparedEntries = sourceRows.map((row, index) => {
      const raw = String(row[matchColumn] ?? '').trim()
      const normalized = normalizePersonName(raw)

      return {
        row,
        rowNumber: index + 1,
        raw,
        normalized,
        isValid: normalized.length > 0,
      }
    })

    const validEntries = preparedEntries.filter(entry => entry.isValid)
    const validInputCount = validEntries.length
    const invalidInputCount = preparedEntries.length - validInputCount
    const uniqueValidNames = [...new Set(validEntries.map(entry => entry.normalized))]
    const duplicateCount = validInputCount - uniqueValidNames.length

    const personMap = await fetchPersonNameMatches(uniqueValidNames)
    const uniqueMatchedRutIds = new Set<string>()

    for (const name of uniqueValidNames) {
      const rutIds = personMap.get(name)
      if (rutIds?.size === 1) {
        uniqueMatchedRutIds.add([...rutIds][0])
      }
    }

    const rowsByRut = await fetchMasterRowsByRutIds([...uniqueMatchedRutIds], selectedFields)

    const exportRows: BaseBuilderExportRow[] = preparedEntries.map(entry => {
      const rutIds = entry.normalized ? personMap.get(entry.normalized) : undefined
      const matchedRutId = rutIds?.size === 1 ? [...rutIds][0] : null
      const matchedRow = matchedRutId ? rowsByRut.get(matchedRutId) : undefined
      const matchStatus: BaseBuilderExportRow['match_status'] = !entry.isValid
        ? 'invalid'
        : !rutIds || rutIds.size === 0
          ? 'not_found'
          : rutIds.size > 1
            ? 'ambiguous'
            : 'matched'

      const baseRow: BaseBuilderExportRow = {
        ...entry.row,
        rut_input: matchedRutId ?? '',
        rut_formateado: matchedRutId ? displayRut(matchedRutId) : '',
        rutid: matchedRow?.rutid ?? matchedRutId,
        match_status: matchStatus,
      }

      for (const field of selectedFields) {
        const label = fieldLabelMap.get(field) ?? field
        const value = getFieldValue(matchedRow, field)

        baseRow[label] =
          value === undefined ? null : value
      }

      return baseRow
    })

    const matchedCount = exportRows.filter(row => row.match_status === 'matched').length
    const ambiguousCount = exportRows.filter(row => row.match_status === 'ambiguous').length
    const unmatchedCount = exportRows.filter(
      row => row.match_status === 'not_found' || row.match_status === 'ambiguous'
    ).length
    const matchRate = validInputCount > 0 ? (matchedCount / validInputCount) * 100 : 0

    const coverage: BaseBuilderCoverageItem[] = selectedFields.map(field => {
      const definition = BASE_BUILDER_FIELDS.find(item => item.key === field)
      const label = fieldLabelMap.get(field) ?? field
      const count = exportRows.reduce((acc, row) => {
        if (row.match_status !== 'matched') return acc
        return acc + (isPresent(row[label]) ? 1 : 0)
      }, 0)

      return {
        field,
        label: definition?.label ?? field,
        count,
        total: validInputCount,
        matched_total: matchedCount,
        pct: validInputCount > 0 ? (count / validInputCount) * 100 : 0,
        matched_pct: matchedCount > 0 ? (count / matchedCount) * 100 : 0,
      }
    })

    return {
      match_mode: 'nombre_persona',
      match_column: matchColumn,
      valid_input_count: validInputCount,
      invalid_input_count: invalidInputCount,
      requested_count: sourceRows.length,
      unique_count: sourceRows.length,
      valid_rut_count: validInputCount,
      invalid_rut_count: invalidInputCount,
      duplicate_count: duplicateCount,
      matched_count: matchedCount,
      unmatched_count: unmatchedCount,
      ambiguous_count: ambiguousCount,
      match_rate: matchRate,
      rut_column: null,
      original_columns: originalColumns,
      selected_fields: selectedFields,
      coverage,
      rows: exportRows,
    }
  }

  if (matchMode === 'razon_social') {
    const preparedEntries = sourceRows.map((row, index) => {
      const raw = String(row[matchColumn] ?? '').trim()
      const normalized = normalizeCompanyName(raw)

      return {
        row,
        rowNumber: index + 1,
        raw,
        normalized,
        isValid: normalized.length > 0,
      }
    })

    const validEntries = preparedEntries.filter(entry => entry.isValid)
    const validInputCount = validEntries.length
    const invalidInputCount = preparedEntries.length - validInputCount
    const uniqueValidNames = [...new Set(validEntries.map(entry => entry.normalized))]
    const duplicateCount = validInputCount - uniqueValidNames.length

    const companyMap = await fetchCompanyMatches(uniqueValidNames)
    const uniqueMatchedRutIds = new Set<string>()

    for (const name of uniqueValidNames) {
      const rutIds = companyMap.get(name)
      if (rutIds?.size === 1) {
        uniqueMatchedRutIds.add([...rutIds][0])
      }
    }

    const rowsByRut = await fetchMasterRowsByRutIds([...uniqueMatchedRutIds], selectedFields)
    const shouldEnrichContacts = enrichMissingContactsWithWeb && (
      selectedFields.includes('email') || selectedFields.includes('fono_cel')
    )
    const companiesNeedingWeb = shouldEnrichContacts
      ? preparedEntries.flatMap(entry => {
          const rutIds = companyMap.get(entry.normalized)
          if (!entry.isValid || !rutIds || rutIds.size !== 1) return []
          const matchedRutId = [...rutIds][0]
          const matchedRow = rowsByRut.get(matchedRutId)
          const needsEmail = selectedFields.includes('email') && !isPresent(getFieldValue(matchedRow, 'email'))
          const needsPhone = selectedFields.includes('fono_cel') && !isPresent(getFieldValue(matchedRow, 'fono_cel'))
          return needsEmail || needsPhone ? [{ companyName: entry.raw, rutid: matchedRutId }] : []
        })
      : []
    const webEnrichment = shouldEnrichContacts
      ? await enrichCompanyContacts(companiesNeedingWeb)
      : null

    const exportRows: BaseBuilderExportRow[] = preparedEntries.map(entry => {
      const rutIds = entry.normalized ? companyMap.get(entry.normalized) : undefined
      const matchedRutId = rutIds?.size === 1 ? [...rutIds][0] : null
      const matchedRow = matchedRutId ? rowsByRut.get(matchedRutId) : undefined
      const matchStatus: BaseBuilderExportRow['match_status'] = !entry.isValid
        ? 'invalid'
        : !rutIds || rutIds.size === 0
          ? 'not_found'
          : rutIds.size > 1
            ? 'ambiguous'
            : 'matched'

      const baseRow: BaseBuilderExportRow = {
        ...entry.row,
        rut_input: matchedRutId ?? '',
        rut_formateado: matchedRutId ? displayRut(matchedRutId) : '',
        rutid: matchedRow?.rutid ?? matchedRutId,
        match_status: matchStatus,
      }

      const webMatch = entry.normalized ? webEnrichment?.items.get(entry.normalized) : null
      const masterEmail = getFieldValue(matchedRow, 'email')
      const masterPhone = getFieldValue(matchedRow, 'fono_cel')
      const webEmail = webMatch?.emails[0] ?? null
      const webPhone = webMatch?.phones[0] ?? null

      for (const field of selectedFields) {
        const label = fieldLabelMap.get(field) ?? field
        let value = getFieldValue(matchedRow, field)

        if (field === 'email' && !isPresent(value) && webEmail) value = webEmail
        if (field === 'fono_cel' && !isPresent(value) && webPhone) value = webPhone

        baseRow[label] =
          value === undefined ? null : value
      }

      if (shouldEnrichContacts) {
        buildWebEnrichmentColumns(
          baseRow,
          isPresent(masterEmail) ? 'maestro' : webEmail ? 'web' : null,
          isPresent(masterPhone) ? 'maestro' : webPhone ? 'web' : null,
          webMatch?.website ?? null
        )
      }

      return baseRow
    })

    const matchedCount = exportRows.filter(row => row.match_status === 'matched').length
    const ambiguousCount = exportRows.filter(row => row.match_status === 'ambiguous').length
    const unmatchedCount = exportRows.filter(
      row => row.match_status === 'not_found' || row.match_status === 'ambiguous'
    ).length
    const matchRate = validInputCount > 0 ? (matchedCount / validInputCount) * 100 : 0

    const coverage: BaseBuilderCoverageItem[] = selectedFields.map(field => {
      const definition = BASE_BUILDER_FIELDS.find(item => item.key === field)
      const label = fieldLabelMap.get(field) ?? field
      const count = exportRows.reduce((acc, row) => {
        if (row.match_status !== 'matched') return acc
        return acc + (isPresent(row[label]) ? 1 : 0)
      }, 0)

      return {
        field,
        label: definition?.label ?? field,
        count,
        total: validInputCount,
        matched_total: matchedCount,
        pct: validInputCount > 0 ? (count / validInputCount) * 100 : 0,
        matched_pct: matchedCount > 0 ? (count / matchedCount) * 100 : 0,
      }
    })

    return {
      match_mode: 'razon_social',
      match_column: matchColumn,
      valid_input_count: validInputCount,
      invalid_input_count: invalidInputCount,
      requested_count: sourceRows.length,
      unique_count: sourceRows.length,
      valid_rut_count: validInputCount,
      invalid_rut_count: invalidInputCount,
      duplicate_count: duplicateCount,
      matched_count: matchedCount,
      unmatched_count: unmatchedCount,
      ambiguous_count: ambiguousCount,
      match_rate: matchRate,
      rut_column: null,
      original_columns: originalColumns,
      selected_fields: selectedFields,
      coverage,
      web_enrichment: shouldEnrichContacts ? {
        enabled: true,
        candidates: companiesNeedingWeb.length,
        attempted: webEnrichment?.attempted ?? 0,
        from_cache: webEnrichment?.fromCache ?? 0,
        limited: webEnrichment?.limited ?? false,
        without_result: webEnrichment?.withoutResult ?? 0,
        email_found: exportRows.filter(row => row['Fuente Email'] === 'web').length,
        phone_found: exportRows.filter(row => row['Fuente Teléfono'] === 'web').length,
        providers: webEnrichment?.providers,
      } : undefined,
      rows: exportRows,
    }
  }

  const preparedEntries = sourceRows.map((row, index) => {
    const resolvedRut = resolveRutFromRow(row, matchColumn)
    const sourceCompanyName = companyColumn
      ? String(row[companyColumn] ?? '').trim()
      : ''

    return {
      row,
      rowNumber: index + 1,
      sourceCompanyName,
      ...resolvedRut,
    }
  })

  const validEntries = preparedEntries.filter(entry => entry.isValid && entry.paddedRut)
  const uniqueValidRuts = [...new Set(validEntries.map(entry => entry.paddedRut as string))]
  const duplicateCount = validEntries.length - uniqueValidRuts.length
  let rowsByRut = await fetchMasterRowsByRutIds(uniqueValidRuts, selectedFields)
  const shouldEnrichContacts = enrichMissingContactsWithWeb && (
    selectedFields.includes('email') || selectedFields.includes('fono_cel')
  )
  const companiesNeedingWeb = shouldEnrichContacts
    ? preparedEntries.flatMap(entry => {
        if (!entry.paddedRut || !entry.isValid) return []
        const matchedRow = rowsByRut.get(entry.paddedRut)
        const companyName = String(
          matchedRow?.razon_social_empresa ??
          entry.sourceCompanyName
        ).trim()
        if (!companyName) return []

        const needsEmail = selectedFields.includes('email') && !isPresent(getFieldValue(matchedRow, 'email'))
        const needsPhone = selectedFields.includes('fono_cel') && !isPresent(getFieldValue(matchedRow, 'fono_cel'))

        return needsEmail || needsPhone
          ? [{ companyName, rutid: matchedRow?.rutid ?? entry.paddedRut }]
          : []
      })
    : []
  const webEnrichment = shouldEnrichContacts
    ? await enrichCompanyContacts(companiesNeedingWeb)
    : null

  if (
    shouldEnrichContacts &&
    companiesNeedingWeb.length > 0 &&
    ((webEnrichment?.attempted ?? 0) > 0 || (webEnrichment?.fromCache ?? 0) > 0)
  ) {
    rowsByRut = await fetchMasterRowsByRutIds(uniqueValidRuts, selectedFields)
  }

  const exportRows: BaseBuilderExportRow[] = preparedEntries.map(entry => {
    const matchedRow = entry.paddedRut ? rowsByRut.get(entry.paddedRut) : undefined
    const baseRow: BaseBuilderExportRow = {
      ...entry.row,
      rut_input: entry.raw ?? '',
      rut_formateado: entry.formatted ?? '',
      rutid: matchedRow?.rutid ?? entry.paddedRut,
      match_status: entry.isValid ? (matchedRow ? 'matched' : 'not_found') : 'invalid',
    }

    const companyMatchKey = normalizeCompanyName(
      String(matchedRow?.razon_social_empresa ?? entry.sourceCompanyName ?? '')
    )
    const webMatch = companyMatchKey ? webEnrichment?.items.get(companyMatchKey) : null
    const masterEmail = getFieldValue(matchedRow, 'email')
    const masterPhone = getFieldValue(matchedRow, 'fono_cel')
    const webEmail = webMatch?.emails[0] ?? null
    const webPhone = webMatch?.phones[0] ?? null

    for (const field of selectedFields) {
      const label = fieldLabelMap.get(field) ?? field
      let value = getFieldValue(matchedRow, field)

      if (field === 'email' && !isPresent(value) && webEmail) value = webEmail
      if (field === 'fono_cel' && !isPresent(value) && webPhone) value = webPhone

      baseRow[label] =
        value === undefined ? null : value
    }

    if (shouldEnrichContacts) {
      buildWebEnrichmentColumns(
        baseRow,
        isPresent(masterEmail) ? 'maestro' : webEmail ? 'web' : null,
        isPresent(masterPhone) ? 'maestro' : webPhone ? 'web' : null,
        webMatch?.website ?? null
      )
    }

    return baseRow
  })

  const matchedCount = exportRows.filter(row => row.match_status === 'matched').length
  const validRutCount = validEntries.length
  const invalidRutCount = exportRows.filter(row => row.match_status === 'invalid').length
  const unmatchedCount = validRutCount - matchedCount
  const matchRate = validRutCount > 0 ? (matchedCount / validRutCount) * 100 : 0

  const coverage: BaseBuilderCoverageItem[] = selectedFields.map(field => {
    const definition = BASE_BUILDER_FIELDS.find(item => item.key === field)
    const label = fieldLabelMap.get(field) ?? field
    const count = exportRows.reduce((acc, row) => {
      if (row.match_status !== 'matched') return acc
      return acc + (isPresent(row[label]) ? 1 : 0)
    }, 0)

    return {
      field,
      label: definition?.label ?? field,
      count,
      total: validRutCount,
      matched_total: matchedCount,
      pct: validRutCount > 0 ? (count / validRutCount) * 100 : 0,
      matched_pct: matchedCount > 0 ? (count / matchedCount) * 100 : 0,
    }
  })

  return {
    match_mode: 'rut',
    match_column: matchColumn,
    valid_input_count: validRutCount,
    invalid_input_count: invalidRutCount,
    requested_count: sourceRows.length,
    unique_count: sourceRows.length,
    valid_rut_count: validRutCount,
    invalid_rut_count: invalidRutCount,
    duplicate_count: duplicateCount,
    matched_count: matchedCount,
    unmatched_count: unmatchedCount,
    ambiguous_count: 0,
    match_rate: matchRate,
    rut_column: matchColumn,
    original_columns: originalColumns,
    selected_fields: selectedFields,
    coverage,
    web_enrichment: shouldEnrichContacts ? {
      enabled: true,
      candidates: companiesNeedingWeb.length,
      attempted: webEnrichment?.attempted ?? 0,
      from_cache: webEnrichment?.fromCache ?? 0,
      limited: webEnrichment?.limited ?? false,
      without_result: webEnrichment?.withoutResult ?? 0,
      email_found: exportRows.filter(row => row['Fuente Email'] === 'web').length,
      phone_found: exportRows.filter(row => row['Fuente Teléfono'] === 'web').length,
      providers: webEnrichment?.providers,
    } : undefined,
    rows: exportRows,
  }
}

function buildWebEnrichmentSummary(
  webEnrichment: Awaited<ReturnType<typeof enrichCompanyContacts>> | null
): BaseBuilderWebEnrichmentResult {
  const items = [...(webEnrichment?.items.values() ?? [])]

  return {
    enabled: true,
    candidates: webEnrichment?.candidates ?? 0,
    attempted: webEnrichment?.attempted ?? 0,
    from_cache: webEnrichment?.fromCache ?? 0,
    limited: webEnrichment?.limited ?? false,
    without_result: webEnrichment?.withoutResult ?? 0,
    email_found: items.filter(item => item.emails.length > 0).length,
    phone_found: items.filter(item => item.phones.length > 0).length,
    providers: webEnrichment?.providers,
  }
}

export async function enrichRowsForBaseBuilderWeb(
  sourceRows: Record<string, string>[],
  matchColumn: string,
  companyColumn: string | null,
  requestedFields: string[],
  matchMode: BaseBuilderMatchMode = 'rut'
): Promise<BaseBuilderWebEnrichmentResult | undefined> {
  const selectedFields = sanitizeSelectedFields(requestedFields)
  const shouldEnrichContacts =
    selectedFields.includes('email') || selectedFields.includes('fono_cel')

  if (!shouldEnrichContacts || sourceRows.length === 0) {
    return undefined
  }

  if (matchMode === 'nombre_persona') {
    return {
      enabled: true,
      candidates: 0,
      attempted: 0,
      from_cache: 0,
      limited: false,
      without_result: 0,
      email_found: 0,
      phone_found: 0,
    }
  }

  if (matchMode === 'razon_social') {
    const preparedEntries = sourceRows.map(row => {
      const raw = String(row[matchColumn] ?? '').trim()
      const normalized = normalizeCompanyName(raw)

      return {
        raw,
        normalized,
        isValid: normalized.length > 0,
      }
    })

    const validEntries = preparedEntries.filter(entry => entry.isValid)
    const uniqueValidNames = [...new Set(validEntries.map(entry => entry.normalized))]
    const companyMap = await fetchCompanyMatches(uniqueValidNames)
    const uniqueMatchedRutIds = new Set<string>()

    for (const name of uniqueValidNames) {
      const rutIds = companyMap.get(name)
      if (rutIds?.size === 1) {
        uniqueMatchedRutIds.add([...rutIds][0])
      }
    }

    const rowsByRut = await fetchMasterRowsByRutIds([...uniqueMatchedRutIds], selectedFields)
    const companiesNeedingWeb = preparedEntries.flatMap(entry => {
      const rutIds = companyMap.get(entry.normalized)
      if (!entry.isValid || !rutIds || rutIds.size !== 1) return []

      const matchedRutId = [...rutIds][0]
      const matchedRow = rowsByRut.get(matchedRutId)
      const needsEmail = selectedFields.includes('email') && !isPresent(getFieldValue(matchedRow, 'email'))
      const needsPhone = selectedFields.includes('fono_cel') && !isPresent(getFieldValue(matchedRow, 'fono_cel'))

      return needsEmail || needsPhone
        ? [{ companyName: entry.raw, rutid: matchedRutId }]
        : []
    })

    return buildWebEnrichmentSummary(await enrichCompanyContacts(companiesNeedingWeb))
  }

  const preparedEntries = sourceRows.map(row => {
    const resolvedRut = resolveRutFromRow(row, matchColumn)
    const sourceCompanyName = companyColumn
      ? String(row[companyColumn] ?? '').trim()
      : ''

    return {
      sourceCompanyName,
      ...resolvedRut,
    }
  })

  const validEntries = preparedEntries.filter(entry => entry.isValid && entry.paddedRut)
  const uniqueValidRuts = [...new Set(validEntries.map(entry => entry.paddedRut as string))]
  const rowsByRut = await fetchMasterRowsByRutIds(uniqueValidRuts, selectedFields)
  const companiesNeedingWeb = preparedEntries.flatMap(entry => {
    if (!entry.paddedRut || !entry.isValid) return []

    const matchedRow = rowsByRut.get(entry.paddedRut)
    const companyName = String(
      matchedRow?.razon_social_empresa ??
      entry.sourceCompanyName
    ).trim()

    if (!companyName) return []

    const needsEmail = selectedFields.includes('email') && !isPresent(getFieldValue(matchedRow, 'email'))
    const needsPhone = selectedFields.includes('fono_cel') && !isPresent(getFieldValue(matchedRow, 'fono_cel'))

    return needsEmail || needsPhone
      ? [{ companyName, rutid: matchedRow?.rutid ?? entry.paddedRut }]
      : []
  })

  return buildWebEnrichmentSummary(await enrichCompanyContacts(companiesNeedingWeb))
}
