'use client'

import { useState, useEffect, useMemo } from 'react'
import { Header } from '@/components/layout/Header'
import { LoadingState } from '@/components/ui/Spinner'
import {
  Dna,
  Users,
  Car,
  Home,
  Building2,
  Mail,
  Phone,
  Database,
  ShieldX,
  BriefcaseBusiness,
  TrendingUp,
  RefreshCcw,
  Download,
  Check,
  X,
  Minus,
  Info,
  SlidersHorizontal
} from 'lucide-react'
import { formatNumber } from '@/lib/utils/formatters'

interface UniverseRow {
  entidad_tipo: 'persona_natural' | 'persona_juridica' | 'indeterminado' | 'rut_recuperable' | 'basura'
  con_nombre: boolean
  con_email: boolean
  con_fono: boolean
  con_autos: boolean
  con_empresa: boolean
  con_domicilio: boolean
  con_bienes_raices: boolean
  dataset_flags?: Record<string, boolean>
  trabajadores_bucket?: string | null
  facturacion_bucket?: string | null
  tamano_empresa_bucket?: string | null
  tendencia_bucket?: string | null
  patrimonio_bucket?: string | null
  region_bucket?: string | null
  total: number
  refreshed_at?: string | null
}

interface UniverseDimension {
  key: string
  label: string
  description?: string | null
  source?: 'master' | 'dataset' | string
  slug?: string
  record_count?: number
  last_loaded_at?: string | null
}

type FilterState = true | false | null
type EntityFilter = 'todos' | UniverseRow['entidad_tipo']

type AdvancedFilters = {
  trabajadores_bucket: string
  facturacion_bucket: string
  tamano_empresa_bucket: string
  tendencia_bucket: string
  patrimonio_bucket: string
  region_bucket: string
}

type AdvancedFilterKey = keyof AdvancedFilters

const ANY_VALUE = '__any__'

const DEFAULT_ADVANCED_FILTERS: AdvancedFilters = {
  trabajadores_bucket: ANY_VALUE,
  facturacion_bucket: ANY_VALUE,
  tamano_empresa_bucket: ANY_VALUE,
  tendencia_bucket: ANY_VALUE,
  patrimonio_bucket: ANY_VALUE,
  region_bucket: ANY_VALUE,
}

const ADVANCED_FILTER_CONFIG: Array<{
  key: AdvancedFilterKey
  label: string
  description: string
}> = [
  { key: 'trabajadores_bucket', label: 'Trabajadores', description: 'Dotación 2024 agrupada para empresas' },
  { key: 'facturacion_bucket', label: 'Facturación', description: 'Tramos SII agrupados por nivel de ventas' },
  { key: 'tamano_empresa_bucket', label: 'Tamaño empresa', description: 'Micro, pequeña, mediana, grande o corporación' },
  { key: 'tendencia_bucket', label: 'Tendencia ventas', description: 'Sube, baja, estable o sin datos' },
  { key: 'patrimonio_bucket', label: 'Nivel patrimonial', description: 'Score patrimonial consolidado por rango' },
  { key: 'region_bucket', label: 'Región', description: 'Región consolidada del universo' },
]

const BUCKET_LABELS: Record<string, string> = {
  sin_datos: 'Sin datos',
  sin_segmento: 'Sin segmento',
  sin_region: 'Sin región',
  pyme_master_sin_tramo: 'PyME sin tramo',
  pequena: 'Pequeña',
  gran_empresa: 'Gran empresa',
  corporacion: 'Corporación',
  micro: 'Micro',
  mediana: 'Mediana',
  sube: 'Sube',
  baja: 'Baja',
  estable: 'Estable',
}

const FILTER_BUCKET_LABELS: Partial<Record<AdvancedFilterKey, Record<string, string>>> = {
  trabajadores_bucket: {
    '0': '0 trabajadores',
    '1-9': '1-9 trabajadores',
    '10-49': '10-49 trabajadores',
    '50-199': '50-199 trabajadores',
    '200-499': '200-499 trabajadores',
    '500+': '500+ trabajadores',
  },
  facturacion_bucket: {
    'T1-T5': 'T1-T5 · hasta 10k UF/año',
    'T6-T7': 'T6-T7 · 10k-50k UF/año',
    'T8-T9': 'T8-T9 · 50k-200k UF/año',
    'T10-T12': 'T10-T12 · 200k-1M UF/año',
    'T13+': 'T13+ · >1M UF/año',
  },
  patrimonio_bucket: {
    '0': '0 · sin avalúo',
    '1-20': '1-20 · bajo',
    '21-40': '21-40 · medio-bajo',
    '41-60': '41-60 · medio',
    '61-80': '61-80 · alto',
    '81+': '81+ · muy alto',
  },
}

