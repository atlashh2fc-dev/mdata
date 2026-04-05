'use server'

import { supabaseAdmin } from '@/lib/db/supabase'
import type {
  Segmento,
  SegmentFilter,
  FilterCondition,
  PersonaView,
  PaginatedResponse,
} from '@/types'

/**
 * Construye cláusula WHERE desde filtros del segmentador
 */
function buildWhereClause(filters: SegmentFilter): string {
  if (!filters.conditions || filters.conditions.length === 0) return '1=1'

  const clauses = filters.conditions.map(buildConditionClause).filter(Boolean)
  return clauses.join(` ${filters.logic} `)
}

function buildConditionClause(cond: FilterCondition): string {
  const { field, operator, value, value2 } = cond

  // Sanitización básica (no interpolación directa de valores del usuario en prod)
  const safeField = field.replace(/[^a-zA-Z0-9_]/g, '')

  switch (operator) {
    case 'eq':       return `${safeField} = '${value}'`
    case 'neq':      return `${safeField} != '${value}'`
    case 'gt':       return `${safeField} > ${value}`
    case 'gte':      return `${safeField} >= ${value}`
    case 'lt':       return `${safeField} < ${value}`
    case 'lte':      return `${safeField} <= ${value}`
    case 'between':  return `${safeField} BETWEEN ${value} AND ${value2}`
    case 'in':       return `${safeField} IN (${String(value).split(',').map(v => `'${v.trim()}'`).join(',')})`
    case 'not_in':   return `${safeField} NOT IN (${String(value).split(',').map(v => `'${v.trim()}'`).join(',')})`
    case 'is_null':  return `${safeField} IS NULL`
    case 'is_not_null': return `${safeField} IS NOT NULL`
    case 'contains': return `${safeField} ILIKE '%${value}%'`
    case 'starts_with': return `${safeField} ILIKE '${value}%'`
    default:         return ''
  }
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
  const sqlQuery = `SELECT * FROM master_personas_view WHERE ${buildWhereClause(filters)}`

  const { data, error } = await supabaseAdmin
    .from('segmentos')
    .insert({
      name,
      description,
      filters: filters as unknown as Record<string, unknown>,
      sql_query: sqlQuery,
      created_by: userId,
    })
    .select()
    .single()

  if (error) {
    console.error('[createSegmento]', error)
    return null
  }

  // Computar conteo inmediatamente
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
  const payload: Record<string, unknown> = { ...updates }

  if (updates.filters) {
    payload.sql_query = `SELECT * FROM master_personas_view WHERE ${buildWhereClause(updates.filters)}`
  }

  const { data, error } = await supabaseAdmin
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

  const whereClause = buildWhereClause(segmento.filters as SegmentFilter)

  // Usamos count en la vista
  const { count, error } = await supabaseAdmin
    .from('master_personas_view')
    .select('rutid', { count: 'exact', head: true })

  if (error) return 0

  const rowCount = count ?? 0

  await supabaseAdmin
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

  // Aplicar filtros directamente via Supabase filters
  const filters = segmento.filters as SegmentFilter
  let query = supabaseAdmin
    .from('master_personas_view')
    .select('*', { count: 'exact' })

  // Aplicar condiciones
  for (const cond of filters.conditions ?? []) {
    query = applyFilterToQuery(query, cond)
  }

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFilterToQuery(query: any, cond: FilterCondition): any {
  const { field, operator, value, value2 } = cond

  switch (operator) {
    case 'eq':          return query.eq(field, value)
    case 'neq':         return query.neq(field, value)
    case 'gt':          return query.gt(field, value)
    case 'gte':         return query.gte(field, value)
    case 'lt':          return query.lt(field, value)
    case 'lte':         return query.lte(field, value)
    case 'between':     return query.gte(field, value).lte(field, value2)
    case 'in':          return query.in(field, String(value).split(',').map(v => v.trim()))
    case 'not_in':      return query.not(field, 'in', `(${String(value).split(',').map(v => v.trim()).join(',')})`)
    case 'is_null':     return query.is(field, null)
    case 'is_not_null': return query.not(field, 'is', null)
    case 'contains':    return query.ilike(field, `%${value}%`)
    case 'starts_with': return query.ilike(field, `${value}%`)
    default:            return query
  }
}

/**
 * Elimina (desactiva) un segmento
 */
export async function deleteSegmento(id: string): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from('segmentos')
    .update({ is_active: false })
    .eq('id', id)
  return !error
}
