'use server'

import { supabaseAdmin, db } from '@/lib/db/supabase'
import {
  FILTER_FIELDS,
  type Segmento,
  type SegmentFilter,
  type FilterCondition,
  type PersonaView,
  type PaginatedResponse,
} from '@/types'

const ALLOWED_FIELDS = new Set(FILTER_FIELDS.map(field => field.key))
const NUMERIC_FIELDS = new Set(
  FILTER_FIELDS.filter(field => field.type === 'number').map(field => field.key)
)
const BOOLEAN_FIELDS = new Set(
  FILTER_FIELDS.filter(field => field.type === 'boolean').map(field => field.key)
)

function assertAllowedField(field: string): string {
  if (!ALLOWED_FIELDS.has(field as keyof PersonaView)) {
    throw new Error(`Campo de filtro no permitido: ${field}`)
  }
  return field
}

function normalizeFilterValue(field: string, value: unknown): string | number | boolean | null {
  if (value === null || value === undefined || value === '') return null

  if (NUMERIC_FIELDS.has(field as keyof PersonaView)) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  if (BOOLEAN_FIELDS.has(field as keyof PersonaView)) {
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    return null
  }

  return String(value).trim()
}

function escapeSqlLiteral(value: string | number | boolean | null): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return `'${String(value).replace(/'/g, "''")}'`
}

function buildConditionPreview(cond: FilterCondition): string {
  const field = assertAllowedField(cond.field)
  const value = normalizeFilterValue(field, cond.value)
  const value2 = normalizeFilterValue(field, cond.value2)

  switch (cond.operator) {
    case 'eq':
      return `${field} = ${escapeSqlLiteral(value)}`
    case 'neq':
      return `${field} != ${escapeSqlLiteral(value)}`
    case 'gt':
      return `${field} > ${escapeSqlLiteral(value)}`
    case 'gte':
      return `${field} >= ${escapeSqlLiteral(value)}`
    case 'lt':
      return `${field} < ${escapeSqlLiteral(value)}`
    case 'lte':
      return `${field} <= ${escapeSqlLiteral(value)}`
    case 'between':
      return `${field} BETWEEN ${escapeSqlLiteral(value)} AND ${escapeSqlLiteral(value2)}`
    case 'in':
      return `${field} IN (${String(cond.value)
        .split(',')
        .map(item => escapeSqlLiteral(normalizeFilterValue(field, item.trim())))
        .join(', ')})`
    case 'not_in':
      return `${field} NOT IN (${String(cond.value)
        .split(',')
        .map(item => escapeSqlLiteral(normalizeFilterValue(field, item.trim())))
        .join(', ')})`
    case 'is_null':
      return `${field} IS NULL`
    case 'is_not_null':
      return `${field} IS NOT NULL`
    case 'contains':
      return `${field} ILIKE ${escapeSqlLiteral(`%${value ?? ''}%`)}`
    case 'starts_with':
      return `${field} ILIKE ${escapeSqlLiteral(`${value ?? ''}%`)}`
    default:
      return '1=1'
  }
}

