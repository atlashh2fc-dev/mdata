'use server'

import { db } from '@/lib/db/supabase'
import type { PersonaView, PaginatedResponse, PersonaSearchParams } from '@/types'
import { normalizeRut } from '@/lib/utils/rut'

const PERSONA_SORT_FIELDS = new Set([
  'rutid',
  'nombre_completo',
  'email',
  'region_part',
  'comuna_part',
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
 * Obtiene el perfil 360 completo de una persona por RUT
 */
export async function getPersonaByRut(rut: string): Promise<PersonaView | null> {
  const rutNorm = normalizeRut(rut)

  const { data, error } = await db
    .from('master_personas_view')
    .select('*')
    .eq('rutid', rutNorm)
    .single()

  if (error || !data) return null
  return data as PersonaView
}

/**
 * Búsqueda de personas con filtros avanzados y paginación
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

  let query = db.from('master_personas_view').select('*', { count: 'exact' })
  const safeSortBy = getSafeSortField(sort_by)

  // Búsqueda por texto libre (RUT, nombre, email)
  if (q && q.trim()) {
    const term = q.trim()
    // Si parece RUT
    if (/^\d[\d.\-kK]*$/.test(term)) {
      query = query.ilike('rutid', `%${normalizeRut(term)}%`)
    } else {
      query = query.or(
        `nombre_completo.ilike.%${term}%,email.ilike.%${term}%,razon_social_empresa.ilike.%${term}%`
      )
    }
  }

  if (region) query = query.ilike('region_part', `%${region}%`)
  if (comuna) query = query.ilike('comuna_part', `%${comuna}%`)
  if (tiene_autos !== undefined) query = query.eq('tiene_autos', tiene_autos)
  if (tiene_empresa !== undefined) query = query.eq('tiene_empresa', tiene_empresa)
  if (tiene_bienes_raices !== undefined) query = query.eq('tiene_bienes_raices', tiene_bienes_raices)
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
 * Obtiene estadísticas por región (para mapas y gráficos)
 */
export async function getPersonasByRegion(): Promise<
  { region: string; count: number }[]
> {
  // Primero intentamos usar la vista materializada si existe.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statsView = (db as any)
    .from('stats_por_region')
    .select('region, total')
    .order('total', { ascending: false })

  const { data, error } = await statsView
  if (!error && Array.isArray(data)) {
    return data.map((row: { region: string; total: number }) => ({
      region: row.region,
      count: row.total,
    }))
  }

  const fallback = await db
    .from('pernat_resumen')
    .select('region_part')
    .not('region_part', 'is', null)

  if (fallback.error || !fallback.data) return []

  const counts: Record<string, number> = {}
  for (const row of fallback.data) {
    const r = row.region_part ?? 'Sin región'
    counts[r] = (counts[r] ?? 0) + 1
  }

  return Object.entries(counts)
    .map(([region, count]) => ({ region, count }))
    .sort((a, b) => b.count - a.count)
}

/**
 * Obtiene distribución de score patrimonial
 */
export async function getScoreDistribution(): Promise<
  { range: string; count: number }[]
> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statsView = (db as any)
    .from('stats_score_dist')
    .select('range, count')
    .order('range', { ascending: true })

  const { data, error } = await statsView
  if (!error && Array.isArray(data)) {
    return data.map((row: { range: string; count: number }) => ({
      range: row.range,
      count: row.count,
    }))
  }

  const { data: rows } = await db
    .from('master_personas_view')
    .select('score_patrimonial')
    .limit(100000)

  if (!rows) return []

  const ranges = [
    { label: '0', min: 0, max: 0 },
    { label: '1-20', min: 1, max: 20 },
    { label: '21-40', min: 21, max: 40 },
    { label: '41-60', min: 41, max: 60 },
    { label: '61-80', min: 61, max: 80 },
    { label: '81+', min: 81, max: Infinity },
  ]

  return ranges.map(r => ({
    range: r.label,
    count: rows.filter(
      row => (row.score_patrimonial ?? 0) >= r.min && (row.score_patrimonial ?? 0) <= r.max
    ).length,
  }))
}

/**
 * Verifica si un RUT existe en master_personas
 */
export async function rutExists(rut: string): Promise<boolean> {
  const rutNorm = normalizeRut(rut)
  const { count } = await db
    .from('master_personas')
    .select('rutid', { count: 'exact', head: true })
    .eq('rutid', rutNorm)
  return (count ?? 0) > 0
}
