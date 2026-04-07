'use server'

import { db } from '@/lib/db/supabase'
import type { PersonaView, PaginatedResponse, PersonaSearchParams } from '@/types'
import { normalizeRut } from '@/lib/utils/rut'

// Columnas permitidas para ordenar (usan los nombres de la vista)
const PERSONA_SORT_FIELDS = new Set([
  'rutid',
  'nombre_completo',
  'email',
  'region_canonica',
  'comuna_canonica',
  'n_autos',
  'n_bienes_raices',
  'totalavaluos',
  'score_patrimonial',
  'cobertura_pct',
])

function getSafeSortField(field?: string): string {
  if (!field) return 'score_patrimonial'
  return PERSONA_SORT_FIELDS.has(field) ? field : 'score_patrimonial'
}

/**
 * Obtiene el perfil 360 completo de una persona por RUT.
 * Consulta master_personas_view (que transforma personas_master).
 */
export async function getPersonaByRut(rut: string): Promise<PersonaView | null> {
  // DB stores RUT zero-padded, no dash: e.g. "12345678-9" → "0123456789"
  // We clean the input (remove dots/dashes) then use ILIKE suffix match
  const cleaned = rut.replace(/[.\-\s]/g, '').toUpperCase()

  const { data, error } = await db
    .from('master_personas_view')
    .select('*')
    .ilike('rutid', `%${cleaned}`)
    .limit(1)
    .single()

  if (error || !data) return null
  return data as PersonaView
}

/**
 * Búsqueda de personas con filtros avanzados y paginación.
 * Consulta master_personas_view para aprovechar las columnas computadas.
 */
export async function searchPersonas(
  params: PersonaSearchParams
): Promise<PaginatedResponse<PersonaView>> {
  const {
    q,
    page = 1,
    page_size = 50,
    sort_by,
    sort_order = 'desc',
    region,
    comuna,
    tiene_autos,
    tiene_empresa,
    tiene_bienes_raices,
    score_min,
    score_max,
  } = params

  const from = (page - 1) * page_size
  const to = from + page_size - 1

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = (db as any)
    .from('master_personas_view')
    .select('*', { count: 'exact' })

  const safeSortBy = getSafeSortField(sort_by)

  // Búsqueda por texto libre (RUT, nombre, email)
  if (q && q.trim()) {
    const term = q.trim()
    // Si parece RUT (empieza con dígito o tiene formato chileno con puntos/guión)
    if (/^\d[\d.\-kK]*$/.test(term)) {
      // DB almacena sin puntos ni guión, zero-padded a 10 chars.
      // Ejemplo: "12.345.678-9" → "123456789" → ILIKE "%123456789" (sufijo exacto)
      const cleaned = term.replace(/[.\-\s]/g, '').toUpperCase()
      query = query.ilike('rutid', `%${cleaned}`)
    } else {
      query = query.or(
        `nombre_completo.ilike.%${term}%,email.ilike.%${term}%,razon_social_empresa.ilike.%${term}%`
      )
    }
  }

  // Filtros por ubicación
  if (region) query = query.ilike('region_canonica', `%${region}%`)
  if (comuna) query = query.ilike('comuna_canonica', `%${comuna}%`)

  // Filtros booleanos (columna computada en la vista)
  if (tiene_autos !== undefined) query = query.eq('tiene_autos', tiene_autos)
  if (tiene_empresa !== undefined) query = query.eq('tiene_empresa', tiene_empresa)
  if (tiene_bienes_raices !== undefined)
    query = query.eq('tiene_bienes_raices', tiene_bienes_raices)

  // Filtro por score
  if (score_min !== undefined) query = query.gte('score_patrimonial', score_min)
  if (score_max !== undefined) query = query.lte('score_patrimonial', score_max)

  const { data, error, count } = await query
    .order(safeSortBy, { ascending: sort_order === 'asc' })
    .range(from, to)

  if (error) {
    console.error('[searchPersonas]', error)
    return { data: [], total: 0, page, page_size, total_pages: 0 }
  }

  const total = count ?? 0
  return {
    data: (data ?? []) as PersonaView[],
    total,
    page,
    page_size,
    total_pages: Math.ceil(total / page_size),
  }
}

/**
 * Obtiene estadísticas por región.
 */
export async function getPersonasByRegion(): Promise<
  { region: string; count: number }[]
> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('stats_por_region')
    .select('region, total')
    .order('total', { ascending: false })

  if (!error && Array.isArray(data)) {
    return data.map((row: { region: string; total: number }) => ({
      region: row.region,
      count: row.total,
    }))
  }

  console.warn('[getPersonasByRegion] stats_por_region not available:', error?.message)
  return []
}

/**
 * Obtiene distribución de score patrimonial.
 */
export async function getScoreDistribution(): Promise<
  { range: string; count: number }[]
> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('stats_score_dist')
    .select('range, count')
    .order('range', { ascending: true })

  if (!error && Array.isArray(data)) {
    return data.map((row: { range: string; count: number }) => ({
      range: row.range,
      count: row.count,
    }))
  }

  console.warn('[getScoreDistribution] stats_score_dist not available:', error?.message)
  return []
}

/**
 * Verifica si un RUT existe en personas_master.
 */
export async function rutExists(rut: string): Promise<boolean> {
  const rutNorm = normalizeRut(rut)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count } = await (db as any)
    .from('personas_master')
    .select('rutid', { count: 'exact', head: true })
    .eq('rutid', rutNorm)
  return (count ?? 0) > 0
}
