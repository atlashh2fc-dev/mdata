'use client'

import { formatNumber, formatCurrency, formatPercentage } from '@/lib/utils/formatters'
import type { DashboardStats } from '@/types'
import {
  Users, Mail, Phone, Car, Building2,
  Home, TrendingUp, Landmark, Activity, Database, MapPin,
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

function CompanyUniverseCard({ stats }: { stats: DashboardStats }) {
  const total = stats.empresas_universo_total || 1
  const populatedCount = Math.max(
    stats.empresas_con_region,
    stats.empresas_con_comuna,
    stats.empresas_con_direccion
  )
  const populatedPct = formatPercentage((populatedCount / total) * 100)

  const sizeSegments = [
    { label: 'Micro', value: stats.empresas_segmento_micro },
    { label: 'Pequeña', value: stats.empresas_segmento_pequena },
    { label: 'Mediana', value: stats.empresas_segmento_mediana },
    { label: 'Grande', value: stats.empresas_segmento_gran_empresa },
    { label: 'Corp.', value: stats.empresas_segmento_corporacion },
    { label: 'PyME s/tramo', value: stats.empresas_segmento_pyme_master_sin_tramo },
  ]

  return (
    <div className="stat-card animate-fade-in col-span-2 lg:col-span-3 xl:col-span-2 min-h-[194px]">
      <div className="flex items-start justify-between gap-3">
        <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center shrink-0">
          <Building2 className="w-5 h-5 text-purple-300" />
        </div>
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Poblado</p>
          <p className="text-sm font-semibold text-white">{populatedPct}</p>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-3xl font-bold text-white leading-none">
            {formatNumber(stats.empresas_universo_total)}
          </p>
          <p className="text-sm text-slate-400 mt-1">Universo empresas</p>
          <p className="text-xs text-slate-600 mt-0.5">
            PyME {formatNumber(stats.empresas_pyme)} · Grandes {formatNumber(stats.empresas_grandes)} · Corp. {formatNumber(stats.empresas_corporacion)}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-x-4 gap-y-2">
          {sizeSegments.map(segment => (
            <div key={segment.label} className="min-w-0">
              <p className="text-[11px] text-slate-500 truncate">{segment.label}</p>
              <p className="text-sm font-semibold text-slate-100 leading-tight">{formatNumber(segment.value)}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-2 border-t border-slate-700/60 pt-3">
          <div className="min-w-0">
            <p className="text-[11px] text-slate-500">Región</p>
            <p className="text-xs font-semibold text-slate-100">{formatNumber(stats.empresas_con_region)}</p>
          </div>
          <div className="min-w-0">
            <p className="text-[11px] text-slate-500">Comuna</p>
            <p className="text-xs font-semibold text-slate-100">{formatNumber(stats.empresas_con_comuna)}</p>
          </div>
          <div className="min-w-0">
            <p className="text-[11px] text-slate-500 flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              Dirección
            </p>
            <p className="text-xs font-semibold text-slate-100">{formatNumber(stats.empresas_con_direccion)}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

interface KPIGridProps {
  stats: DashboardStats
}

export function KPIGrid({ stats }: KPIGridProps) {
  const kpis = buildKPIs(stats)

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
      <CompanyUniverseCard stats={stats} />
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
