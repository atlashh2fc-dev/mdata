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

function PropertyUniverseCard({ stats }: { stats: DashboardStats }) {
  const totalRutOwners = stats.con_bienes_raices || 1
  const totalProperties = stats.total_propiedades_cargadas || 1
  const rows = [
    {
      label: 'Residencial',
      ruts: stats.bbrr_ruts_residencial,
      properties: stats.bbrr_propiedades_residenciales,
      color: 'text-success',
      bar: 'bg-success',
    },
    {
      label: 'Comercial',
      ruts: stats.bbrr_ruts_comercial + stats.bbrr_ruts_mixto,
      properties: stats.bbrr_propiedades_comerciales,
      color: 'text-primary-ink',
      bar: 'bg-primary',
    },
    {
      label: 'Mixto',
      ruts: stats.bbrr_ruts_mixto,
      properties: 0,
      color: 'text-violet',
      bar: 'bg-violet',
    },
    {
      label: 'Rural',
      ruts: stats.bbrr_ruts_rural,
      properties: stats.bbrr_propiedades_rurales,
      color: 'text-success',
      bar: 'bg-success',
    },
    {
      label: 'Especial',
      ruts: stats.bbrr_ruts_especial,
      properties: stats.bbrr_propiedades_especiales,
      color: 'text-foreground',
      bar: 'bg-surface-muted',
    },
  ]

  const commercialRutPct = ((stats.bbrr_ruts_comercial + stats.bbrr_ruts_mixto) / totalRutOwners) * 100
  const residentialRutPct = (stats.bbrr_ruts_residencial / totalRutOwners) * 100

  return (
    <div className="stat-card animate-fade-in col-span-2 lg:col-span-3 xl:col-span-3 min-h-[194px]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-warning-bg flex items-center justify-center shrink-0">
            <Landmark className="w-5 h-5 text-warning" />
          </div>
          <div className="min-w-0">
            <p className="text-3xl font-bold text-foreground leading-none">
              {formatNumber(stats.total_propiedades_cargadas)}
            </p>
            <p className="text-sm text-muted-foreground mt-1">Propiedades cargadas</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {formatNumber(stats.con_bienes_raices)} RUTs propietarios
            </p>
          </div>
        </div>

        <div className="text-right shrink-0">
          <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Avalúo fiscal</p>
          <p className="text-sm font-semibold text-foreground">{formatCurrency(stats.total_avaluos)}</p>
          <p className="text-[11px] text-muted-foreground mt-1">
            Com. {commercialRutPct.toFixed(1)}% · Res. {residentialRutPct.toFixed(1)}%
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="rounded-lg border border-border bg-background px-3 py-2">
          <p className="text-[11px] text-muted-foreground">Residenciales</p>
          <p className="text-sm font-semibold text-success">{formatNumber(stats.bbrr_propiedades_residenciales)}</p>
        </div>
        <div className="rounded-lg border border-border bg-background px-3 py-2">
          <p className="text-[11px] text-muted-foreground">Comerciales</p>
          <p className="text-sm font-semibold text-primary-ink">{formatNumber(stats.bbrr_propiedades_comerciales)}</p>
        </div>
        <div className="rounded-lg border border-border bg-background px-3 py-2">
          <p className="text-[11px] text-muted-foreground">Rurales</p>
          <p className="text-sm font-semibold text-success">{formatNumber(stats.bbrr_propiedades_rurales)}</p>
        </div>
        <div className="rounded-lg border border-border bg-background px-3 py-2">
          <p className="text-[11px] text-muted-foreground">Especiales</p>
          <p className="text-sm font-semibold text-foreground">{formatNumber(stats.bbrr_propiedades_especiales)}</p>
        </div>
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        {rows.map(row => {
          const rutPct = totalRutOwners > 0 ? (row.ruts / totalRutOwners) * 100 : 0
          const propertyPct = row.properties > 0 && totalProperties > 0 ? (row.properties / totalProperties) * 100 : 0

          return (
            <div key={row.label} className="grid grid-cols-[88px_1fr_auto] items-center gap-3">
              <span className={`text-xs font-medium ${row.color}`}>{row.label}</span>
              <div className="h-2 rounded-full bg-surface-muted overflow-hidden">
                <div
                  className={`h-full rounded-full ${row.bar}`}
                  style={{ width: `${Math.min(Math.max(rutPct, 1), 100)}%` }}
                />
              </div>
              <div className="min-w-[170px] text-right text-[11px] text-muted-foreground">
                <span className="text-foreground">{formatNumber(row.ruts)}</span> RUTs
                {row.properties > 0 && (
                  <span> · {formatNumber(row.properties)} props.</span>
                )}
                {row.properties > 0 && (
                  <span className="text-muted-foreground"> · {propertyPct.toFixed(1)}%</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function buildKPIs(stats: DashboardStats): KPIItem[] {
  const total = stats.total_ruts || 1
  return [
    {
      label: 'Total RUTs',
      value: formatNumber(stats.total_ruts),
      sub: 'Base consolidada',
      icon: Database,
      color: 'text-primary-ink',
      bg: 'bg-surface-muted',
    },
    {
      label: 'Con nombre',
      value: formatNumber(stats.con_nombre),
      sub: formatPercentage((stats.con_nombre / total) * 100),
      icon: Users,
      color: 'text-primary-ink',
      bg: 'bg-surface-muted',
    },
    {
      label: 'Con email',
      value: formatNumber(stats.con_email),
      sub: formatPercentage((stats.con_email / total) * 100),
      icon: Mail,
      color: 'text-success',
      bg: 'bg-success-bg',
    },
    {
      label: 'Con teléfono',
      value: formatNumber(stats.con_fono),
      sub: formatPercentage((stats.con_fono / total) * 100),
      icon: Phone,
      color: 'text-primary-ink',
      bg: 'bg-surface-muted',
    },
    {
      label: 'Con autos',
      value: formatNumber(stats.con_autos),
      sub: `${formatNumber(stats.total_autos)} vehículos`,
      icon: Car,
      color: 'text-warning',
      bg: 'bg-warning-bg',
    },
    {
      label: 'Con domicilio',
      value: formatNumber(stats.con_domicilio),
      sub: formatPercentage((stats.con_domicilio / total) * 100),
      icon: Home,
      color: 'text-violet',
      bg: 'bg-violet-bg',
    },
    {
      label: 'Jobs completados',
      value: formatNumber(stats.jobs_completados),
      sub: `${stats.jobs_fallidos} fallidos`,
      icon: Activity,
      color: 'text-success',
      bg: 'bg-success-bg',
    },
    {
      label: 'Segmentos activos',
      value: formatNumber(stats.total_segmentos),
      sub: 'Segmentos creados',
      icon: TrendingUp,
      color: 'text-violet',
      bg: 'bg-violet-bg',
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
    {
      label: 'Micro',
      value: stats.empresas_segmento_micro,
      sube: stats.empresas_segmento_micro_sube,
      baja: stats.empresas_segmento_micro_baja,
    },
    {
      label: 'Pequeña',
      value: stats.empresas_segmento_pequena,
      sube: stats.empresas_segmento_pequena_sube,
      baja: stats.empresas_segmento_pequena_baja,
    },
    {
      label: 'Mediana',
      value: stats.empresas_segmento_mediana,
      sube: stats.empresas_segmento_mediana_sube,
      baja: stats.empresas_segmento_mediana_baja,
    },
    {
      label: 'Grande',
      value: stats.empresas_segmento_gran_empresa,
      sube: stats.empresas_segmento_gran_empresa_sube,
      baja: stats.empresas_segmento_gran_empresa_baja,
    },
    {
      label: 'Corp.',
      value: stats.empresas_segmento_corporacion,
      sube: stats.empresas_segmento_corporacion_sube,
      baja: stats.empresas_segmento_corporacion_baja,
    },
    {
      label: 'Sin tramo',
      value: stats.empresas_segmento_pyme_master_sin_tramo,
      sube: stats.empresas_segmento_pyme_master_sin_tramo_sube,
      baja: stats.empresas_segmento_pyme_master_sin_tramo_baja,
    },
  ]

  return (
    <div className="stat-card animate-fade-in col-span-2 lg:col-span-3 xl:col-span-2 min-h-[194px]">
      <div className="flex items-start justify-between gap-3">
        <div className="w-10 h-10 rounded-lg bg-violet-bg flex items-center justify-center shrink-0">
          <Building2 className="w-5 h-5 text-violet" />
        </div>
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Poblado</p>
          <p className="text-sm font-semibold text-foreground">{populatedPct}</p>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-3xl font-bold text-foreground leading-none">
            {formatNumber(stats.empresas_universo_total)}
          </p>
          <p className="text-sm text-muted-foreground mt-1">Universo empresas activas</p>
          <p className="text-xs text-muted-foreground mt-0.5">SII 2024 sin termino de giro</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Sube {formatNumber(stats.empresas_tendencia_sube)} · Baja {formatNumber(stats.empresas_tendencia_baja)}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            PyME {formatNumber(stats.empresas_pyme)} · Grandes {formatNumber(stats.empresas_grandes)} · Corp. {formatNumber(stats.empresas_corporacion)}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-x-4 gap-y-2">
          {sizeSegments.map(segment => (
            <div key={segment.label} className="min-w-0">
              <p className="text-[11px] text-muted-foreground truncate">{segment.label}</p>
              <p className="text-sm font-semibold text-foreground leading-tight">{formatNumber(segment.value)}</p>
              <p className="text-[11px] leading-tight text-muted-foreground">
                <span className="text-success">Sube {formatNumber(segment.sube)}</span>
                <span className="text-muted-foreground"> · </span>
                <span className="text-danger">Baja {formatNumber(segment.baja)}</span>
              </p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-2 border-t border-border pt-3">
          <div className="min-w-0">
            <p className="text-[11px] text-muted-foreground">Región</p>
            <p className="text-xs font-semibold text-foreground">{formatNumber(stats.empresas_con_region)}</p>
          </div>
          <div className="min-w-0">
            <p className="text-[11px] text-muted-foreground">Comuna</p>
            <p className="text-xs font-semibold text-foreground">{formatNumber(stats.empresas_con_comuna)}</p>
          </div>
          <div className="min-w-0">
            <p className="text-[11px] text-muted-foreground flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              Dirección
            </p>
            <p className="text-xs font-semibold text-foreground">{formatNumber(stats.empresas_con_direccion)}</p>
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
      <PropertyUniverseCard stats={stats} />
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
              <p className="text-2xl font-bold text-foreground leading-none">{kpi.value}</p>
              <p className="text-xs text-muted-foreground mt-1">{kpi.label}</p>
              {kpi.sub && (
                <p className="text-xs text-muted-foreground mt-0.5">{kpi.sub}</p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
