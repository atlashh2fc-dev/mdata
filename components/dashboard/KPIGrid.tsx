'use client'

import { formatNumber, formatCurrency, formatPercentage } from '@/lib/utils/formatters'
import type { DashboardStats } from '@/types'
import {
  Users, Mail, Phone, Car, Building2,
  Home, TrendingUp, Landmark, Activity, Database,
} from 'lucide-react'

interface KPIItem {
  label: string
  value: string | number
  sub?: string
  icon: React.ElementType
  color: string
  bg: string
}

function buildKPIs(stats: DashboardStats): KPIItem[] {
  const total = stats.total_ruts || 1
  return [
    {
      label: 'Total RUTs',
      value: formatNumber(stats.total_ruts),
      sub: 'Base consolidada',
      icon: Database,
      color: 'text-brand-400',
      bg: 'bg-brand-500/10',
    },
    {
      label: 'Con nombre',
      value: formatNumber(stats.con_nombre),
      sub: formatPercentage((stats.con_nombre / total) * 100),
      icon: Users,
      color: 'text-blue-400',
      bg: 'bg-blue-500/10',
    },
    {
      label: 'Con email',
      value: formatNumber(stats.con_email),
      sub: formatPercentage((stats.con_email / total) * 100),
      icon: Mail,
      color: 'text-green-400',
      bg: 'bg-green-500/10',
    },
    {
      label: 'Con teléfono',
      value: formatNumber(stats.con_fono),
      sub: formatPercentage((stats.con_fono / total) * 100),
      icon: Phone,
      color: 'text-cyan-400',
      bg: 'bg-cyan-500/10',
    },
    {
      label: 'Con autos',
      value: formatNumber(stats.con_autos),
      sub: `${formatNumber(stats.total_autos)} vehículos`,
      icon: Car,
      color: 'text-orange-400',
      bg: 'bg-orange-500/10',
    },
    {
      label: 'Con empresa',
      value: formatNumber(stats.con_empresa),
      sub: formatPercentage((stats.con_empresa / total) * 100),
      icon: Building2,
      color: 'text-purple-400',
      bg: 'bg-purple-500/10',
    },
    {
      label: 'Con domicilio',
      value: formatNumber(stats.con_domicilio),
      sub: formatPercentage((stats.con_domicilio / total) * 100),
      icon: Home,
      color: 'text-pink-400',
      bg: 'bg-pink-500/10',
    },
    {
      label: 'Propiedades cargadas',
      value: formatNumber(stats.total_propiedades_cargadas),
      sub: `${formatNumber(stats.con_bienes_raices)} RUTs · ${formatCurrency(stats.total_avaluos)}`,
      icon: Landmark,
      color: 'text-amber-400',
      bg: 'bg-amber-500/10',
    },
    {
      label: 'Jobs completados',
      value: formatNumber(stats.jobs_completados),
      sub: `${stats.jobs_fallidos} fallidos`,
      icon: Activity,
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10',
    },
    {
      label: 'Segmentos activos',
      value: formatNumber(stats.total_segmentos),
      sub: 'Segmentos creados',
      icon: TrendingUp,
      color: 'text-indigo-400',
      bg: 'bg-indigo-500/10',
    },
  ]
}

interface KPIGridProps {
  stats: DashboardStats
}

export function KPIGrid({ stats }: KPIGridProps) {
  const kpis = buildKPIs(stats)

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
      {kpis.map(kpi => {
        const Icon = kpi.icon
        return (
          <div key={kpi.label} className="stat-card animate-fade-in">
            <div className="flex items-start justify-between">
              <div className={`w-9 h-9 rounded-lg ${kpi.bg} flex items-center justify-center`}>
                <Icon className={`w-4 h-4 ${kpi.color}`} />
              </div>
            </div>
            <div>
              <p className="text-2xl font-bold text-white leading-none">{kpi.value}</p>
              <p className="text-xs text-slate-500 mt-1">{kpi.label}</p>
              {kpi.sub && (
                <p className="text-xs text-slate-600 mt-0.5">{kpi.sub}</p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
