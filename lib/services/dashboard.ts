'use server'

import { db, hasSupabaseAdminEnv } from '@/lib/db/supabase'
import type { DashboardStats, CoberturaItem } from '@/types'

const emptyTrendStats = {
  empresas_tendencia_total: 0,
  empresas_tendencia_sube: 0,
  empresas_tendencia_baja: 0,
  empresas_tendencia_estable: 0,
  empresas_tendencia_sin_datos: 0,
}

function emptyDashboardStats(): DashboardStats {
  return {
    total_ruts: 0,
    con_nombre: 0,
    con_email: 0,
    con_fono: 0,
    con_autos: 0,
    total_autos: 0,
    con_empresa: 0,
    con_domicilio: 0,
    con_bienes_raices: 0,
    total_avaluos: 0,
    total_propiedades_cargadas: 0,
    ...emptyTrendStats,
    jobs_completados: 0,
    jobs_fallidos: 0,
    total_segmentos: 0,
    last_refreshed: new Date().toISOString(),
  }
}

async function getEmpresasTrendStats() {
  if (!hasSupabaseAdminEnv) {
    return emptyTrendStats
  }

  const { data: resumen, error: resumenError } = await db
    .from('empresas_ventas_tendencia_stats')
    .select('*')
    .single()

  if (!resumenError && resumen) {
    return {
      empresas_tendencia_total: Number(resumen.total_empresas ?? 0),
      empresas_tendencia_sube: Number(resumen.empresas_sube ?? 0),
      empresas_tendencia_baja: Number(resumen.empresas_baja ?? 0),
      empresas_tendencia_estable: Number(resumen.empresas_estable ?? 0),
      empresas_tendencia_sin_datos: Number(resumen.empresas_sin_datos ?? 0),
    }
  }

  const countByResultado = async (resultado?: string) => {
    let query = db
      .from('empresas_ventas_tendencia')
      .select('rutid', { count: 'exact', head: true })

    if (resultado) {
      query = query.eq('resultado_tendencia', resultado)
    }

    const { count, error } = await query
    if (error) return 0
    return count ?? 0
  }

  const [total, sube, baja, estable, sinDatos] = await Promise.all([
    countByResultado(),
    countByResultado('sube'),
    countByResultado('baja'),
    countByResultado('estable'),
    countByResultado('sin_datos'),
  ])

  return {
    empresas_tendencia_total: total,
    empresas_tendencia_sube: sube,
    empresas_tendencia_baja: baja,
    empresas_tendencia_estable: estable,
    empresas_tendencia_sin_datos: sinDatos,
  }
}

/**
 * Obtiene los KPIs principales del dashboard desde la vista materializada
 */
export async function getDashboardKPIs(): Promise<DashboardStats> {
  const trendStats = await getEmpresasTrendStats()

  if (!hasSupabaseAdminEnv) {
    return { ...emptyDashboardStats(), ...trendStats }
  }

  const { data, error } = await db
    .from('dashboard_stats')
    .select('*')
    .single()

  if (error || !data) {
    console.error('[getDashboardKPIs]', error)
    return { ...emptyDashboardStats(), ...trendStats }
  }

  return {
    total_ruts: data.total_ruts ?? 0,
    con_nombre: data.con_nombre ?? 0,
    con_email: data.con_email ?? 0,
    con_fono: data.con_fono ?? 0,
    con_autos: data.con_autos ?? 0,
    total_autos: data.total_autos ?? 0,
    con_empresa: data.con_empresa ?? 0,
    con_domicilio: data.con_domicilio ?? 0,
    con_bienes_raices: data.con_bienes_raices ?? 0,
    total_avaluos: data.total_avaluos ?? 0,
    total_propiedades_cargadas: data.total_propiedades_cargadas ?? 0,
    ...trendStats,
    jobs_completados: data.jobs_completados ?? 0,
    jobs_fallidos: data.jobs_fallidos ?? 0,
    total_segmentos: data.total_segmentos ?? 0,
    last_refreshed: data.last_refreshed ?? new Date().toISOString(),
  }
}

/**
 * Calcula cobertura de datos por campo
 */
export async function getCoberturaData(): Promise<CoberturaItem[]> {
  const stats = await getDashboardKPIs()
  const total = stats.total_ruts

  const items: CoberturaItem[] = [
    {
      field: 'nombres',
      label: 'Nombre',
      count: stats.con_nombre,
      total,
      pct: total > 0 ? Math.round((stats.con_nombre / total) * 100) : 0,
    },
    {
      field: 'email',
      label: 'Email',
      count: stats.con_email,
      total,
      pct: total > 0 ? Math.round((stats.con_email / total) * 100) : 0,
    },
    {
      field: 'fono_cel',
      label: 'Teléfono',
      count: stats.con_fono,
      total,
      pct: total > 0 ? Math.round((stats.con_fono / total) * 100) : 0,
    },
    {
      field: 'n_autos',
      label: 'Autos',
      count: stats.con_autos,
      total,
      pct: total > 0 ? Math.round((stats.con_autos / total) * 100) : 0,
    },
    {
      field: 'empresa',
      label: 'Empresa',
      count: stats.con_empresa,
      total,
      pct: total > 0 ? Math.round((stats.con_empresa / total) * 100) : 0,
    },
    {
      field: 'domicilio',
      label: 'Domicilio',
      count: stats.con_domicilio,
      total,
      pct: total > 0 ? Math.round((stats.con_domicilio / total) * 100) : 0,
    },
    {
      field: 'bienes_raices',
      label: 'Bienes raíces',
      count: stats.con_bienes_raices,
      total,
      pct: total > 0 ? Math.round((stats.con_bienes_raices / total) * 100) : 0,
    },
  ]

  return items.sort((a, b) => b.pct - a.pct)
}

/**
 * Obtiene actividad reciente de ingesta
 */
export async function getRecentActivity(limit = 10) {
  if (!hasSupabaseAdminEnv) {
    return []
  }

  const { data, error } = await db
    .from('ingestion_jobs')
    .select(`
      id, file_name, status, total_rows, valid_rows,
      merged_rows, new_rows, created_at, completed_at,
      data_sources (name)
    `)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[getRecentActivity]', error)
    return []
  }

  return data ?? []
}

/**
 * Obtiene la distribución de score patrimonial
 */
export async function getScoreDistribution() {
  if (!hasSupabaseAdminEnv) return []
  const { data, error } = await db.from('stats_score_dist').select('*').order('range')
  if (error) console.error('[getScoreDistribution]', error)
  return data ?? []
}

/**
 * Obtiene el top de regiones por volumen
 */
export async function getStatsPorRegion(limit = 10) {
  if (!hasSupabaseAdminEnv) return []
  const { data, error } = await db
    .from('stats_por_region')
    .select('*')
    .order('total', { ascending: false })
    .limit(limit)
  if (error) console.error('[getStatsPorRegion]', error)
  return data ?? []
}

/**
 * Refresca la vista materializada de stats
 */
export async function refreshStats(): Promise<void> {
  if (!hasSupabaseAdminEnv) {
    return
  }

  await db.rpc('refresh_dashboard_stats')
}
