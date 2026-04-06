'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { LoadingState, EmptyState, Spinner } from '@/components/ui/Spinner'
import type { Segmento } from '@/types'
import { Download, FileText, Table2, ChevronRight, Check } from 'lucide-react'
import { formatNumber } from '@/lib/utils/formatters'

export default function ExportarPage() {
  const [segmentos, setSegmentos] = useState<Segmento[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedSeg, setSelectedSeg] = useState<Segmento | null>(null)
  const [exportFormat, setExportFormat] = useState<'csv' | 'json'>('csv')
  const [exporting, setExporting] = useState(false)
  const [exportDone, setExportDone] = useState(false)

  useEffect(() => { loadSegmentos() }, [])

  async function loadSegmentos() {
    setLoading(true)
    const res = await fetch('/api/segmentos')
    const json = await res.json()
    setSegmentos(json.data ?? [])
    setLoading(false)
  }

  async function handleExport() {
    if (!selectedSeg) return
    setExporting(true)
    setExportDone(false)
    try {
      if (exportFormat === 'csv') {
        const res = await fetch('/api/segmentos/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segment_id: selectedSeg.id }),
        })

        if (!res.ok) {
          throw new Error('No se pudo generar el CSV')
        }

        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${selectedSeg.name}.csv`
        a.click()
        URL.revokeObjectURL(url)
      } else {
        const res = await fetch(
          `/api/segmentos?execute=${selectedSeg.id}&exec_page=1&exec_page_size=5000`
        )
        const json = await res.json()
        const blob = new Blob([JSON.stringify(json.data ?? [], null, 2)], {
          type: 'application/json',
        })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${selectedSeg.name}.json`
        a.click()
        URL.revokeObjectURL(url)
      }

      setExportDone(true)
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <Header
        title="Exportar datos"
        subtitle="Descarga segmentos como CSV o JSON"
      />

      <div className="p-6 space-y-5">
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          {/* Segment selector */}
          <div className="xl:col-span-2 card p-5">
            <h3 className="text-sm font-semibold text-slate-200 mb-4">
              Selecciona un segmento
            </h3>

            {loading ? (
              <LoadingState />
            ) : segmentos.length === 0 ? (
              <EmptyState
                title="Sin segmentos"
                description="Crea segmentos desde la sección de Segmentador"
              />
            ) : (
              <div className="space-y-2">
                {segmentos.map(seg => (
                  <button
                    key={seg.id}
                    onClick={() => { setSelectedSeg(seg); setExportDone(false) }}
                    className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all ${
                      selectedSeg?.id === seg.id
                        ? 'border-brand-500/50 bg-brand-500/10'
                        : 'border-[#253357] hover:border-brand-500/30 hover:bg-white/[0.02]'
                    }`}
                  >
                    <div className="text-left">
                      <p className="text-sm font-medium text-white">{seg.name}</p>
                      {seg.description && (
                        <p className="text-xs text-slate-500">{seg.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-slate-400">
                        {formatNumber(seg.row_count)} RUTs
                      </span>
                      {selectedSeg?.id === seg.id ? (
                        <Check className="w-4 h-4 text-brand-400" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-slate-600" />
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Export options */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-slate-200 mb-4">
              Opciones de exportación
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-2">
                  Formato
                </label>
                <div className="space-y-2">
                  {[
                    { value: 'csv', label: 'CSV', icon: FileText, desc: 'Compatible con Excel' },
                    { value: 'json', label: 'JSON', icon: Table2, desc: 'Para integraciones' },
                  ].map(opt => {
                    const Icon = opt.icon
                    return (
                      <button
                        key={opt.value}
                        onClick={() => setExportFormat(opt.value as 'csv' | 'json')}
                        className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all ${
                          exportFormat === opt.value
                            ? 'border-brand-500/50 bg-brand-500/10'
                            : 'border-[#253357] hover:border-brand-500/30'
                        }`}
                      >
                        <Icon className={`w-4 h-4 ${exportFormat === opt.value ? 'text-brand-400' : 'text-slate-500'}`} />
                        <div className="text-left">
                          <p className="text-sm font-medium text-white">{opt.label}</p>
                          <p className="text-xs text-slate-500">{opt.desc}</p>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>

              {selectedSeg && (
                <div className="p-3 bg-[#111827] rounded-lg border border-[#253357]">
                  <p className="text-xs text-slate-400 mb-1">Segmento seleccionado</p>
                  <p className="text-sm font-medium text-white">{selectedSeg.name}</p>
                  <p className="text-xs text-brand-400 mt-1">
                    ~{formatNumber(selectedSeg.row_count)} registros
                  </p>
                </div>
              )}

              {exportDone && (
                <div className="flex items-center gap-2 p-2.5 bg-green-500/10 border border-green-500/20 rounded-lg">
                  <Check className="w-4 h-4 text-green-400" />
                  <p className="text-xs text-green-400">Descarga iniciada</p>
                </div>
              )}

              <button
                onClick={handleExport}
                disabled={!selectedSeg || exporting}
                className="btn-primary w-full justify-center"
              >
                {exporting ? (
                  <>
                    <Spinner size="sm" />
                    Preparando...
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    Descargar {exportFormat.toUpperCase()}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