const NON_ACTIONABLE_BUCKETS = new Set(['sin_datos', 'sin_segmento', 'sin_region'])

const ENTITY_GROUPS: Array<{
  key: EntityFilter
  label: string
  description: string
  tone: string
  border: string
  bg: string
}> = [
  { key: 'todos', label: 'Todos', description: 'Base consolidada completa', tone: 'text-foreground', border: 'border-border', bg: 'bg-surface-muted' },
  { key: 'persona_natural', label: 'Naturales', description: 'RUTs con nombre de persona', tone: 'text-primary-ink', border: 'border-primary/50', bg: 'bg-surface-muted' },
  { key: 'persona_juridica', label: 'Jurídicas', description: 'Empresas e instituciones', tone: 'text-violet', border: 'border-violet/50', bg: 'bg-violet-bg' },
  { key: 'indeterminado', label: 'Indeterminados', description: 'Canónicos sin nombre ni razón social', tone: 'text-warning', border: 'border-warning/50', bg: 'bg-warning-bg' },
  { key: 'rut_recuperable', label: 'Recuperables', description: 'RUTs útiles pero mal normalizados', tone: 'text-success', border: 'border-success/50', bg: 'bg-success-bg' },
  { key: 'basura', label: 'Basura', description: 'RUTs vacíos, cero o no recuperables', tone: 'text-danger', border: 'border-danger/50', bg: 'bg-danger-bg' },
]

const DEFAULT_DIMENSIONS: UniverseDimension[] = [
  { key: 'con_nombre', label: 'Nombre Completo', source: 'master' },
  { key: 'con_fono', label: 'Teléfono Celular', source: 'master' },
  { key: 'con_email', label: 'Correo Electrónico', source: 'master' },
  { key: 'con_domicilio', label: 'Domicilio Conocido', source: 'master' },
  { key: 'con_autos', label: 'Tiene Vehículos', source: 'master' },
  { key: 'con_bienes_raices', label: 'Bienes Raíces', source: 'master' },
  { key: 'con_empresa', label: 'Dueño de Empresa', source: 'master' },
]

// Render a compact boolean badge for the breakdown table
function BoolBadge({ val }: { val: boolean }) {
  return val
    ? <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-surface-muted text-primary-ink"><Check className="w-3 h-3" /></span>
    : <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-surface-muted text-muted-foreground"><X className="w-3 h-3" /></span>
}

const DIM_SHORT: Record<string, string> = {
  con_nombre: 'Nombre',
  con_fono: 'Fono',
  con_email: 'Email',
  con_domicilio: 'Domic.',
  con_autos: 'Autos',
  con_bienes_raices: 'B.Raíz',
  con_empresa: 'Empresa',
}

const DIM_STYLES = [
  { icon: Users, color: 'text-primary-ink', bg: 'bg-surface-muted', borderActive: 'border-primary', glowActive: 'shadow-elevation-1' },
  { icon: Phone, color: 'text-success', bg: 'bg-success-bg', borderActive: 'border-success', glowActive: 'shadow-elevation-1' },
  { icon: Mail, color: 'text-warning', bg: 'bg-warning-bg', borderActive: 'border-warning', glowActive: 'shadow-elevation-1' },
  { icon: Home, color: 'text-warning', bg: 'bg-warning-bg', borderActive: 'border-warning', glowActive: 'shadow-elevation-1' },
  { icon: Car, color: 'text-primary-ink', bg: 'bg-surface-muted', borderActive: 'border-primary', glowActive: 'shadow-elevation-1' },
  { icon: Building2, color: 'text-violet', bg: 'bg-violet-bg', borderActive: 'border-violet', glowActive: 'shadow-elevation-1' },
  { icon: Dna, color: 'text-violet', bg: 'bg-violet-bg', borderActive: 'border-violet', glowActive: 'shadow-elevation-1' },
  { icon: Database, color: 'text-teal-300', bg: 'bg-teal-400/10', borderActive: 'border-teal-300', glowActive: 'shadow-elevation-1' },
  { icon: ShieldX, color: 'text-danger', bg: 'bg-danger-bg', borderActive: 'border-danger', glowActive: 'shadow-elevation-1' },
  { icon: BriefcaseBusiness, color: 'text-primary-ink', bg: 'bg-surface-muted', borderActive: 'border-primary', glowActive: 'shadow-elevation-1' },
  { icon: TrendingUp, color: 'text-success', bg: 'bg-success-bg', borderActive: 'border-success', glowActive: 'shadow-elevation-1' },
]

