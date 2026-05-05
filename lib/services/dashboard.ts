'use server'

import { db, hasSupabaseAdminEnv } from '@/lib/db/supabase'
import type { DashboardStats, CoberturaItem } from '@/types'

const emptyEmpresaStats = {
  empresas_universo_total: 0,
  empresas_base_pyme: 0,
  empresas_base_tendencia: 0,
  empresas_cruzadas: 0,
  empresas_solo_pyme_master: 0,
  empresas_solo_tendencia: 0,
  empresas_con_direccion: 0,
  empresas_con_comuna: 0,
  empresas_con_region: 0,
  empresas_pyme: 0,
  empresas_grandes: 0,
  empresas_corporacion: 0,
  empresas_segmento_micro: 0,
  empresas_segmento_micro_sube: 0,
  empresas_segmento_micro_baja: 0,
  empresas_segmento_pequena: 0,
  empresas_segmento_pequena_sube: 0,
  empresas_segmento_pequena_baja: 0,
  empresas_segmento_mediana: 0,
  empresas_segmento_mediana_sube: 0,
  empresas_segmento_mediana_baja: 0,
  empresas_segmento_gran_empresa: 0,
  empresas_segmento_gran_empresa_sube: 0,
  empresas_segmento_gran_empresa_baja: 0,
  empresas_segmento_corporacion: 0,
  empresas_segmento_corporacion_sube: 0,
  empresas_segmento_corporacion_baja: 0,
  empresas_segmento_pyme_master_sin_tramo: 0,
  empresas_segmento_pyme_master_sin_tramo_sube: 0,
  empresas_segmento_pyme_master_sin_tramo_baja: 0,
  empresas_tendencia_total: 0,
  empresas_tendencia_sube: 0,
  empresas_tendencia_baja: 0,
  empresas_tendencia_estable: 0,
  empresas_tendencia_sin_datos: 0,
}

const emptyBbrrUsageStats = {
  bbrr_ruts_residencial: 0,
  bbrr_ruts_comercial: 0,
  bbrr_ruts_mixto: 0,
  bbrr_ruts_rural: 0,
  bbrr_ruts_especial: 0,
  bbrr_propiedades_residenciales: 0,
  bbrr_propiedades_comerciales: 0,
  bbrr_propiedades_rurales: 0,
  bbrr_propiedades_especiales: 0,
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
    ...emptyBbrrUsageStats,
    ...emptyEmpresaStats,
    jobs_completados: 0,
    jobs_fallidos: 0,
    total_segmentos: 0,
    last_refreshed: new Date().toISOString(),
  }
}

async function getBbrrUsageStats() {
  if (!hasSupabaseAdminEnv) {
    return emptyBbrrUsageStats
  }

  const { data, error } = await db
    .rpc('get_bbrr_dashboard_usage_stats')

  if (error || !data) {
    console.error('[getBbrrUsageStats]', error)
    return emptyBbrrUsageStats
  }

  const row = Array.isArray(data) ? data[0] : data
  if (!row) return emptyBbrrUsageStats

  return {
    bbrr_ruts_residencial: Number(row.bbrr_ruts_residencial ?? 0),
    bbrr_ruts_comercial: Number(row.bbrr_ruts_comercial ?? 0),
    bbrr_ruts_mixto: Number(row.bbrr_ruts_mixto ?? 0),
    bbrr_ruts_rural: Number(row.bbrr_ruts_rural ?? 0),
    bbrr_ruts_especial: Number(row.bbrr_ruts_especial ?? 0),
    bbrr_propiedades_residenciales: Number(row.bbrr_propiedades_residenciales ?? 0),
    bbrr_propiedades_comerciales: Number(row.bbrr_propiedades_comerciales ?? 0),
    bbrr_propiedades_rurales: Number(row.bbrr_propiedades_rurales ?? 0),
    bbrr_propiedades_especiales: Number(row.bbrr_propiedades_especiales ?? 0),
  }
}