function buildSegmentPreview(filters: SegmentFilter): string {
  const conditions = filters.conditions ?? []
  if (conditions.length === 0) {
    return 'SELECT * FROM master_personas_current'
  }

  const logic = filters.logic === 'OR' ? 'OR' : 'AND'
  const where = conditions.map(buildConditionPreview).join(` ${logic} `)
  return `SELECT * FROM master_personas_current WHERE ${where}`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFilterToQuery(query: any, cond: FilterCondition): any {
  const field = assertAllowedField(cond.field)
  const value = normalizeFilterValue(field, cond.value)
  const value2 = normalizeFilterValue(field, cond.value2)

  switch (cond.operator) {
    case 'eq':
      return query.eq(field, value)
    case 'neq':
      return query.neq(field, value)
    case 'gt':
      return query.gt(field, value)
    case 'gte':
      return query.gte(field, value)
    case 'lt':
      return query.lt(field, value)
    case 'lte':
      return query.lte(field, value)
    case 'between':
      return query.gte(field, value).lte(field, value2)
    case 'in': {
      const items = String(cond.value)
        .split(',')
        .map(item => normalizeFilterValue(field, item.trim()))
        .filter(item => item !== null)
      return query.in(field, items)
    }
    case 'not_in': {
      const items = String(cond.value)
        .split(',')
        .map(item => normalizeFilterValue(field, item.trim()))
        .filter(item => item !== null)
      return query.not(field, 'in', `(${items.join(',')})`)
    }
    case 'is_null':
      return query.is(field, null)
    case 'is_not_null':
      return query.not(field, 'is', null)
    case 'contains':
      return query.ilike(field, `%${String(value ?? '')}%`)
    case 'starts_with':
      return query.ilike(field, `${String(value ?? '')}%`)
    default:
      return query
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applySegmentFilters(query: any, filters: SegmentFilter): any {
  const conditions = filters.conditions ?? []
  if (conditions.length === 0) return query

  const logic = filters.logic === 'OR' ? 'OR' : 'AND'

  if (logic === 'AND') {
    return conditions.reduce((currentQuery, condition) => {
      return applyFilterToQuery(currentQuery, condition)
    }, query)
  }

  const orClauses = conditions.map(cond => {
    const field = assertAllowedField(cond.field)
    const value = normalizeFilterValue(field, cond.value)
    const value2 = normalizeFilterValue(field, cond.value2)

    switch (cond.operator) {
      case 'eq':
        return `${field}.eq.${value}`
      case 'neq':
        return `${field}.neq.${value}`
      case 'gt':
        return `${field}.gt.${value}`
      case 'gte':
        return `${field}.gte.${value}`
      case 'lt':
        return `${field}.lt.${value}`
      case 'lte':
        return `${field}.lte.${value}`
      case 'between':
        return `and(${field}.gte.${value},${field}.lte.${value2})`
      case 'in': {
        const items = String(cond.value)
          .split(',')
          .map(item => normalizeFilterValue(field, item.trim()))
          .filter(item => item !== null)
        return `${field}.in.(${items.join(',')})`
      }
      case 'not_in':
        return ''
      case 'is_null':
        return `${field}.is.null`
      case 'is_not_null':
        return `${field}.not.is.null`
      case 'contains':
        return `${field}.ilike.%${String(value ?? '')}%`
      case 'starts_with':
        return `${field}.ilike.${String(value ?? '')}%`
      default:
        return ''
    }
  }).filter(Boolean)

  if (orClauses.length === 0) return query
  return query.or(orClauses.join(','))
}

/**
 * Obtiene todos los segmentos activos
 */
export async function getSegmentos(page = 1, pageSize = 20) {
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  const { data, error, count } = await supabaseAdmin
    .from('segmentos')
    .select('*', { count: 'exact' })
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .range(from, to)

  if (error) {
    console.error('[getSegmentos]', error)
    return { data: [], total: 0, page, page_size: pageSize, total_pages: 0 }
  }

  return {
    data: (data ?? []) as Segmento[],
    total: count ?? 0,
    page,
    page_size: pageSize,
    total_pages: Math.ceil((count ?? 0) / pageSize),
  }
}

/**
 * Obtiene un segmento por ID
 */
export async function getSegmentoById(id: string): Promise<Segmento | null> {
  const { data, error } = await supabaseAdmin
    .from('segmentos')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !data) return null
  return data as Segmento
}

/**
 * Crea un nuevo segmento
 */
export async function createSegmento(
  name: string,
  description: string | null,
  filters: SegmentFilter,
  userId: string
): Promise<Segmento | null> {
  const sqlQuery = buildSegmentPreview(filters)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('segmentos')
    .insert({
      name,
      description,
      filters,
      sql_query: sqlQuery,
      created_by: userId,
    })
    .select()
    .single()

  if (error) {
    console.error('[createSegmento]', error)
    return null
  }

  await computeSegmentoCount(data.id)
  return data as Segmento
}

/**
 * Actualiza un segmento existente
 */
export async function updateSegmento(
  id: string,
  updates: Partial<Pick<Segmento, 'name' | 'description' | 'filters' | 'is_active'>>
): Promise<Segmento | null> {
  const payload: Partial<Segmento> & { sql_query?: string } = { ...updates }

  if (updates.filters) {
    payload.sql_query = buildSegmentPreview(updates.filters)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('segmentos')
    .update(payload)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    console.error('[updateSegmento]', error)
    return null
  }

  await computeSegmentoCount(id)
  return data as Segmento
}

/**
 * Computa el conteo de registros de un segmento
 */
export async function computeSegmentoCount(id: string): Promise<number> {
  const segmento = await getSegmentoById(id)
  if (!segmento) return 0

  let query = supabaseAdmin
    .from('master_personas_view')
    .select('rutid', { count: 'exact', head: true })

  query = applySegmentFilters(query, segmento.filters as SegmentFilter)

  const { count, error } = await query

  if (error) {
    console.error('[computeSegmentoCount]', error)
    return 0
  }

  const rowCount = count ?? 0

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any)
    .from('segmentos')
    .update({ row_count: rowCount, last_computed: new Date().toISOString() })
    .eq('id', id)

  return rowCount
}

/**
 * Ejecuta la consulta de un segmento y devuelve los datos paginados
 */
export async function executeSegmento(
  id: string,
  page = 1,
  pageSize = 100
): Promise<PaginatedResponse<PersonaView>> {
  const segmento = await getSegmentoById(id)
  if (!segmento) {
    return { data: [], total: 0, page, page_size: pageSize, total_pages: 0 }
  }

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  let query = supabaseAdmin
    .from('master_personas_view')
    .select('*', { count: 'exact' })

  query = applySegmentFilters(query, segmento.filters as SegmentFilter)

  const { data, error, count } = await query
    .order('score_patrimonial', { ascending: false })
    .range(from, to)

  if (error) {
    console.error('[executeSegmento]', error)
    return { data: [], total: 0, page, page_size: pageSize, total_pages: 0 }
  }

  return {
    data: (data ?? []) as PersonaView[],
    total: count ?? 0,
    page,
    page_size: pageSize,
    total_pages: Math.ceil((count ?? 0) / pageSize),
  }
}

/**
 * Carga un batch de filas para exportacion server-side
 */
export async function getSegmentoBatch(
  id: string,
  from = 0,
  pageSize = 5000
): Promise<PersonaView[]> {
  const segmento = await getSegmentoById(id)
  if (!segmento) return []

  let query = supabaseAdmin
    .from('master_personas_view')
    .select('*')

  query = applySegmentFilters(query, segmento.filters as SegmentFilter)

  const { data, error } = await query
    .order('score_patrimonial', { ascending: false })
    .range(from, from + pageSize - 1)

  if (error) {
    console.error('[getSegmentoBatch]', error)
    return []
  }

  return (data ?? []) as PersonaView[]
}

/**
 * Elimina (desactiva) un segmento
 */
export async function deleteSegmento(id: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any)
    .from('segmentos')
    .update({ is_active: false })
    .eq('id', id)
  return !error
}