function shortLabel(dim: UniverseDimension) {
  return DIM_SHORT[dim.key] ?? dim.label.split(/\s+/).slice(0, 2).join(' ')
}

function getDimensionStyle(index: number) {
  return DIM_STYLES[index % DIM_STYLES.length]
}

function getRowFlag(row: UniverseRow, key: string) {
  if (key in row) return Boolean(row[key as keyof UniverseRow])
  return Boolean(row.dataset_flags?.[key])
}

function getBucketLabel(value: string, key?: AdvancedFilterKey) {
  return FILTER_BUCKET_LABELS[key ?? 'trabajadores_bucket']?.[value] ?? BUCKET_LABELS[value] ?? value
}

function getAdvancedValue(row: UniverseRow, key: AdvancedFilterKey) {
  return row[key] ?? DEFAULT_ADVANCED_FILTERS[key]
}

function formatBucketOption(value: string, key?: AdvancedFilterKey) {
  return value === ANY_VALUE ? 'No filtrar' : getBucketLabel(value, key)
}

function sortBucketOptions(key: AdvancedFilterKey, values: string[]) {
  const order: Partial<Record<AdvancedFilterKey, string[]>> = {
    trabajadores_bucket: ['sin_datos', '0', '1-9', '10-49', '50-199', '200-499', '500+'],
    facturacion_bucket: ['sin_datos', 'T1-T5', 'T6-T7', 'T8-T9', 'T10-T12', 'T13+'],
    tamano_empresa_bucket: ['sin_segmento', 'pyme_master_sin_tramo', 'micro', 'pequena', 'mediana', 'gran_empresa', 'corporacion'],
    tendencia_bucket: ['sin_datos', 'sube', 'estable', 'baja'],
    patrimonio_bucket: ['sin_datos', '0', '1-20', '21-40', '41-60', '61-80', '81+'],
  }
  const preferred = order[key] ?? []
  return values.sort((a, b) => {
    const ai = preferred.indexOf(a)
    const bi = preferred.indexOf(b)
    if (ai >= 0 || bi >= 0) return (ai >= 0 ? ai : 999) - (bi >= 0 ? bi : 999)
    return getBucketLabel(a, key).localeCompare(getBucketLabel(b, key), 'es')
  })
}

function rowMatchesStaticFilters(row: UniverseRow, filters: Record<string, FilterState>, exceptKey?: string) {
  for (const [key, val] of Object.entries(filters)) {
    if (key === exceptKey) continue
    if (val !== null && getRowFlag(row, key) !== val) return false
  }
  return true
}

function rowMatchesAdvancedFilters(row: UniverseRow, advancedFilters: AdvancedFilters, exceptKey?: AdvancedFilterKey) {
  for (const config of ADVANCED_FILTER_CONFIG) {
    if (config.key === exceptKey) continue
    const selected = advancedFilters[config.key]
    if (selected !== ANY_VALUE && getAdvancedValue(row, config.key) !== selected) return false
  }
  return true
}

