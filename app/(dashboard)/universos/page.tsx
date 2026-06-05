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
  Info
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

const ENTITY_GROUPS: Array<{
  key: EntityFilter
  label: string
  description: string
  tone: string
  border: string
  bg: string
}> = [
  { key: 'todos', label: 'Todos', description: 'Base consolidada completa', tone: 'text-slate-300', border: 'border-slate-600/60', bg: 'bg-slate-800/70' },
  { key: 'persona_natural', label: 'Naturales', description: 'RUTs con nombre de persona', tone: 'text-cyan-300', border: 'border-cyan-500/50', bg: 'bg-cyan-500/10' },
  { key: 'persona_juridica', label: 'Jurídicas', description: 'Empresas e instituciones', tone: 'text-violet-300', border: 'border-violet-500/50', bg: 'bg-violet-500/10' },
  { key: 'indeterminado', label: 'Indeterminados', description: 'Canónicos sin nombre ni razón social', tone: 'text-amber-300', border: 'border-amber-500/50', bg: 'bg-amber-500/10' },
  { key: 'rut_recuperable', label: 'Recuperables', description: 'RUTs útiles pero mal normalizados', tone: 'text-emerald-300', border: 'border-emerald-500/50', bg: 'bg-emerald-500/10' },
  { key: 'basura', label: 'Basura', description: 'RUTs vacíos, cero o no recuperables', tone: 'text-rose-300', border: 'border-rose-500/50', bg: 'bg-rose-500/10' },
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
    ? <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-400"><Check className="w-3 h-3" /></span>
    : <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-slate-700/50 text-slate-600"><X className="w-3 h-3" /></span>
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
  { icon: Users, color: 'text-blue-400', bg: 'bg-blue-400/10', borderActive: 'border-blue-400', glowActive: 'shadow-[0_0_18px_rgba(96,165,250,0.15)]' },
  { icon: Phone, color: 'text-green-400', bg: 'bg-green-400/10', borderActive: 'border-green-400', glowActive: 'shadow-[0_0_18px_rgba(74,222,128,0.15)]' },
  { icon: Mail, color: 'text-yellow-400', bg: 'bg-yellow-400/10', borderActive: 'border-yellow-400', glowActive: 'shadow-[0_0_18px_rgba(250,204,21,0.15)]' },
  { icon: Home, color: 'text-orange-400', bg: 'bg-orange-400/10', borderActive: 'border-orange-400', glowActive: 'shadow-[0_0_18px_rgba(251,146,60,0.15)]' },
  { icon: Car, color: 'text-cyan-400', bg: 'bg-cyan-400/10', borderActive: 'border-cyan-400', glowActive: 'shadow-[0_0_18px_rgba(34,211,238,0.15)]' },
  { icon: Building2, color: 'text-indigo-400', bg: 'bg-indigo-400/10', borderActive: 'border-indigo-400', glowActive: 'shadow-[0_0_18px_rgba(129,140,248,0.15)]' },
  { icon: Dna, color: 'text-purple-400', bg: 'bg-purple-400/10', borderActive: 'border-purple-400', glowActive: 'shadow-[0_0_18px_rgba(192,132,252,0.15)]' },
  { icon: Database, color: 'text-teal-300', bg: 'bg-teal-400/10', borderActive: 'border-teal-300', glowActive: 'shadow-[0_0_18px_rgba(45,212,191,0.15)]' },
  { icon: ShieldX, color: 'text-rose-300', bg: 'bg-rose-400/10', borderActive: 'border-rose-300', glowActive: 'shadow-[0_0_18px_rgba(253,164,175,0.15)]' },
  { icon: BriefcaseBusiness, color: 'text-sky-300', bg: 'bg-sky-400/10', borderActive: 'border-sky-300', glowActive: 'shadow-[0_0_18px_rgba(125,211,252,0.15)]' },
  { icon: TrendingUp, color: 'text-lime-300', bg: 'bg-lime-400/10', borderActive: 'border-lime-300', glowActive: 'shadow-[0_0_18px_rgba(190,242,100,0.15)]' },
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

export default function UniversosPage() {
  const [data, setData] = useState<UniverseRow[]>([])
  const [dimensions, setDimensions] = useState<UniverseDimension[]>(DEFAULT_DIMENSIONS)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [entityFilter, setEntityFilter] = useState<EntityFilter>('persona_natural')

  // Filters state (null = ANY, true = REQUIRED, false = EXCLUDED)
  const [filters, setFilters] = useState<Record<string, FilterState>>({})

  useEffect(() => {
    loadUniversos()
  }, [])

  async function loadUniversos() {
    setLoading(true)
    try {
      const res = await fetch('/api/universos', { cache: 'no-store' })
      const json = await res.json()
      setData(json.data || [])
      if (json.dimensions?.length) setDimensions(json.dimensions)
    } finally {
      setLoading(false)
    }
  }

  async function refreshUniversos() {
    setRefreshing(true)
    try {
      const res = await fetch('/api/universos', {
        method: 'POST',
        cache: 'no-store',
      })
      const json = await res.json()
      if (res.ok) {
        setData(json.data || [])
        if (json.dimensions?.length) setDimensions(json.dimensions)
      }
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

  // Grand total (all rows)
  const totalBase = useMemo(() => scopedData.reduce((acc, row) => acc + row.total, 0), [scopedData])

  // Individual total per dimension (con_X = true, independiente de otros filtros)
  const dimTotals = useMemo(() => {
    const out: Record<string, number> = {}
    for (const dim of dimensions) {
      if (entityFilter === 'todos' && dim.source === 'dataset' && typeof dim.record_count === 'number') {
        out[dim.key] = dim.record_count
      } else {
        out[dim.key] = scopedData.filter(r => getRowFlag(r, dim.key)).reduce((s, r) => s + r.total, 0)
      }
    }
    return out
  }, [dimensions, scopedData, entityFilter])

  // Calculamos el volumen instantáneamente cruzando la matriz precomputada
  const result = useMemo(() => {
    let count = 0
    const matchingRows: UniverseRow[] = []

    for (const row of scopedData) {
      let isMatch = true
      for (const [key, val] of Object.entries(filters)) {
        if (val !== null && getRowFlag(row, key) !== val) {
          isMatch = false
          break
        }
      }
      if (isMatch) {
        count += row.total
        matchingRows.push(row)
      }
    }
    // Sort by total desc
    matchingRows.sort((a, b) => b.total - a.total)
    return { count, matchingRows }
  }, [filters, scopedData])

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

  const resetFilters = () => setFilters({})

  async function exportCurrentSegment() {
    if (activeCount === 0 || exporting) return

    setExporting(true)
    setExportError(null)

    try {
      const res = await fetch('/api/universos/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityFilter, filters }),
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
  const activeFilters = Object.entries(filters).filter(([, v]) => v !== null)
  const datasetDimensionCount = dimensions.filter(dim => dim.source === 'dataset').length

  return (
    <>
      <Header
        title="Explorador de Universos"
        subtitle="Matriz combinatoria — cruce de volúmenes en tiempo real"
      />

      <div className="p-6 flex flex-col xl:flex-row gap-6" style={{ minHeight: 'calc(100vh - 5rem)' }}>
        
        {/* COLUMNA IZQUIERDA: CONTROLES */}
        <div className="flex-1 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-300">Dimensiones de Datos</h3>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Primero elige el universo base; luego incluye ✓ o excluye ✗ cada dimensión
                {datasetDimensionCount > 0 ? ` · ${datasetDimensionCount} filtros sincronizados desde datasets` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={refreshUniversos}
                disabled={refreshing}
                className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 disabled:opacity-60 disabled:cursor-wait transition-all"
              >
                <RefreshCcw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
                {refreshing ? 'Actualizando' : 'Actualizar matriz'}
              </button>
              <button onClick={resetFilters} className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-800/50 hover:bg-slate-700 text-slate-400 hover:text-white transition-all">
                <RefreshCcw className="w-3 h-3" />
                Restablecer
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-3">
            {ENTITY_GROUPS.map(group => {
              const isActive = entityFilter === group.key
              const total = entityTotals[group.key]
              return (
                <button
                  key={group.key}
                  onClick={() => setEntityFilter(group.key)}
                  className={`rounded-xl border p-4 text-left transition-all ${isActive ? `${group.border} ${group.bg} shadow-[0_0_18px_rgba(15,23,42,0.35)]` : 'border-slate-700/50 bg-[#1e293b]/40 hover:bg-[#1e293b]/70'}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h4 className={`text-sm font-semibold ${isActive ? group.tone : 'text-white'}`}>{group.label}</h4>
                      <p className="mt-1 text-[10px] text-slate-500 leading-relaxed">{group.description}</p>
                    </div>
                    {isActive && <Check className={`w-4 h-4 ${group.tone}`} />}
                  </div>
                  <div className="mt-4 text-xl font-black text-white">{formatNumber(total)}</div>
                  <div className="text-[10px] text-slate-500 mt-1">registros en este universo</div>
                </button>
              )
            })}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
             {dimensions.map((dim, index) => {
               const state = filters[dim.key]
               const dimStyle = getDimensionStyle(index)
               const Icon = dimStyle.icon
               const dimTotal = dimTotals[dim.key] || 0
               const dimPct = totalBase > 0 ? (dimTotal / totalBase) * 100 : 0
               
               let stateClass = "border-slate-700/50 bg-[#1e293b]/50"
               let StateIcon = Minus
               let stateColor = "text-slate-500"
               let stateLabel = 'Cualquiera'
               
               if (state === true) {
                 stateClass = `${dimStyle.borderActive} border bg-[#1e293b]/80 ${dimStyle.glowActive}`
                 StateIcon = Check
                 stateColor = dimStyle.color
                 stateLabel = 'Requerido'
               } else if (state === false) {
                 stateClass = "border-red-500/40 bg-red-950/30"
                 StateIcon = X
                 stateColor = "text-red-400"
                 stateLabel = 'Excluido'
               }

               return (
                 <button
                    key={dim.key}
                    onClick={() => toggleFilter(dim.key)}
                    className={`p-4 rounded-xl border transition-all duration-200 text-left flex flex-col gap-3 ${stateClass}`}
                 >
                   <div className="flex items-start justify-between w-full">
                     <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${dimStyle.bg}`}>
                          <Icon className={`w-4.5 h-4.5 ${dimStyle.color}`} />
                        </div>
                        <div>
                          <h4 className="text-sm font-semibold text-white leading-tight">{dim.label}</h4>
                          <p className={`text-[10px] mt-0.5 uppercase tracking-wider font-medium ${stateColor}`}>
                            {stateLabel}{dim.source === 'dataset' ? ' · Dataset' : ''}
                          </p>
                        </div>
                     </div>
                     <div className={`w-5 h-5 rounded-full flex items-center justify-center bg-black/20 border border-white/5 flex-shrink-0 ${stateColor}`}>
                       <StateIcon className="w-3 h-3" />
                     </div>
                   </div>

                   {/* Individual total + mini progress bar */}
                   <div className="w-full">
                     <div className="flex items-center justify-between mb-1">
                       <span className="text-[10px] text-slate-500">Universo propio</span>
                       <span className={`text-[11px] font-mono font-semibold ${dimStyle.color}`}>
                         {loading ? '…' : formatNumber(dimTotal)} ({dimPct.toFixed(1)}%)
                       </span>
                     </div>
                     <div className="w-full h-1 bg-slate-800 rounded-full overflow-hidden">
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
          {!loading && activeCount > 0 && (
            <div className="mt-2">
              <div className="flex items-center gap-2 mb-2">
                <Info className="w-3.5 h-3.5 text-slate-500" />
                <span className="text-[11px] text-slate-500">
                  {result.matchingRows.length} combinación{result.matchingRows.length !== 1 ? 'es' : ''} que componen el resultado
                </span>
              </div>
              <div className="rounded-xl border border-slate-700/50 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-800/80 border-b border-slate-700/50">
                        {dimensions.map(d => (
                          <th key={d.key} className="px-2 py-2 text-center text-[10px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">
                            {shortLabel(d)}
                          </th>
                        ))}
                        <th className="px-3 py-2 text-right text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Registros</th>
                        <th className="px-3 py-2 text-right text-[10px] font-semibold text-slate-400 uppercase tracking-wider">%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.matchingRows.map((row, i) => (
                        <tr
                          key={i}
                          className={`border-b border-slate-800/50 ${i % 2 === 0 ? 'bg-[#1e293b]/30' : 'bg-transparent'} hover:bg-slate-800/30 transition-colors`}
                        >
                          {dimensions.map(d => (
                            <td key={d.key} className="px-2 py-2 text-center">
                              <BoolBadge val={getRowFlag(row, d.key)} />
                            </td>
                          ))}
                          <td className="px-3 py-2 text-right font-mono font-semibold text-white">
                            {formatNumber(row.total)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-slate-400 text-[10px]">
                            {totalBase > 0 ? (row.total / totalBase * 100).toFixed(2) : '0'}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-slate-800/60 border-t border-slate-600/50">
                        <td colSpan={dimensions.length} className="px-3 py-2 text-right text-[10px] text-slate-400 font-semibold uppercase tracking-wider">
                          Total
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-bold text-cyan-400">
                          {formatNumber(result.count)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-cyan-400 text-[10px]">
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
        <div className="xl:w-[400px] flex flex-col gap-4">
          <div className="glass-panel flex flex-col justify-center items-center text-center p-8 relative overflow-hidden" style={{ minHeight: 320 }}>
             
             {/* Background glow animated */}
             <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-cyan-500/10 rounded-full blur-[80px] animate-pulse-slow pointer-events-none" />

             {loading ? (
               <LoadingState text="Cargando matriz…" />
             ) : (
               <>
                 <h2 className="text-base font-bold text-slate-300 mb-1">Universo Resultante</h2>
                 <p className="text-[10px] text-slate-500 mb-6">
                   {ENTITY_GROUPS.find(group => group.key === entityFilter)?.label ?? 'Todos'} · {activeCount === 0 ? 'sin filtros adicionales' : `${activeCount} filtro${activeCount > 1 ? 's' : ''} activo${activeCount > 1 ? 's' : ''}`}
                 </p>
                 
                 <div className="my-4">
                   <div className="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-br from-white to-slate-400 drop-shadow-lg tracking-tight">
                     {formatNumber(result.count)}
                   </div>
                   <p className="text-sm text-cyan-400 font-medium mt-3 bg-cyan-500/10 inline-flex px-4 py-1 rounded-full border border-cyan-500/20">
                    {pct.toFixed(2)}% del total
                   </p>
                 </div>

                 {/* Filtros activos */}
                 {activeCount > 0 && (
                   <div className="w-full bg-slate-800/50 rounded-xl p-3 mt-4 border border-white/5 text-left">
                     <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Filtros aplicados</p>
                     <div className="flex flex-wrap gap-1.5">
                       {activeFilters.map(([key, val]) => {
                         const dim = dimensions.find(d => d.key === key)
                         const dimIndex = dimensions.findIndex(d => d.key === key)
                         const dimStyle = getDimensionStyle(dimIndex >= 0 ? dimIndex : 0)
                         return (
                           <span
                             key={key}
                             className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${val === true ? `${dimStyle.color} border-current bg-current/10` : 'text-red-400 border-red-500/40 bg-red-950/30'}`}
                           >
                             {val === true ? <Check className="w-2.5 h-2.5" /> : <X className="w-2.5 h-2.5" />}
                             {dim ? shortLabel(dim) : key}
                           </span>
                         )
                       })}
                     </div>
                   </div>
                 )}

                 <div className="w-full bg-slate-800/50 rounded-xl p-3 mt-3 border border-white/5">
                   <div className="flex justify-between items-center text-xs text-slate-400 mb-1.5">
                     <span>Combinaciones sumadas:</span>
                     <span className="font-mono text-cyan-400">{result.matchingRows.length} de {scopedData.length}</span>
                   </div>
                   <div className="flex justify-between items-center text-xs text-slate-400">
                     <span>Base total:</span>
                     <span className="font-mono text-white">{formatNumber(totalBase)}</span>
                   </div>
                 </div>
                 
                 <button
                  onClick={exportCurrentSegment}
                  disabled={activeCount === 0 || exporting}
                  className={`mt-4 w-full py-3 rounded-lg font-bold text-sm transition-all inline-flex items-center justify-center gap-2 ${activeCount > 0 ? 'bg-brand-600 hover:bg-brand-500 text-white shadow-lg shadow-brand-500/25 disabled:opacity-60 disabled:cursor-wait' : 'bg-slate-800 text-slate-500 cursor-not-allowed'}`}
                 >
                    <Download className="w-4 h-4" />
                    {exporting ? 'Exportando…' : activeCount > 0 ? 'Exportar este segmento exacto' : 'Aplica filtros para exportar'}
                 </button>
                 {exportError && (
                  <p className="mt-2 text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
                    {exportError}
                  </p>
                 )}
               </>
             )}
          </div>

          {/* Info de contexto */}
          {!loading && (
            <div className="glass-panel p-4 text-xs text-slate-400 space-y-2">
              <p className="font-semibold text-slate-300 text-[11px] uppercase tracking-wider">Cómo funciona</p>
              <p>Primero eliges el <span className="text-white">tipo de entidad</span>: naturales, jurídicas, indeterminados, recuperables o basura. Luego cada dimensión muestra su universo propio dentro de ese grupo.</p>
              <p>Al combinar dos dimensiones, el resultado es la <span className="text-cyan-400">intersección</span> (personas que tienen ambas), por lo que el número puede bajar respecto a cada dimensión individual.</p>
              <p className="text-slate-500">Base activa: <span className="font-mono text-white">{formatNumber(totalBase)}</span> registros en {scopedData.length} combinaciones únicas.</p>
              {datasetDimensionCount > 0 && (
                <p className="text-slate-500">Datasets sincronizados como filtros: <span className="font-mono text-white">{datasetDimensionCount}</span>.</p>
              )}
            </div>
          )}
        </div>

      </div>
    </>
  )
}
