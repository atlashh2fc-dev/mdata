'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { LoadingState, EmptyState } from '@/components/ui/Spinner'
import type { DataSource } from '@/types'
import {
  AlertCircle, BarChart3, Database, Download, Eye, FileText, Globe, Loader2, Plus, ShieldCheck, Table2, X,
} from 'lucide-react'
import { formatDatetime, formatNumber, formatRelativeTime } from '@/lib/utils/formatters'

const SOURCE_TYPE_ICONS: Record<string, React.ElementType> = {
  csv: FileText,
  xlsx: Table2,
  json: FileText,
  api: Globe,
  mysql: Database,
  postgres: Database,
}

function SourceTypeLabel({ type }: { type: string }) {
  const Icon = SOURCE_TYPE_ICONS[type] ?? FileText
  return (
    <div className="flex items-center gap-1.5 text-xs text-slate-400">
      <Icon className="w-3.5 h-3.5" />
      {type.toUpperCase()}
    </div>
  )
}

const GSE_OPTIONS = [
  { value: 'ALL', label: 'Todos los grupos' },
  { value: 'AB', label: 'AB' },
  { value: 'C1A', label: 'C1a' },
  { value: 'C1B', label: 'C1b' },
  { value: 'C2', label: 'C2' },
  { value: 'C3', label: 'C3' },
  { value: 'DE', label: 'D/E' },
] as const

type GseGroupValue = typeof GSE_OPTIONS[number]['value']

function getExportHref(fuente: DataSource) {
  if (!fuente.canonical_table && !fuente.source_table_name) return null
  return `/api/fuentes/${fuente.id}/export`
}

function supportsCrmExport(fuente: DataSource) {
  return fuente.slug === 'empresa_resumen' || fuente.canonical_table === 'empresa_resumen'
}

function getBlacklistBreakdown(fuente: DataSource) {
  const breakdown = fuente.config?.blacklist_breakdown
  if (!breakdown || typeof breakdown !== 'object') return null

  const values = breakdown as { emails?: unknown; phones?: unknown }
  return {
    emails: typeof values.emails === 'number' ? values.emails : 0,
    phones: typeof values.phones === 'number' ? values.phones : 0,
  }
}

type DatasetPreview = {
  source: {
    id: string
    name?: string | null
    slug?: string | null
    table_name: string
  }
  columns: string[]
  rows: Record<string, unknown>[]
  row_limit: number
}

function formatPreviewValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export default function DatasetsPage() {
  const [fuentes, setFuentes] = useState<DataSource[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '', source_type: 'csv', description: '' })
  const [previewSource, setPreviewSource] = useState<DataSource | null>(null)
  const [preview, setPreview] = useState<DatasetPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [gseGroups, setGseGroups] = useState<GseGroupValue[]>(['ALL'])
  const [gseGeoMode, setGseGeoMode] = useState<'geolocated' | 'all'>('geolocated')
  const [gseMinCount, setGseMinCount] = useState('50')

  useEffect(() => {
    loadFuentes()
  }, [])

  async function loadFuentes() {
    setLoading(true)
    const res = await fetch('/api/fuentes')
    const json = await res.json()
    setFuentes(json.data ?? [])
    setLoading(false)
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)

    const res = await fetch('/api/fuentes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })

    if (res.ok) {
      setShowCreateModal(false)
      setForm({ name: '', source_type: 'csv', description: '' })
      loadFuentes()
    }
    setCreating(false)
  }

  async function openPreview(fuente: DataSource) {
    if (!fuente.canonical_table && !fuente.source_table_name) return

    setPreviewSource(fuente)
    setPreview(null)
    setPreviewError(null)
    setPreviewLoading(true)

    try {
      const res = await fetch(`/api/fuentes/${fuente.id}/preview`)
      const json = await res.json()

      if (!res.ok) {
        throw new Error(json.error ?? 'No se pudo cargar la preview.')
      }

      setPreview(json.data)
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'No se pudo cargar la preview.')
    } finally {
      setPreviewLoading(false)
    }
  }

  function closePreview() {
    setPreviewSource(null)
    setPreview(null)
    setPreviewError(null)
    setPreviewLoading(false)
  }

  function toggleGseGroup(group: GseGroupValue) {
    setGseGroups(current => {
      if (group === 'ALL') return ['ALL']

      const selected = current.filter(value => value !== 'ALL')
      const next = selected.includes(group)
        ? selected.filter(value => value !== group)
        : [...selected, group]

      return next.length > 0 ? next : ['ALL']
    })
  }

  function getGseExportHref() {
    const params = new URLSearchParams({
      group: gseGroups.includes('ALL') ? 'ALL' : gseGroups.join(','),
      geo: gseGeoMode === 'geolocated' ? 'geolocated' : 'all',
      min_count: gseMinCount || '50',
      limit: '10000',
    })
    return `/api/personas/gse?${params.toString()}`
  }

  return (
    <>
      <Header
        title="Datasets"
        subtitle="Fuentes de datos registradas en el sistema"
        actions={
          <button
            onClick={() => setShowCreateModal(true)}
            className="btn-primary"
          >
            <Plus className="w-4 h-4" />
            Nueva fuente
          </button>
        }
      />

      <div className="p-6 space-y-5">
        <section className="grid grid-cols-1 xl:grid-cols-[1.15fr_0.85fr] gap-4">
          <div className="card p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex items-center gap-2 text-xs text-cyan-300 mb-2">
                  <BarChart3 className="w-4 h-4" />
                  Personas naturales
                </div>
                <h2 className="text-base font-semibold text-white">
                  Subconjuntos por grupo socioeconómico proxy
                </h2>
                <p className="text-xs text-slate-400 mt-1 max-w-2xl">
                  Descarga personas filtradas por región, comuna, grupo, autos, bienes raíces, avalúos y score. El archivo incluye RUT, nombre, mail, teléfono y dirección disponible.
                </p>
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                <ShieldCheck className="w-4 h-4" />
                identificado
              </div>
            </div>

            <div className="space-y-4 mt-5">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">
                  Grupos
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                  {GSE_OPTIONS.map(option => (
                    <label
                      key={option.value}
                      className={`flex h-10 items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors ${
                        gseGroups.includes(option.value)
                          ? 'border-cyan-400/70 bg-cyan-400/10 text-cyan-100'
                          : 'border-[#253357] bg-[#0f172a] text-slate-300 hover:border-cyan-400/40'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={gseGroups.includes(option.value)}
                        onChange={() => toggleGseGroup(option.value)}
                        className="h-4 w-4 rounded border-slate-600 bg-[#0b1224] accent-cyan-400"
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">
                    Cobertura territorial
                  </label>
                  <select
                    value={gseGeoMode}
                    onChange={event => setGseGeoMode(event.target.value === 'all' ? 'all' : 'geolocated')}
                    className="input-base"
                  >
                    <option value="geolocated">Solo con región y comuna</option>
                    <option value="all">Incluir sin zona</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">
                    Mínimo por segmento
                  </label>
                  <input
                    type="number"
                    min="50"
                    max="1000"
                    value={gseMinCount}
                    onChange={event => setGseMinCount(event.target.value)}
                    className="input-base"
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mt-5 pt-4 border-t border-[#253357]/80">
              <p className="text-xs text-slate-500">
                Se genera en vivo desde la vista maestra de personas y devuelve hasta 10.000 registros.
              </p>
              <a
                href={getGseExportHref()}
                className="btn-primary justify-center"
              >
                <Download className="w-4 h-4" />
                Descargar subconjunto
              </a>
            </div>
          </div>

          <div className="card p-5">
            <h3 className="text-sm font-semibold text-white mb-3">Criterio de grupos</h3>
            <div className="space-y-2 text-xs text-slate-400">
              <p><span className="font-semibold text-slate-200">AB/C1a/C1b</span> se infiere con señales patrimoniales altas: avalúos, cantidad de bienes raíces, autos y score interno.</p>
              <p><span className="font-semibold text-slate-200">C2/C3/D-E</span> agrupa el resto por bandas de score patrimonial y señales disponibles.</p>
              <p>La salida está pensada para priorización y activación comercial con personas identificadas.</p>
            </div>
          </div>
        </section>

        {loading ? (
          <LoadingState />
        ) : fuentes.length === 0 ? (
          <EmptyState
            title="Sin fuentes de datos"
            description="Crea una fuente para comenzar a ingestar datos"
            action={
              <button onClick={() => setShowCreateModal(true)} className="btn-primary">
                <Plus className="w-4 h-4" />
                Crear primera fuente
              </button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {fuentes.map(fuente => {
              const Icon = SOURCE_TYPE_ICONS[fuente.source_type] ?? Database
              const exportHref = getExportHref(fuente)
              const crmExportHref = supportsCrmExport(fuente)
                ? `${exportHref}?include_crm=1`
                : null
              const blacklistBreakdown = getBlacklistBreakdown(fuente)
              return (
                <div
                  key={fuente.id}
                  onClick={event => {
                    const target = event.target as HTMLElement
                    if (target.closest('a, button')) return
                    openPreview(fuente)
                  }}
                  className="card-hover p-5 group cursor-pointer"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="w-10 h-10 rounded-xl bg-brand-500/10 flex items-center justify-center border border-brand-500/20">
                      <Icon className="w-5 h-5 text-brand-400" />
                    </div>
                    <span className={`badge ${fuente.is_active ? 'badge-success' : 'badge-neutral'}`}>
                      <span className="w-1.5 h-1.5 rounded-full bg-current" />
                      {fuente.is_active ? 'Activa' : 'Inactiva'}
                    </span>
                  </div>

                  <h3 className="text-sm font-semibold text-white mb-1">{fuente.name}</h3>
                  {fuente.description && (
                    <p className="text-xs text-slate-500 mb-3">{fuente.description}</p>
                  )}

                  <div className="space-y-1.5 text-[11px] text-slate-500">
                    {fuente.source_table_name && (
                      <div className="flex items-center justify-between gap-3">
                        <span>Tabla origen</span>
                        <span className="font-mono text-slate-400">{fuente.source_table_name}</span>
                      </div>
                    )}
                    {fuente.canonical_table && (
                      <div className="flex items-center justify-between gap-3">
                        <span>Tabla canónica</span>
                        <span className="font-mono text-slate-400">{fuente.canonical_table}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-3">
                      <span>Registros</span>
                      <span className="text-slate-300">
                        {formatNumber(fuente.latest_loaded_row_count ?? fuente.record_count ?? 0)}
                      </span>
                    </div>
                    {blacklistBreakdown && (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <span>Emails exclusión</span>
                          <span className="text-slate-300">{formatNumber(blacklistBreakdown.emails)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>Teléfonos exclusión</span>
                          <span className="text-slate-300">{formatNumber(blacklistBreakdown.phones)}</span>
                        </div>
                      </>
                    )}
                    {(fuente.latest_version_status || fuente.last_job_status) && (
                      <div className="flex items-center justify-between gap-3">
                        <span>Última carga</span>
                        <span className="text-slate-300">
                          {fuente.latest_version_status ?? fuente.last_job_status}
                        </span>
                      </div>
                    )}
                    {(fuente.latest_version_label || fuente.latest_version_completed_at || fuente.last_loaded_at) && (
                      <div className="flex items-center justify-between gap-3">
                        <span>Versión</span>
                        <span className="text-slate-300">
                          {fuente.latest_version_label ?? formatDatetime(fuente.latest_version_completed_at ?? fuente.last_loaded_at)}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="mt-3 pt-3 border-t border-[#253357]/50 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <SourceTypeLabel type={fuente.source_type} />
                      <span className="text-[10px] text-slate-600">
                        {formatRelativeTime(fuente.last_loaded_at ?? fuente.created_at)}
                      </span>
                    </div>

                    {exportHref && (
                      <div className="space-y-2">
                        <button
                          type="button"
                          onClick={() => openPreview(fuente)}
                          className="btn-secondary w-full justify-center text-xs py-2"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          Ver preview
                        </button>

                        <a
                          href={exportHref}
                          className="btn-secondary w-full justify-center text-xs py-2"
                        >
                          <Download className="w-3.5 h-3.5" />
                          Descargar CSV
                        </a>

                        {crmExportHref && (
                          <a
                            href={crmExportHref}
                            onClick={event => {
                              const accepted = window.confirm('¿Quieres actualizar la descarga de empresas contra el CRM?')
                              if (!accepted) event.preventDefault()
                            }}
                            className="btn-primary w-full justify-center text-xs py-2"
                          >
                            <Download className="w-3.5 h-3.5" />
                            Descargar CSV + CRM
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="card w-full max-w-md p-6 animate-slide-in">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold text-white">Nueva fuente de datos</h2>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-slate-500 hover:text-white"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">
                  Nombre *
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Ej: Padrón electoral 2024"
                  required
                  className="input-base"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">
                  Tipo de fuente
                </label>
                <select
                  value={form.source_type}
                  onChange={e => setForm(f => ({ ...f, source_type: e.target.value }))}
                  className="input-base"
                >
                  <option value="csv">CSV</option>
                  <option value="xlsx">Excel (XLSX)</option>
                  <option value="json">JSON</option>
                  <option value="api">API Externa</option>
                  <option value="mysql">MySQL</option>
                  <option value="postgres">PostgreSQL</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">
                  Descripción
                </label>
                <textarea
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Descripción opcional de la fuente..."
                  rows={3}
                  className="input-base resize-none"
                />
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="btn-secondary flex-1 justify-center"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={creating || !form.name}
                  className="btn-primary flex-1 justify-center"
                >
                  {creating ? 'Creando...' : 'Crear fuente'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {previewSource && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-3 sm:p-6">
          <div className="card w-full max-w-7xl h-[86vh] animate-slide-in flex flex-col overflow-hidden">
            <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-[#334155]/80">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                  <Database className="w-3.5 h-3.5" />
                  <span className="font-mono truncate">
                    {preview?.source.table_name ?? previewSource.canonical_table ?? previewSource.source_table_name}
                  </span>
                </div>
                <h2 className="text-lg font-semibold text-white truncate">
                  Preview de {previewSource.name}
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Columnas completas y máximo 10 filas de muestra
                </p>
              </div>
              <button
                type="button"
                onClick={closePreview}
                aria-label="Cerrar preview"
                className="btn-secondary px-2.5 py-2 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[#253357]/80 bg-[#0f172a]/35">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <span className="badge-neutral">
                  {preview ? `${formatNumber(preview.columns.length)} columnas` : 'Cargando columnas'}
                </span>
                <span className="badge-neutral">
                  {preview ? `${formatNumber(preview.rows.length)} filas` : 'Hasta 10 filas'}
                </span>
              </div>
              {previewSource.latest_loaded_row_count || previewSource.record_count ? (
                <span className="text-xs text-slate-500">
                  Total registrado: {formatNumber(previewSource.latest_loaded_row_count ?? previewSource.record_count ?? 0)}
                </span>
              ) : null}
            </div>

            <div className="flex-1 min-h-0 p-5">
              {previewLoading ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-400">
                  <Loader2 className="w-8 h-8 animate-spin text-brand-400 mb-3" />
                  <span className="text-sm">Cargando preview del dataset...</span>
                </div>
              ) : previewError ? (
                <div className="h-full flex flex-col items-center justify-center text-center">
                  <div className="w-11 h-11 rounded-xl bg-red-500/10 border border-red-500/25 flex items-center justify-center mb-3">
                    <AlertCircle className="w-5 h-5 text-red-400" />
                  </div>
                  <h3 className="text-sm font-semibold text-white mb-1">No se pudo abrir la preview</h3>
                  <p className="text-sm text-slate-400 max-w-md">{previewError}</p>
                </div>
              ) : preview && preview.columns.length > 0 ? (
                <div className="h-full overflow-auto rounded-lg border border-[#334155]/80 bg-[#0f172a]/70">
                  <table className="min-w-full text-left text-xs">
                    <thead className="sticky top-0 z-10 bg-[#111c31] shadow-[0_1px_0_0_rgba(51,65,85,0.9)]">
                      <tr>
                        {preview.columns.map(column => (
                          <th
                            key={column}
                            className="px-3 py-3 font-semibold text-slate-300 whitespace-nowrap border-r border-[#334155]/60 last:border-r-0"
                          >
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.length === 0 ? (
                        <tr>
                          <td
                            colSpan={preview.columns.length}
                            className="px-4 py-10 text-center text-sm text-slate-500"
                          >
                            Esta tabla no tiene filas para mostrar.
                          </td>
                        </tr>
                      ) : (
                        preview.rows.map((row, rowIndex) => (
                          <tr
                            key={rowIndex}
                            className="border-b border-[#253357]/80 last:border-b-0 hover:bg-white/[0.03]"
                          >
                            {preview.columns.map(column => (
                              <td
                                key={`${rowIndex}-${column}`}
                                className="px-3 py-2.5 text-slate-300 whitespace-nowrap max-w-[280px] truncate border-r border-[#253357]/60 last:border-r-0"
                                title={formatPreviewValue(row[column])}
                              >
                                {formatPreviewValue(row[column])}
                              </td>
                            ))}
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-sm text-slate-500">
                  No hay columnas disponibles para este dataset.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