export default function UniversosPage() {
  const [data, setData] = useState<UniverseRow[]>([])
  const [dimensions, setDimensions] = useState<UniverseDimension[]>(DEFAULT_DIMENSIONS)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [entityFilter, setEntityFilter] = useState<EntityFilter>('persona_juridica')

  // Filters state (null = ANY, true = REQUIRED, false = EXCLUDED)
  const [filters, setFilters] = useState<Record<string, FilterState>>({})
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedFilters>(DEFAULT_ADVANCED_FILTERS)

  useEffect(() => {
    loadUniversos()
  }, [])

  async function loadUniversos() {
    setLoading(true)
    setExportError(null)
    try {
      const res = await fetch('/api/universos', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? 'No se pudo cargar el explorador de universos.')
      }
      setData(json.data || [])
      if (json.dimensions?.length) setDimensions(json.dimensions)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'No se pudo cargar el explorador de universos.')
    } finally {
      setLoading(false)
    }
  }

  async function refreshUniversos() {
    setRefreshing(true)
    setExportError(null)
    try {
      const res = await fetch('/api/universos', {
        method: 'POST',
        cache: 'no-store',
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? 'No se pudo actualizar la matriz.')
      }
      setData(json.data || [])
      if (json.dimensions?.length) setDimensions(json.dimensions)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'No se pudo actualizar la matriz.')
    } finally {
      setRefreshing(false)
    }
  }

  const entityTotals = useMemo(() => {
    const totals: Record<EntityFilter, number> = {
      todos: 0,
      persona_natural: 0,
      persona_juridica: 0,
      indeterminado: 0,
      rut_recuperable: 0,
      basura: 0,
    }

    for (const row of data) {
      totals.todos += row.total
      totals[row.entidad_tipo] += row.total
    }

    return totals
  }, [data])

  const scopedData = useMemo(() => {
    if (entityFilter === 'todos') return data
    return data.filter(row => row.entidad_tipo === entityFilter)
  }, [data, entityFilter])

  const advancedOptions = useMemo(() => {
    const options: Record<AdvancedFilterKey, string[]> = {
      trabajadores_bucket: [],
      facturacion_bucket: [],
      tamano_empresa_bucket: [],
      tendencia_bucket: [],
      patrimonio_bucket: [],
      region_bucket: [],
    }

    for (const config of ADVANCED_FILTER_CONFIG) {
      const values = new Set<string>()
      for (const row of scopedData) {
        if (!rowMatchesStaticFilters(row, filters)) continue
        if (!rowMatchesAdvancedFilters(row, advancedFilters, config.key)) continue
        const value = getAdvancedValue(row, config.key)
        if (value && value !== ANY_VALUE && !NON_ACTIONABLE_BUCKETS.has(value)) values.add(value)
      }
      options[config.key] = sortBucketOptions(config.key, [...values])
    }

    return options
  }, [advancedFilters, filters, scopedData])

  useEffect(() => {
    setAdvancedFilters(prev => {
      let changed = false
      const next = { ...prev }

      for (const config of ADVANCED_FILTER_CONFIG) {
        const selected = prev[config.key]
        if (selected !== ANY_VALUE && !advancedOptions[config.key].includes(selected)) {
          next[config.key] = ANY_VALUE
          changed = true
        }
      }

      return changed ? next : prev
    })
  }, [advancedOptions])

  // Grand total (all rows)
  const totalBase = useMemo(() => scopedData.reduce((acc, row) => acc + row.total, 0), [scopedData])

  // Individual total per dimension (con_X = true, independiente de otros filtros)
  const dimTotals = useMemo(() => {
    const out: Record<string, number> = {}
    for (const dim of dimensions) {
      if (entityFilter === 'todos' && dim.source === 'dataset' && typeof dim.record_count === 'number') {
        out[dim.key] = dim.record_count
      } else {
        out[dim.key] = scopedData
          .filter(r => rowMatchesStaticFilters(r, filters, dim.key))
          .filter(r => rowMatchesAdvancedFilters(r, advancedFilters))
          .filter(r => getRowFlag(r, dim.key))
          .reduce((s, r) => s + r.total, 0)
      }
    }
    return out
  }, [advancedFilters, dimensions, filters, scopedData, entityFilter])

  // Calculamos el volumen instantáneamente cruzando la matriz precomputada
  const result = useMemo(() => {
    let count = 0
    const matchingRows: UniverseRow[] = []

    for (const row of scopedData) {
      const isMatch = rowMatchesStaticFilters(row, filters) && rowMatchesAdvancedFilters(row, advancedFilters)
      if (isMatch) {
        count += row.total
        matchingRows.push(row)
      }
    }
    // Sort by total desc
    matchingRows.sort((a, b) => b.total - a.total)
    return { count, matchingRows }
  }, [advancedFilters, filters, scopedData])

  const pct = totalBase > 0 ? (result.count / totalBase) * 100 : 0

  const toggleFilter = (key: string) => {
    setFilters(prev => {
      const current = prev[key]
      // Cycle: null -> true -> false -> null
      let next: FilterState = null
      if (current === null) next = true
      else if (current === true) next = false

      return { ...prev, [key]: next }
    })
  }

  const resetFilters = () => {
    setFilters({})
    setAdvancedFilters(DEFAULT_ADVANCED_FILTERS)
  }

  const setAdvancedFilter = (key: AdvancedFilterKey, value: string) => {
    setAdvancedFilters(prev => ({ ...prev, [key]: value }))
  }

  const applyContactableCompaniesPreset = () => {
    setEntityFilter('persona_juridica')
    setFilters(prev => ({ ...prev, con_fono: true, con_empresa: true }))
  }

  const applyMipymePreset = () => {
    setEntityFilter('persona_juridica')
    setFilters(prev => ({ ...prev, con_fono: true, con_empresa: true }))
    setAdvancedFilters(prev => ({
      ...prev,
      trabajadores_bucket: '10-49',
      facturacion_bucket: 'T6-T7',
    }))
  }

  const applyGrowthPreset = () => {
    setEntityFilter('persona_juridica')
    setFilters(prev => ({ ...prev, con_fono: true, con_empresa: true }))
    setAdvancedFilters(prev => ({
      ...prev,
      tendencia_bucket: 'sube',
    }))
  }

  const applyHighPatrimonyPreset = () => {
    setFilters(prev => ({ ...prev, con_fono: true, con_bienes_raices: true }))
    setAdvancedFilters(prev => ({
      ...prev,
      patrimonio_bucket: '81+',
    }))
  }

  async function exportCurrentSegment() {
    if (totalActiveCount === 0 || exporting) return

    setExporting(true)
    setExportError(null)

    try {
      const res = await fetch('/api/universos/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityFilter, filters, advancedFilters }),
      })

      if (!res.ok) {
        const json = await res.json().catch(() => null)
        throw new Error(json?.error ?? 'No se pudo exportar este segmento.')
      }

      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? 'universo-segmento.csv'
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'No se pudo exportar este segmento.')
    } finally {
      setExporting(false)
    }
  }

  // Active filters count
  const activeCount = Object.values(filters).filter(v => v !== null).length
  const activeAdvancedFilters = Object.entries(advancedFilters).filter(([, value]) => value !== ANY_VALUE) as Array<[AdvancedFilterKey, string]>
  const totalActiveCount = activeCount + activeAdvancedFilters.length
  const activeFilters = Object.entries(filters).filter(([, v]) => v !== null)
  const datasetDimensionCount = dimensions.filter(dim => dim.source === 'dataset').length

  return (
    <>
      <Header
        title="Explorador de Universos"
        subtitle="Matriz combinatoria — cruce de volúmenes en tiempo real"
      />

      <div className="p-6 flex flex-col xl:flex-row gap-6 overflow-x-hidden" style={{ minHeight: 'calc(100vh - 5rem)' }}>

        {/* COLUMNA IZQUIERDA: CONTROLES */}
        <div className="min-w-0 flex-1 flex flex-col gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">Dimensiones de Datos</h3>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Primero elige el universo base; luego incluye ✓ o excluye ✗ cada dimensión
                {datasetDimensionCount > 0 ? ` · ${datasetDimensionCount} filtros sincronizados desde datasets` : ''}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
              <button
                onClick={refreshUniversos}
                disabled={refreshing}
                className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-muted hover:bg-surface-muted text-primary-ink disabled:opacity-60 disabled:cursor-wait transition-all"
              >
                <RefreshCcw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
                {refreshing ? 'Actualizando' : 'Actualizar matriz'}
              </button>
              <button onClick={resetFilters} className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-muted hover:bg-surface-muted text-muted-foreground hover:text-foreground transition-all">
                <RefreshCcw className="w-3 h-3" />
                Restablecer
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6 gap-3">
            {ENTITY_GROUPS.map(group => {
              const isActive = entityFilter === group.key
              const total = entityTotals[group.key]
              return (
                <button
                  key={group.key}
                  onClick={() => setEntityFilter(group.key)}
                  className={`min-w-0 rounded-xl border p-4 text-left transition-all ${isActive ? `${group.border} ${group.bg} shadow-elevation-1` : 'border-border bg-surface hover:bg-surface'}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className={`text-sm font-semibold ${isActive ? group.tone : 'text-foreground'}`}>{group.label}</h4>
                      <p className="mt-1 text-[10px] text-muted-foreground leading-relaxed">{group.description}</p>
                    </div>
                    {isActive && <Check className={`w-4 h-4 ${group.tone}`} />}
                  </div>
                  <div className="mt-4 text-xl font-semibold text-foreground">{formatNumber(total)}</div>
                  <div className="text-[10px] text-muted-foreground mt-1">registros en este universo</div>
                </button>
              )
            })}
          </div>

          <div className="overflow-hidden rounded-2xl border border-border bg-surface p-4 shadow-elevation-1">
            <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <SlidersHorizontal className="h-4 w-4 text-primary-ink" />
                  <h3 className="text-sm font-semibold text-foreground">Filtros comerciales avanzados</h3>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Segmenta empresas y personas por dotación, facturación, tendencia, patrimonio y territorio sin recalcular la base completa.
                </p>
              </div>
              <div className="flex max-w-full flex-wrap gap-2 lg:max-w-[460px] lg:justify-end">
                <button
                  type="button"
                  onClick={applyContactableCompaniesPreset}
                  className="rounded-lg border border-primary/30 bg-surface-muted px-3 py-2 text-xs font-medium text-primary-ink transition hover:border-primary/60"
                >
                  Empresas contactables
                </button>
                <button
                  type="button"
                  onClick={applyMipymePreset}
                  className="rounded-lg border border-success/30 bg-success-bg px-3 py-2 text-xs font-medium text-success transition hover:border-success/60"
                >
                  MiPYME rápida
                </button>
                <button
                  type="button"
                  onClick={applyGrowthPreset}
                  className="rounded-lg border border-success/30 bg-success-bg px-3 py-2 text-xs font-medium text-success transition hover:border-success/60"
                >
                  Creciendo
                </button>
                <button
                  type="button"
                  onClick={applyHighPatrimonyPreset}
                  className="rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 text-xs font-medium text-warning transition hover:border-warning/60"
                >
                  Alto patrimonio
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
              {ADVANCED_FILTER_CONFIG.map(config => {
                const options = advancedOptions[config.key]
                const selected = advancedFilters[config.key]
                return (
                  <div key={config.key} className="min-w-0 overflow-hidden rounded-xl border border-border bg-background p-3">
                    <label className="mb-1 block text-xs font-semibold text-foreground">{config.label}</label>
                    <p className="mb-2 min-h-[28px] text-[10px] leading-relaxed text-muted-foreground">{config.description}</p>
                    <select
                      value={selected}
                      onChange={event => setAdvancedFilter(config.key, event.target.value)}
                      className="input-base h-9 w-full min-w-0 max-w-full truncate py-1.5 text-xs"
                    >
                      <option value={ANY_VALUE}>No filtrar</option>
                      {options.map(option => (
                        <option key={option} value={option}>
                          {formatBucketOption(option, config.key)}
                        </option>
                      ))}
                    </select>
                    {options.length === 0 && (
                      <p className="mt-2 text-[10px] text-warning">
                        Sin valores comerciales cargados. Usa Actualizar matriz.
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
             {dimensions.map((dim, index) => {
               const state = filters[dim.key]
               const dimStyle = getDimensionStyle(index)
               const Icon = dimStyle.icon
               const dimTotal = dimTotals[dim.key] || 0
               const dimPct = totalBase > 0 ? (dimTotal / totalBase) * 100 : 0

               let stateClass = "border-border bg-surface"
               let StateIcon = Minus
               let stateColor = "text-muted-foreground"
               let stateLabel = 'Cualquiera'

               if (state === true) {
                 stateClass = `${dimStyle.borderActive} border bg-surface ${dimStyle.glowActive}`
                 StateIcon = Check
                 stateColor = dimStyle.color
                 stateLabel = 'Requerido'
               } else if (state === false) {
                 stateClass = "border-danger/40 bg-danger-bg"
                 StateIcon = X
                 stateColor = "text-danger"
                 stateLabel = 'Excluido'
               }

               return (
                 <button
                    key={dim.key}
                    onClick={() => toggleFilter(dim.key)}
                    className={`min-w-0 p-4 rounded-xl border transition-all duration-200 text-left flex flex-col gap-3 ${stateClass}`}
                 >
                   <div className="flex items-start justify-between w-full">
                     <div className="min-w-0 flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${dimStyle.bg}`}>
                          <Icon className={`w-4.5 h-4.5 ${dimStyle.color}`} />
                        </div>
                        <div className="min-w-0">
                          <h4 className="text-sm font-semibold text-foreground leading-tight">{dim.label}</h4>
                          <p className={`text-[10px] mt-0.5 uppercase tracking-wider font-medium ${stateColor}`}>
                            {stateLabel}{dim.source === 'dataset' ? ' · Dataset' : ''}
                          </p>
                        </div>
                     </div>
                     <div className={`w-5 h-5 rounded-full flex items-center justify-center bg-black/20 border border-border flex-shrink-0 ${stateColor}`}>
                       <StateIcon className="w-3 h-3" />
                     </div>
                   </div>

                   {/* Individual total + mini progress bar */}
                   <div className="w-full">
                     <div className="flex items-center justify-between mb-1">
                       <span className="text-[10px] text-muted-foreground">Universo propio</span>
                       <span className={`text-[11px] font-mono font-semibold ${dimStyle.color}`}>
                         {loading ? '…' : formatNumber(dimTotal)} ({dimPct.toFixed(1)}%)
                       </span>
                     </div>
                     <div className="w-full h-1 bg-surface-muted rounded-full overflow-hidden">
                       <div
                         className={`h-full rounded-full transition-all duration-500 ${dimStyle.bg.replace('/10', '/60')}`}
                         style={{ width: `${Math.min(dimPct, 100)}%` }}
                       />
                     </div>
                   </div>
                 </button>
               )
             })}
          </div>

          {/* TABLA DE DESGLOSE — muestra exactamente qué filas se están sumando */}
          {!loading && totalActiveCount > 0 && (
            <div className="mt-2">
              <div className="flex items-center gap-2 mb-2">
                <Info className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-[11px] text-muted-foreground">
                  {result.matchingRows.length} combinación{result.matchingRows.length !== 1 ? 'es' : ''} que componen el resultado
                </span>
              </div>
              <div className="rounded-xl border border-border overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-surface-muted border-b border-border">
                        {dimensions.map(d => (
                          <th key={d.key} className="px-2 py-2 text-center text-[10px] font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                            {shortLabel(d)}
                          </th>
                        ))}
                        {ADVANCED_FILTER_CONFIG.map(config => (
                          <th key={config.key} className="px-2 py-2 text-left text-[10px] font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                            {config.label}
                          </th>
                        ))}
                        <th className="px-3 py-2 text-right text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Registros</th>
                        <th className="px-3 py-2 text-right text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.matchingRows.map((row, i) => (
                        <tr
                          key={i}
                          className={`border-b border-border ${i % 2 === 0 ? 'bg-surface' : 'bg-transparent'} hover:bg-surface-muted transition-colors`}
                        >
                          {dimensions.map(d => (
                            <td key={d.key} className="px-2 py-2 text-center">
                              <BoolBadge val={getRowFlag(row, d.key)} />
                            </td>
                          ))}
                          {ADVANCED_FILTER_CONFIG.map(config => (
                            <td key={config.key} className="px-2 py-2 text-left text-[10px] text-muted-foreground whitespace-nowrap">
                              {formatBucketOption(getAdvancedValue(row, config.key), config.key)}
                            </td>
                          ))}
                          <td className="px-3 py-2 text-right font-mono font-semibold text-foreground">
                            {formatNumber(row.total)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-muted-foreground text-[10px]">
                            {totalBase > 0 ? (row.total / totalBase * 100).toFixed(2) : '0'}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-surface-muted border-t border-border">
                        <td colSpan={dimensions.length + ADVANCED_FILTER_CONFIG.length} className="px-3 py-2 text-right text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
                          Total
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-bold text-primary-ink">
                          {formatNumber(result.count)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-primary-ink text-[10px]">
                          {pct.toFixed(2)}%
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* COLUMNA DERECHA: RESULTADO EN VIVO */}
        <div className="min-w-0 flex flex-col gap-4 xl:w-[400px] xl:min-w-[360px]">
          <div className="glass-panel flex flex-col justify-center items-center text-center p-8 relative overflow-hidden" style={{ minHeight: 320 }}>

             {/* Background glow animated */}
             <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-surface-muted rounded-full blur-[80px] animate-pulse-slow pointer-events-none" />

             {loading ? (
               <LoadingState text="Cargando matriz…" />
             ) : (
               <>
                 <h2 className="text-base font-bold text-foreground mb-1">Universo Resultante</h2>
                 <p className="text-[10px] text-muted-foreground mb-6">
                   {ENTITY_GROUPS.find(group => group.key === entityFilter)?.label ?? 'Todos'} · {totalActiveCount === 0 ? 'sin filtros adicionales' : `${totalActiveCount} filtro${totalActiveCount > 1 ? 's' : ''} activo${totalActiveCount > 1 ? 's' : ''}`}
                 </p>

                 <div className="my-4">
                   <div className="text-5xl font-semibold text-foreground tracking-tight">
                     {formatNumber(result.count)}
                   </div>
                   <p className="text-sm text-primary-ink font-medium mt-3 bg-surface-muted inline-flex px-4 py-1 rounded-full border border-primary/20">
                    {pct.toFixed(2)}% del total
                   </p>
                 </div>

                 {/* Filtros activos */}
                 {totalActiveCount > 0 && (
                   <div className="w-full bg-surface-muted rounded-xl p-3 mt-4 border border-border text-left">
                     <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">Filtros aplicados</p>
                     <div className="flex flex-wrap gap-1.5">
                       {activeFilters.map(([key, val]) => {
                         const dim = dimensions.find(d => d.key === key)
                         const dimIndex = dimensions.findIndex(d => d.key === key)
                         const dimStyle = getDimensionStyle(dimIndex >= 0 ? dimIndex : 0)
                         return (
                           <span
                             key={key}
                             className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${val === true ? `${dimStyle.color} border-current bg-current/10` : 'text-danger border-danger/40 bg-danger-bg'}`}
                           >
                             {val === true ? <Check className="w-2.5 h-2.5" /> : <X className="w-2.5 h-2.5" />}
                             {dim ? shortLabel(dim) : key}
                           </span>
                         )
                       })}
                       {activeAdvancedFilters.map(([key, value]) => {
                         const config = ADVANCED_FILTER_CONFIG.find(item => item.key === key)
                         return (
                           <span
                             key={key}
                             className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border border-primary/40 bg-surface-muted text-primary-ink"
                           >
                             <SlidersHorizontal className="w-2.5 h-2.5" />
                             {config?.label ?? key}: {formatBucketOption(value, key)}
                           </span>
                         )
                       })}
                     </div>
                   </div>
                 )}

                 <div className="w-full bg-surface-muted rounded-xl p-3 mt-3 border border-border">
                   <div className="flex justify-between items-center text-xs text-muted-foreground mb-1.5">
                     <span>Combinaciones sumadas:</span>
                     <span className="font-mono text-primary-ink">{result.matchingRows.length} de {scopedData.length}</span>
                   </div>
                   <div className="flex justify-between items-center text-xs text-muted-foreground">
                     <span>Base total:</span>
                     <span className="font-mono text-foreground">{formatNumber(totalBase)}</span>
                   </div>
                 </div>

                 <button
                  type="button"
                  onClick={exportCurrentSegment}
                  disabled={totalActiveCount === 0 || exporting}
                  className={`mt-4 w-full py-3 rounded-lg font-bold text-sm transition-all inline-flex items-center justify-center gap-2 ${totalActiveCount > 0 ? 'bg-primary hover:bg-primary-hover text-primary-foreground shadow-lg shadow-elevation-1 disabled:opacity-60 disabled:cursor-wait' : 'bg-surface-muted text-muted-foreground cursor-not-allowed'}`}
                 >
                    <Download className="w-4 h-4" />
                    {exporting ? 'Exportando...' : totalActiveCount > 0 ? 'Exportar este segmento exacto' : 'Aplica filtros para exportar'}
                 </button>
                 {exportError && (
                  <p className="mt-2 text-xs text-danger bg-danger-bg border border-danger/20 rounded-lg px-3 py-2">
                    {exportError}
                  </p>
                 )}
               </>
             )}
          </div>

          {/* Info de contexto */}
          {!loading && (
            <div className="glass-panel p-4 text-xs text-muted-foreground space-y-2">
              <p className="font-semibold text-foreground text-[11px] uppercase tracking-wider">Cómo funciona</p>
              <p>Primero eliges el <span className="text-foreground">tipo de entidad</span>: naturales, jurídicas, indeterminados, recuperables o basura. Luego cada dimensión muestra su universo propio dentro de ese grupo.</p>
              <p>Al combinar dos dimensiones, el resultado es la <span className="text-primary-ink">intersección</span> (personas que tienen ambas), por lo que el número puede bajar respecto a cada dimensión individual.</p>
              <p className="text-muted-foreground">Base activa: <span className="font-mono text-foreground">{formatNumber(totalBase)}</span> registros en {scopedData.length} combinaciones únicas.</p>
              {datasetDimensionCount > 0 && (
                <p className="text-muted-foreground">Datasets sincronizados como filtros: <span className="font-mono text-foreground">{datasetDimensionCount}</span>.</p>
              )}
            </div>
          )}
        </div>

      </div>
    </>
  )
}
