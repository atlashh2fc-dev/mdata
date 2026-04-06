'use client'

import { useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { Header } from '@/components/layout/Header'
import { SearchBar } from '@/components/personas/SearchBar'
import { PersonasTable } from '@/components/personas/PersonasTable'
import { PersonaProfile } from '@/components/personas/PersonaProfile'
import { LoadingState } from '@/components/ui/Spinner'
import type { PersonaView, PaginatedResponse } from '@/types'
import { validateRut } from '@/lib/utils/rut'
import { X, Filter } from 'lucide-react'

interface Filters {
  region: string
  tiene_autos: boolean | null
  tiene_empresa: boolean | null
  tiene_bienes_raices: boolean | null
  score_min: string
  score_max: string
}

const DEFAULT_FILTERS: Filters = {
  region: '',
  tiene_autos: null,
  tiene_empresa: null,
  tiene_bienes_raices: null,
  score_min: '',
  score_max: '',
}

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

  const PAGE_SIZE = 50

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
    const params = new URLSearchParams({
      q: query,
      page: String(currentPage),
      page_size: String(PAGE_SIZE),
      sort_by: currentSort,
      sort_order: currentOrder,
    })

    if (filters.region) params.set('region', filters.region)
    if (filters.tiene_autos !== null) params.set('tiene_autos', String(filters.tiene_autos))
    if (filters.tiene_empresa !== null) params.set('tiene_empresa', String(filters.tiene_empresa))
    if (filters.tiene_bienes_raices !== null) params.set('tiene_bienes_raices', String(filters.tiene_bienes_raices))
    if (filters.score_min) params.set('score_min', filters.score_min)
    if (filters.score_max) params.set('score_max', filters.score_max)

    const res = await fetch(`/api/personas?${params}`)
    const json = await res.json()

    if (json.success) {
      setTableData(json)
      setPage(currentPage)
    } else {
      setError('Error al realizar la búsqueda')
    }

    setLoading(false)
  }, [query, filters, sortBy, sortOrder, showFilters])

  function handleSort(field: string) {
    const newOrder = field === sortBy && sortOrder === 'desc' ? 'asc' : 'desc'
    setSortBy(field)
    setSortOrder(newOrder)
    search(1, field, newOrder)
  }

  function handlePageChange(newPage: number) {
    search(newPage)
  }

  const hasActiveFilters = Object.entries(filters).some(([, v]) => v !== null && v !== '')

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
          placeholder="Buscar por RUT (12345678-9), nombre o email..."
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
            </div>

            <div className="flex justify-end mt-4">
              <button onClick={() => search(1)} className="btn-primary">
                Aplicar filtros
              </button>
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
          <PersonaProfile persona={singleProfile} />
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
                Ingresa un RUT, nombre o email. También puedes usar filtros avanzados.
              </p>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
