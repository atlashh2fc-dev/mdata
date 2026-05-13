'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { Header } from '@/components/layout/Header'
import { SearchBar } from '@/components/personas/SearchBar'
import { PersonasTable } from '@/components/personas/PersonasTable'
import { PersonaProfile } from '@/components/personas/PersonaProfile'
import { CommercialIntelligencePanel } from '@/components/commercial/CommercialIntelligencePanel'
import { LoadingState } from '@/components/ui/Spinner'
import type { PersonaView, PaginatedResponse } from '@/types'
import { validateRut } from '@/lib/utils/rut'
import { formatNumber } from '@/lib/utils/formatters'
import { X, Filter, Download } from 'lucide-react'

interface Filters {
  region: string
  tiene_autos: boolean | null
  tiene_empresa: boolean | null
  tiene_bienes_raices: boolean | null
  uso_propiedad: string
  destino_propiedad: string
  score_min: string
  score_max: string
}

const DEFAULT_FILTERS: Filters = {
  region: '',
  tiene_autos: null,
  tiene_empresa: null,
  tiene_bienes_raices: null,
  uso_propiedad: '',
  destino_propiedad: '',
  score_min: '',
  score_max: '',
}

const USO_PROPIEDAD_OPTIONS = [
  { value: 'con_residencial', label: 'Residencial' },
  { value: 'con_comercial', label: 'Comercial' },
  { value: 'mixto_comercial_residencial', label: 'Mixto comercial/residencial' },
  { value: 'solo_residencial', label: 'Solo residencial' },
  { value: 'solo_comercial', label: 'Solo comercial' },
  { value: 'rural_productivo', label: 'Rural/productivo' },
  { value: 'indeterminado_o_especial', label: 'Especial/indeterminado' },
]

const DESTINO_OPTIONS = [
  { value: 'HABITACIONAL', label: 'Habitacional', group: 'Residencial' },
  { value: 'CASA PATRONAL', label: 'Casa patronal', group: 'Residencial' },
  { value: 'COMERCIO', label: 'Comercio', group: 'Comercial' },
  { value: 'OFICINA', label: 'Oficina', group: 'Comercial' },
  { value: 'BODEGA Y ALMACENAJE', label: 'Bodega y almacenaje', group: 'Comercial' },
  { value: 'INDUSTRIA', label: 'Industria', group: 'Comercial' },
  { value: 'HOTEL, MOTEL', label: 'Hotel, motel', group: 'Comercial' },
  { value: 'SALUD', label: 'Salud', group: 'Comercial' },
  { value: 'EDUCACION Y CULTURA', label: 'Educación y cultura', group: 'Comercial' },
  { value: 'DEPORTE Y RECREACION', label: 'Deporte y recreación', group: 'Comercial' },
  { value: 'TRANSPORTE Y TELECOMUNICACIONES', label: 'Transporte y telecom.', group: 'Comercial' },
  { value: 'AGROINDUSTRIAL', label: 'Agroindustrial', group: 'Comercial' },
  { value: 'MINERIA', label: 'Minería', group: 'Comercial' },
  { value: 'AGRICOLA', label: 'Agrícola', group: 'Rural/productivo' },
  { value: 'FORESTAL', label: 'Forestal', group: 'Rural/productivo' },
  { value: 'ESTACIONAMIENTO', label: 'Estacionamiento', group: 'Especial' },
  { value: 'SITIO ERIAZO', label: 'Sitio eriazo', group: 'Especial' },
  { value: 'BIENES COMUNES', label: 'Bienes comunes', group: 'Especial' },
  { value: 'CULTO', label: 'Culto', group: 'Especial' },
  { value: 'OTROS NO CONSIDERADOS', label: 'Otros no considerados', group: 'Especial' },
]

