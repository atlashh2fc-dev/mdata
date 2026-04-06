'use server'

import { db, hasSupabaseAdminEnv } from '@/lib/db/supabase'
import type { DashboardStats, CoberturaItem } from '@/types'

/**
 * Obtiene los KPIs principales del dashboard desde la vista materializada
 */
export async function getDashboardKPIs(): Promise<DashboardStats> {
  if (!hasSupabaseAdminEnv) {
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
      jobs_completados: 0,
      jobs_fallidos: 0,
      total_segmentos: 0,
      last_refreshed: new Date().toISOString(),
    }
  }

  const { data, error } = await db
    .from('dashboard_stats')
    .select('*')
    .single()

  if (error || !data) {
    console.error('[getDashboardKPIs]', error)
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
      jobs_completados: 0,
      jobs_fallidos: 0,
      total_segmentos: 0,
      last_refreshed: new Date().toISOString(),
    }
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
 * Refresca la vista materializada de stats
 */
export async function refreshStats(): Promise<void> {
  if (!hasSupabaseAdminEnv) {
    return
  }

  await db.rpc('refresh_dashboard_stats')
}
