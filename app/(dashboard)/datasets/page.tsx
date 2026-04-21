'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { LoadingState, EmptyState } from '@/components/ui/Spinner'
import type { DataSource } from '@/types'
import {
  Plus, Database, Download, FileText, Globe, Table2,
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

function getExportHref(fuente: DataSource) {
  if (!fuente.canonical_table && !fuente.source_table_name) return null
  return `/api/fuentes/${fuente.id}/export`
}

export default function DatasetsPage() {
  const [fuentes, setFuentes] = useState<DataSource[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '', source_type: 'csv', description: '' })

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

      <div className="p-6">
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
              return (
                <div key={fuente.id} className="card-hover p-5 group">
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
                      <a
                        href={exportHref}
                        className="btn-secondary w-full justify-center text-xs py-2"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Descargar CSV
                      </a>
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
    </>
  )
}