export default function BuscarPage() {
  const searchParams = useSearchParams()
  const [query, setQuery] = useState(searchParams.get('rut') ?? '')
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [showFilters, setShowFilters] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [sortBy, setSortBy] = useState('score_patrimonial')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [singleProfile, setSingleProfile] = useState<PersonaView | null>(null)
  const [tableData, setTableData] = useState<PaginatedResponse<PersonaView> | null>(null)
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const didRunInitialSearch = useRef(false)

  const PAGE_SIZE = 50

  const buildSearchParams = useCallback((currentPage = 1, pageSize = PAGE_SIZE, currentSort = sortBy, currentOrder = sortOrder) => {
    const params = new URLSearchParams({
      q: query,
      page: String(currentPage),
      page_size: String(pageSize),
      sort_by: currentSort,
      sort_order: currentOrder,
    })

    if (filters.region) params.set('region', filters.region)
    if (filters.tiene_autos !== null) params.set('tiene_autos', String(filters.tiene_autos))
    if (filters.tiene_empresa !== null) params.set('tiene_empresa', String(filters.tiene_empresa))
    if (filters.tiene_bienes_raices !== null) params.set('tiene_bienes_raices', String(filters.tiene_bienes_raices))
    if (filters.uso_propiedad) params.set('uso_propiedad', filters.uso_propiedad)
    if (filters.destino_propiedad) params.set('destino_propiedad', filters.destino_propiedad)
    if (filters.score_min) params.set('score_min', filters.score_min)
    if (filters.score_max) params.set('score_max', filters.score_max)

    return params
  }, [PAGE_SIZE, filters, query, sortBy, sortOrder])

  const search = useCallback(async (currentPage = 1, currentSort = sortBy, currentOrder = sortOrder) => {
    if (!query.trim() && !Object.values(filters).some(Boolean)) return

    setLoading(true)
    setError(null)
    setSingleProfile(null)

    // Búsqueda por RUT exacto
    if (validateRut(query.trim()) && !showFilters) {
      const res = await fetch(`/api/personas?rut=${encodeURIComponent(query.trim())}`)
      const json = await res.json()
      if (json.success) {
        setSingleProfile(json.data)
      } else {
        setError('RUT no encontrado en la base de datos')
      }
      setLoading(false)
      return
    }

    // Búsqueda con filtros
    const params = buildSearchParams(currentPage, PAGE_SIZE, currentSort, currentOrder)

    const res = await fetch(`/api/personas?${params}`)
    const json = await res.json()

    if (json.success) {
      setTableData(json)
      setPage(currentPage)
    } else {
      setError('Error al realizar la búsqueda')
    }

    setLoading(false)
  }, [PAGE_SIZE, buildSearchParams, filters, query, sortBy, sortOrder, showFilters])

  function handleSort(field: string) {
    const newOrder = field === sortBy && sortOrder === 'desc' ? 'asc' : 'desc'
    setSortBy(field)
    setSortOrder(newOrder)
    search(1, field, newOrder)
  }

  function handlePageChange(newPage: number) {
    search(newPage)
  }

  useEffect(() => {
    if (didRunInitialSearch.current) return
    const initialQuery = searchParams.get('rut') ?? searchParams.get('q')
    if (!initialQuery?.trim()) return
    didRunInitialSearch.current = true
    search(1)
  }, [search, searchParams])

  const hasActiveFilters = Object.entries(filters).some(([, v]) => v !== null && v !== '')
  const currentTotal = previewCount ?? tableData?.total

  useEffect(() => {
    if (!showFilters || !hasActiveFilters) {
      setPreviewCount(null)
      return
    }

    const controller = new AbortController()
    const timeout = window.setTimeout(async () => {
      setPreviewLoading(true)
      try {
        const params = buildSearchParams(1, 1)
        const res = await fetch(`/api/personas?${params}`, { signal: controller.signal })
        const json = await res.json()
        if (json.success) setPreviewCount(json.total ?? 0)
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setPreviewCount(null)
      } finally {
        setPreviewLoading(false)
      }
    }, 350)

    return () => {
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [buildSearchParams, hasActiveFilters, showFilters])

  function downloadFilteredCsv() {
    if (!hasActiveFilters && !query.trim()) return
    const params = buildSearchParams(1, PAGE_SIZE)
    params.delete('page')
    params.delete('page_size')
    window.location.href = `/api/personas/export?${params}`
  }

  return (
    <>
      <Header
        title="Buscador / Perfil 360"
        subtitle="Consulta RUTs individuales o aplica filtros avanzados"
      />

      <div className="p-6 space-y-4">
        {/* Search */}
        <SearchBar
          value={query}
          onChange={setQuery}
          onSearch={() => search(1)}
          showFiltersToggle
          onToggleFilters={() => setShowFilters(!showFilters)}
          isLoading={loading}
          placeholder="Buscar por RUT, nombre, email, empresa o rubro..."
        />

        {/* Advanced Filters Panel */}
        {showFilters && (
          <div className="card p-4 animate-slide-in">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                <Filter className="w-3.5 h-3.5" />
                Filtros avanzados
                {hasActiveFilters && (
                  <span className="badge-brand badge">activos</span>
                )}
              </h3>
              <button
                onClick={() => setFilters(DEFAULT_FILTERS)}
                className="text-xs text-slate-500 hover:text-white flex items-center gap-1"
              >
                <X className="w-3 h-3" />
                Limpiar
              </button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Región</label>
                <input
                  type="text"
                  value={filters.region}
                  onChange={e => setFilters(f => ({ ...f, region: e.target.value }))}
                  placeholder="Ej: Metropolitana"
                  className="input-base"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Score mín.</label>
                <input
                  type="number"
                  value={filters.score_min}
                  onChange={e => setFilters(f => ({ ...f, score_min: e.target.value }))}
                  placeholder="0"
                  className="input-base"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Score máx.</label>
                <input
                  type="number"
                  value={filters.score_max}
                  onChange={e => setFilters(f => ({ ...f, score_max: e.target.value }))}
                  placeholder="100"
                  className="input-base"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Tiene autos</label>
                <select
                  value={String(filters.tiene_autos)}
                  onChange={e => setFilters(f => ({
                    ...f,
                    tiene_autos: e.target.value === 'null' ? null : e.target.value === 'true',
                  }))}
                  className="input-base"
                >
                  <option value="null">Todos</option>
                  <option value="true">Con autos</option>
                  <option value="false">Sin autos</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Tiene empresa</label>
                <select
                  value={String(filters.tiene_empresa)}
                  onChange={e => setFilters(f => ({
                    ...f,
                    tiene_empresa: e.target.value === 'null' ? null : e.target.value === 'true',
                  }))}
                  className="input-base"
                >
                  <option value="null">Todos</option>
                  <option value="true">Con empresa</option>
                  <option value="false">Sin empresa</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Bienes raíces</label>
                <select
                  value={String(filters.tiene_bienes_raices)}
                  onChange={e => setFilters(f => ({
                    ...f,
                    tiene_bienes_raices: e.target.value === 'null' ? null : e.target.value === 'true',
                  }))}
                  className="input-base"
                >
                  <option value="null">Todos</option>
                  <option value="true">Con B. Raíces</option>
                  <option value="false">Sin B. Raíces</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Uso propiedad</label>
                <select
                  value={filters.uso_propiedad}
                  onChange={e => setFilters(f => ({
                    ...f,
                    uso_propiedad: e.target.value,
                    tiene_bienes_raices: e.target.value ? true : f.tiene_bienes_raices,
                  }))}
                  className="input-base"
                >
                  <option value="">Todos</option>
                  {USO_PROPIEDAD_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Subtipo propiedad</label>
                <select
                  value={filters.destino_propiedad}
                  onChange={e => setFilters(f => ({
                    ...f,
                    destino_propiedad: e.target.value,
                    tiene_bienes_raices: e.target.value ? true : f.tiene_bienes_raices,
                  }))}
                  className="input-base"
                >
                  <option value="">Todos</option>
                  {['Residencial', 'Comercial', 'Rural/productivo', 'Especial'].map(group => (
                    <optgroup key={group} label={group}>
                      {DESTINO_OPTIONS.filter(option => option.group === group).map(option => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mt-4">
              <div className="text-xs text-slate-400">
                {hasActiveFilters ? (
                  previewLoading ? (
                    <span>Calculando universo disponible…</span>
                  ) : (
                    <span>
                      Quedan <span className="font-semibold text-cyan-300">{formatNumber(currentTotal ?? 0)}</span> registros con estos filtros
                    </span>
                  )
                ) : (
                  <span>Aplica filtros para ver el universo disponible.</span>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={downloadFilteredCsv}
                  disabled={!hasActiveFilters && !query.trim()}
                  className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Download className="w-3.5 h-3.5" />
                  Descargar CSV
                </button>
                <button onClick={() => search(1)} className="btn-primary">
                  Aplicar filtros
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <X className="w-4 h-4 text-red-400" />
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Loading */}
        {loading && <LoadingState text="Buscando en la base de datos..." />}

        {/* Perfil 360 */}
        {!loading && singleProfile && (
          <div className="space-y-4">
            <PersonaProfile persona={singleProfile} />
            <CommercialIntelligencePanel rut={singleProfile.rutid} />
          </div>
        )}

        {/* Tabla de resultados */}
        {!loading && tableData && !singleProfile && (
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-[#253357]">
              <p className="text-sm font-semibold text-slate-200">
                {tableData.total.toLocaleString('es-CL')} resultados encontrados
              </p>
            </div>
            <PersonasTable
              data={tableData.data}
              total={tableData.total}
              page={page}
              pageSize={PAGE_SIZE}
              onPageChange={handlePageChange}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSort={handleSort}
            />
          </div>
        )}

        {/* Empty state inicial */}
        {!loading && !singleProfile && !tableData && !error && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <div className="w-16 h-16 rounded-2xl bg-brand-500/10 flex items-center justify-center border border-brand-500/20">
              <span className="text-3xl">🔍</span>
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-slate-300">Comienza una búsqueda</p>
              <p className="text-xs text-slate-500 mt-1">
                Ingresa un RUT, nombre, email, empresa o rubro. También puedes usar filtros avanzados.
              </p>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