async function getEmpresasStats() {
  if (!hasSupabaseAdminEnv) {
    return emptyEmpresaStats
  }

  const { data: universeStats, error: universeError } = await db
    .from('empresas_comercial_unificada_stats')
    .select('*')
    .single()

  if (!universeError && universeStats) {
    return {
      empresas_universo_total: Number(universeStats.total_empresas_unicas ?? 0),
      empresas_base_pyme: Number(universeStats.empresas_base_pyme ?? 0),
      empresas_base_tendencia: Number(universeStats.empresas_base_tendencia ?? 0),
      empresas_cruzadas: Number(universeStats.empresas_cruzadas ?? 0),
      empresas_solo_pyme_master: Number(universeStats.empresas_solo_pyme_master ?? 0),
      empresas_solo_tendencia: Number(universeStats.empresas_solo_tendencia ?? 0),
      empresas_con_direccion: Number(universeStats.empresas_con_direccion ?? 0),
      empresas_con_comuna: Number(universeStats.empresas_con_comuna ?? 0),
      empresas_con_region: Number(universeStats.empresas_con_region ?? 0),
      empresas_pyme: Number(universeStats.empresas_pyme ?? 0),
      empresas_grandes: Number(universeStats.empresas_grandes ?? 0),
      empresas_corporacion: Number(universeStats.empresas_corporacion ?? 0),
      empresas_segmento_micro: Number(universeStats.segmento_micro ?? 0),
      empresas_segmento_micro_sube: Number(universeStats.segmento_micro_sube ?? 0),
      empresas_segmento_micro_baja: Number(universeStats.segmento_micro_baja ?? 0),
      empresas_segmento_pequena: Number(universeStats.segmento_pequena ?? 0),
      empresas_segmento_pequena_sube: Number(universeStats.segmento_pequena_sube ?? 0),
      empresas_segmento_pequena_baja: Number(universeStats.segmento_pequena_baja ?? 0),
      empresas_segmento_mediana: Number(universeStats.segmento_mediana ?? 0),
      empresas_segmento_mediana_sube: Number(universeStats.segmento_mediana_sube ?? 0),
      empresas_segmento_mediana_baja: Number(universeStats.segmento_mediana_baja ?? 0),
      empresas_segmento_gran_empresa: Number(universeStats.segmento_gran_empresa ?? 0),
      empresas_segmento_gran_empresa_sube: Number(universeStats.segmento_gran_empresa_sube ?? 0),
      empresas_segmento_gran_empresa_baja: Number(universeStats.segmento_gran_empresa_baja ?? 0),
      empresas_segmento_corporacion: Number(universeStats.segmento_corporacion ?? 0),
      empresas_segmento_corporacion_sube: Number(universeStats.segmento_corporacion_sube ?? 0),
      empresas_segmento_corporacion_baja: Number(universeStats.segmento_corporacion_baja ?? 0),
      empresas_segmento_pyme_master_sin_tramo: Number(universeStats.segmento_pyme_master_sin_tramo ?? 0),
      empresas_segmento_pyme_master_sin_tramo_sube: Number(universeStats.segmento_pyme_master_sin_tramo_sube ?? 0),
      empresas_segmento_pyme_master_sin_tramo_baja: Number(universeStats.segmento_pyme_master_sin_tramo_baja ?? 0),
      empresas_tendencia_total: Number(universeStats.empresas_base_tendencia ?? 0),
      empresas_tendencia_sube: Number(universeStats.empresas_sube ?? 0),
      empresas_tendencia_baja: Number(universeStats.empresas_baja ?? 0),
      empresas_tendencia_estable: Number(universeStats.empresas_estable ?? 0),
      empresas_tendencia_sin_datos: Number(universeStats.empresas_sin_datos ?? 0),
    }
  }

  const { data: resumen, error: resumenError } = await db
    .from('empresas_ventas_tendencia_stats')
    .select('*')
    .single()

  if (!resumenError && resumen) {
    return {
      ...emptyEmpresaStats,
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
    ...emptyEmpresaStats,
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
  const [empresaStats, bbrrUsageStats] = await Promise.all([
    getEmpresasStats(),
    getBbrrUsageStats(),
  ])

  if (!hasSupabaseAdminEnv) {
    return { ...emptyDashboardStats(), ...empresaStats, ...bbrrUsageStats }
  }

  const { data, error } = await db
    .from('dashboard_stats')
    .select('*')
    .single()

  if (error || !data) {
    console.error('[getDashboardKPIs]', error)
    return { ...emptyDashboardStats(), ...empresaStats }
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
    ...bbrrUsageStats,
    ...empresaStats,
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
