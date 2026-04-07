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
  RefreshCcw,
  Check,
  X,
  Minus
} from 'lucide-react'
import { formatNumber } from '@/lib/utils/formatters'

interface UniverseRow {
  con_nombre: boolean
  con_email: boolean
  con_fono: boolean
  con_autos: boolean
  con_empresa: boolean
  con_domicilio: boolean
  con_bienes_raices: boolean
  total: number
}

type FilterState = true | false | null

const DIMENSIONS = [
  { key: 'con_nombre', label: 'Nombre Completado', icon: Users, color: 'text-blue-400', bg: 'bg-blue-400/10' },
  { key: 'con_fono', label: 'Teléfono Celular', icon: Phone, color: 'text-green-400', bg: 'bg-green-400/10' },
  { key: 'con_email', label: 'Correo Electrónico', icon: Mail, color: 'text-yellow-400', bg: 'bg-yellow-400/10' },
  { key: 'con_domicilio', label: 'Domicilio Conocido', icon: Home, color: 'text-orange-400', bg: 'bg-orange-400/10' },
  { key: 'con_autos', label: 'Tiene Vehículos', icon: Car, color: 'text-cyan-400', bg: 'bg-cyan-400/10' },
  { key: 'con_bienes_raices', label: 'Bienes Raíces', icon: Building2, color: 'text-indigo-400', bg: 'bg-indigo-400/10' },
  { key: 'con_empresa', label: 'Dueño de Empresa', icon: Dna, color: 'text-purple-400', bg: 'bg-purple-400/10' },
]

export default function UniversosPage() {
  const [data, setData] = useState<UniverseRow[]>([])
  const [loading, setLoading] = useState(true)

  // Filters state (null = ANY, true = REQUIRED, false = EXCLUDED)
  const [filters, setFilters] = useState<Record<string, FilterState>>({
    con_nombre: null,
    con_email: null,
    con_fono: null,
    con_autos: null,
    con_empresa: null,
    con_domicilio: null,
    con_bienes_raices: null
  })

  useEffect(() => {
    fetch('/api/universos')
      .then(r => r.json())
      .then(res => {
        setData(res.data || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  // Calculamos el volumen instantáneamente cruzando la matriz precomputada
  const result = useMemo(() => {
    let count = 0
    let universesCount = 0

    for (const row of data) {
      let isMatch = true
      for (const [key, val] of Object.entries(filters)) {
        if (val !== null && row[key as keyof UniverseRow] !== val) {
          isMatch = false
          break
        }
      }
      if (isMatch) {
        count += row.total
        universesCount++
      }
    }
    return { count, universesCount }
  }, [filters, data])

  const totalBase = useMemo(() => data.reduce((acc, row) => acc + row.total, 0), [data])
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
    setFilters({
      con_nombre: null,
      con_email: null,
      con_fono: null,
      con_autos: null,
      con_empresa: null,
      con_domicilio: null,
      con_bienes_raices: null
    })
  }

  // Active filters count
  const activeCount = Object.values(filters).filter(v => v !== null).length

  return (
    <>
      <Header
        title="Explorador de Universos"
        subtitle="Matriz combinatoria para cruzar volúmenes a la velocidad de la luz"
      />

      <div className="p-6 h-[calc(100vh-5rem)] flex flex-col xl:flex-row gap-6">
        
        {/* COLUMNA IZQUIERDA: CONTROLES */}
        <div className="flex-1 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-300">Dimensiones (Capas de datos)</h3>
            <button onClick={resetFilters} className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-800/50 hover:bg-slate-700 text-slate-400 hover:text-white transition-all">
              <RefreshCcw className="w-3 h-3" />
              Restablecer
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
             {DIMENSIONS.map(dim => {
               const state = filters[dim.key]
               const Icon = dim.icon
               
               let stateClass = "border-slate-700/50 bg-[#1e293b]/50"
               let StateIcon = Minus
               let stateColor = "text-slate-500"
               
               if (state === true) {
                 stateClass = "border-cyan-500 bg-cyan-500/10 shadow-[0_0_15px_rgba(6,182,212,0.1)]"
                 StateIcon = Check
                 stateColor = "text-cyan-400"
               } else if (state === false) {
                 stateClass = "border-red-500/50 bg-red-500/10"
                 StateIcon = X
                 stateColor = "text-red-400"
               }

               return (
                 <button
                    key={dim.key}
                    onClick={() => toggleFilter(dim.key)}
                    className={\`p-4 rounded-xl border transition-all duration-200 text-left flex items-start justify-between min-h-[5rem] \${stateClass}\`}
                 >
                   <div className="flex items-center gap-3">
                      <div className={\`w-10 h-10 rounded-lg flex items-center justify-center \${dim.bg}\`}>
                        <Icon className={\`w-5 h-5 \${dim.color}\`} />
                      </div>
                      <div>
                        <h4 className="text-sm font-semibold text-white">{dim.label}</h4>
                        <p className="text-[10px] text-slate-400 mt-1 uppercase tracking-wider">
                          {state === null ? 'Cualquiera (On / Off)' : state === true ? 'Requerido en segmento' : 'Excluido del segmento'}
                        </p>
                      </div>
                   </div>
                   <div className={\`w-6 h-6 rounded-full flex items-center justify-center bg-black/20 border border-white/5 \${stateColor}\`}>
                     <StateIcon className="w-3.5 h-3.5" />
                   </div>
                 </button>
               )
             })}
          </div>
        </div>

        {/* COLUMNA DERECHA: RESULTADO EN VIVO */}
        <div className="xl:w-[450px] flex flex-col gap-6">
          <div className="glass-panel flex-1 flex flex-col justify-center items-center text-center p-8 relative overflow-hidden">
             
             {/* Background glow animated */}
             <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-cyan-500/10 rounded-full blur-[80px] animate-pulse-slow pointer-events-none" />

             {loading ? (
               <LoadingState text="Cargando matriz combinatoria (128 universos)..." />
             ) : (
               <>
                 <h2 className="text-lg font-bold text-slate-300 mb-2">Universo Resultante</h2>
                 
                 <div className="my-8">
                   <div className="text-6xl font-black text-transparent bg-clip-text bg-gradient-to-br from-white to-slate-400 drop-shadow-lg tracking-tight">
                     {formatNumber(result.count)}
                   </div>
                   <p className="text-sm text-cyan-400 font-medium mt-3 bg-cyan-500/10 inline-flex px-4 py-1 rounded-full border border-cyan-500/20">
                    {pct.toFixed(2)}% del volumen total
                   </p>
                 </div>

                 <div className="w-full bg-slate-800/50 rounded-xl p-4 mt-auto border border-white/5">
                   <div className="flex justify-between items-center text-xs text-slate-400 mb-2">
                     <span>Combinaciones agregadas:</span>
                     <span className="font-mono text-cyan-400">{result.universesCount} de 128</span>
                   </div>
                   <div className="flex justify-between items-center text-xs text-slate-400">
                     <span>Filtros activos:</span>
                     <span className="font-mono text-white">{activeCount} / 7</span>
                   </div>
                 </div>
                 
                 <button className={\`mt-4 w-full py-3 rounded-lg font-bold text-sm transition-all \${activeCount > 0 ? 'bg-brand-600 hover:bg-brand-500 text-white shadow-lg shadow-brand-500/25' : 'bg-slate-800 text-slate-500 cursor-not-allowed'}\`}>
                    {activeCount > 0 ? 'Exportar este segmento exacto' : 'Aplica filtros para exportar'}
                 </button>
               </>
             )}
          </div>
        </div>

      </div>
    </>
  )
}
