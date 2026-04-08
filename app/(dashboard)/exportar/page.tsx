'use client'

import { useState } from 'react'
import { Header } from '@/components/layout/Header'
import { EmptyState, Spinner } from '@/components/ui/Spinner'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import type {
  BaseBuilderAnalysisResult,
  BaseBuilderExportRow,
  BaseBuilderFieldDefinition,
  BaseBuilderFieldKey,
} from '@/types/base-builder'
import { BASE_BUILDER_FIELDS } from '@/types/base-builder'
import {
  Download, FileText, Table2, Check, Upload, ScanSearch, CircleAlert,
} from 'lucide-react'
import {
  cn,
  formatCurrency,
  formatNumber,
  formatPercentage,
} from '@/lib/utils/formatters'

const DEFAULT_FIELDS: BaseBuilderFieldKey[] = [
  'nombre_completo',
  'email',
  'fono_cel',
  'comuna_canonica',
  'region_canonica',
]

const CATEGORY_LABELS: Record<BaseBuilderFieldDefinition['category'], string> = {
  contacto: 'Contacto',
  identidad: 'Identidad',
  ubicacion: 'Ubicación',
  patrimonio: 'Patrimonio',
  actividad: 'Actividad',
}

function extractBestRutColumn(table: string[][]): string[] {
  const maxCols = table.reduce((max, row) => Math.max(max, row.length), 0)
  let bestColumn: string[] = []
  let bestScore = 0

  const isRutLike = (value: string) => /^\d{1,8}[0-9kK]$/.test(value.replace(/[.\-\s]/g, ''))

  for (let col = 0; col < maxCols; col += 1) {
    const values = table
      .map(row => String(row[col] ?? '').trim())
      .filter(Boolean)

    if (values.length === 0) continue

    const sample = values.slice(0, 200)
    const score = sample.filter(isRutLike).length / sample.length

    if (score > bestScore) {
      bestScore = score
      bestColumn = values
    }
  }

  if (bestScore >= 0.5 && bestColumn.length > 0) {
    return bestColumn
  }

  return table.flatMap(row => row.map(cell => String(cell ?? '').trim()).filter(Boolean))
}

async function parseUploadedFile(file: File): Promise<string[]> {
  const lowerName = file.name.toLowerCase()

  if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) {
    const buffer = await file.arrayBuffer()
    const workbook = XLSX.read(buffer, { type: 'array' })
    const firstSheet = workbook.SheetNames[0]
    const worksheet = workbook.Sheets[firstSheet]
    const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(worksheet, {
      header: 1,
      raw: false,
    })
    const table = rows.map(row => row.map(cell => String(cell ?? '').trim()))
    return extractBestRutColumn(table)
  }

  const text = await file.text()
  const parsed = Papa.parse<string[]>(text, {
    skipEmptyLines: true,
  })

  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors[0]?.message ?? 'No se pudo leer el archivo.')
  }

  return extractBestRutColumn(parsed.data)
}

function exportRowsToCsv(
  rows: BaseBuilderExportRow[],
  selectedFields: BaseBuilderFieldKey[]
): string {
  const fieldLabels = new Map(BASE_BUILDER_FIELDS.map(field => [field.key, field.label]))
  const exportRows = rows.map(row => {
    const record: Record<string, string | number | boolean | null> = {
      RUT_INGRESADO: row.rut_input,
      RUT_FORMATEADO: row.rut_formateado,
      RUTID: row.rutid,
      ESTADO_MATCH: row.match_status,
    }

    for (const field of selectedFields) {
      record[fieldLabels.get(field) ?? field] = row[field]
    }

    return record
  })

  return Papa.unparse(exportRows)
}

function downloadFile(content: BlobPart, fileName: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

export default function ExportarPage() {
  const [exportFormat, setExportFormat] = useState<'csv' | 'json'>('csv')
  const [selectedFields, setSelectedFields] = useState<BaseBuilderFieldKey[]>(DEFAULT_FIELDS)
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [rutCandidates, setRutCandidates] = useState<string[]>([])
  const [loadingFile, setLoadingFile] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportDone, setExportDone] = useState(false)
  const [analysis, setAnalysis] = useState<BaseBuilderAnalysisResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  function toggleField(field: BaseBuilderFieldKey) {
    setExportDone(false)
    setAnalysis(null)
    setSelectedFields(prev => (
      prev.includes(field)
        ? prev.filter(item => item !== field)
        : [...prev, field]
    ))
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setLoadingFile(true)
    setError(null)
    setAnalysis(null)
    setExportDone(false)

    try {
      const values = await parseUploadedFile(file)
      const cleanedValues = values.filter(Boolean)
      setUploadedFile(file)
      setRutCandidates(cleanedValues)
    } catch (err) {
      setUploadedFile(null)
      setRutCandidates([])
      setError(err instanceof Error ? err.message : 'No se pudo leer el archivo.')
    } finally {
      setLoadingFile(false)
    }
  }

  async function handleAnalyze() {
    if (rutCandidates.length === 0 || selectedFields.length === 0) return

    setAnalyzing(true)
    setError(null)
    setExportDone(false)

    try {
      const res = await fetch('/api/base-builder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ruts: rutCandidates,
          selected_fields: selectedFields,
        }),
      })

      const json = await res.json()
      if (!res.ok) {
        throw new Error(json.error ?? 'No se pudo analizar la base.')
      }

      setAnalysis(json.data ?? null)
    } catch (err) {
      setAnalysis(null)
      setError(err instanceof Error ? err.message : 'No se pudo analizar la base.')
    } finally {
      setAnalyzing(false)
    }
  }

  async function handleExport() {
    if (!analysis) return

    setExporting(true)
    setExportDone(false)

    try {
      if (exportFormat === 'csv') {
        const csv = exportRowsToCsv(analysis.rows, analysis.selected_fields)
        downloadFile(csv, 'base-enriquecida.csv', 'text/csv;charset=utf-8;')
      } else {
        downloadFile(
          JSON.stringify(analysis.rows, null, 2),
          'base-enriquecida.json',
          'application/json'
        )
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
        subtitle="Sube una lista de RUTs, mide cobertura por variable y descarga la base enriquecida"
      />

      <div className="p-6 space-y-5">
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          <div className="xl:col-span-2 card p-5">
            <div className="flex items-center justify-between gap-4 mb-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-200">
                  Constructor de base por RUT
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Acepta CSV, TXT y Excel. Detectamos automáticamente la columna con RUTs.
                </p>
              </div>
              {uploadedFile && (
                <div className="text-right">
                  <p className="text-xs text-slate-400">{uploadedFile.name}</p>
                  <p className="text-[11px] text-brand-400">
                    {formatNumber(rutCandidates.length)} valores detectados
                  </p>
                </div>
              )}
            </div>

            <label className="flex items-center justify-center gap-3 rounded-xl border border-dashed border-[#334155] bg-[#0b1328] px-4 py-8 text-center hover:border-brand-500/40 hover:bg-white/[0.02] transition-all cursor-pointer">
              <input
                type="file"
                accept=".csv,.txt,.xlsx,.xls"
                onChange={handleFileChange}
                className="hidden"
              />
              {loadingFile ? (
                <Spinner size="sm" />
              ) : (
                <Upload className="w-5 h-5 text-brand-400" />
              )}
              <div>
                <p className="text-sm font-medium text-white">
                  {loadingFile ? 'Leyendo archivo...' : 'Subir archivo con RUTs'}
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  Puedes traer solo RUT o una tabla completa. Usaremos la mejor columna detectada.
                </p>
              </div>
            </label>

            <div className="mt-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h4 className="text-sm font-semibold text-slate-200">
                    Variables a incluir
                  </h4>
                  <p className="text-xs text-slate-500 mt-1">
                    Elige exactamente qué columnas quieres analizar y exportar.
                  </p>
                </div>
                <span className="text-xs text-brand-400">
                  {formatNumber(selectedFields.length)} variables seleccionadas
                </span>
              </div>

              <div className="space-y-4">
                {(['identidad', 'contacto', 'ubicacion', 'patrimonio', 'actividad'] as const).map(category => (
                  <div key={category}>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-slate-600 mb-2">
                      {CATEGORY_LABELS[category]}
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {BASE_BUILDER_FIELDS
                        .filter(field => field.category === category)
                        .map(field => {
                          const active = selectedFields.includes(field.key)
                          return (
                            <button
                              key={field.key}
                              onClick={() => toggleField(field.key)}
                              className={cn(
                                'text-left rounded-xl border p-3 transition-all',
                                active
                                  ? 'border-brand-500/40 bg-brand-500/10'
                                  : 'border-[#253357] hover:border-brand-500/30 hover:bg-white/[0.02]'
                              )}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-medium text-white">{field.label}</p>
                                  <p className="text-xs text-slate-500 mt-1">{field.description}</p>
                                </div>
                                {active && <Check className="w-4 h-4 text-brand-400 flex-shrink-0 mt-0.5" />}
                              </div>
                            </button>
                          )
                        })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="card p-5">
            <h3 className="text-sm font-semibold text-slate-200 mb-4">
              Análisis y exportación
            </h3>

            <div className="space-y-4">
              <div className="p-3 bg-[#111827] rounded-lg border border-[#253357]">
                <p className="text-xs text-slate-400 mb-1">Archivo cargado</p>
                <p className="text-sm font-medium text-white">
                  {uploadedFile?.name ?? 'Aún no subes un archivo'}
                </p>
                <p className="text-xs text-brand-400 mt-1">
                  {formatNumber(rutCandidates.length)} candidatos a RUT detectados
                </p>
              </div>

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

              <button
                onClick={handleAnalyze}
                disabled={rutCandidates.length === 0 || selectedFields.length === 0 || analyzing}
                className="btn-primary w-full justify-center"
              >
                {analyzing ? (
                  <>
                    <Spinner size="sm" />
                    Analizando...
                  </>
                ) : (
                  <>
                    <ScanSearch className="w-4 h-4" />
                    Analizar cobertura
                  </>
                )}
              </button>

              {analysis && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-[#253357] bg-[#111827] p-3">
                      <p className="text-[11px] text-slate-500">RUTs válidos</p>
                      <p className="text-lg font-semibold text-white mt-1">
                        {formatNumber(analysis.valid_rut_count)}
                      </p>
                    </div>
                    <div className="rounded-lg border border-[#253357] bg-[#111827] p-3">
                      <p className="text-[11px] text-slate-500">Match en master</p>
                      <p className="text-lg font-semibold text-white mt-1">
                        {formatPercentage(analysis.match_rate)}
                      </p>
                    </div>
                  </div>
                  <div className="rounded-lg border border-[#253357] bg-[#111827] p-3 text-xs text-slate-400 space-y-1">
                    <div className="flex items-center justify-between">
                      <span>Encontrados</span>
                      <span className="text-slate-200">{formatNumber(analysis.matched_count)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>No encontrados</span>
                      <span className="text-slate-200">{formatNumber(analysis.unmatched_count)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Inválidos</span>
                      <span className="text-slate-200">{formatNumber(analysis.invalid_rut_count)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Duplicados removidos</span>
                      <span className="text-slate-200">{formatNumber(analysis.duplicate_count)}</span>
                    </div>
                  </div>
                </div>
              )}

              {error && (
                <div className="flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                  <CircleAlert className="w-4 h-4 text-amber-400 mt-0.5" />
                  <p className="text-xs text-amber-300">{error}</p>
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
                disabled={!analysis || exporting}
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

        {analysis ? (
          <>
            <div className="card p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-semibold text-slate-200">
                    Cobertura de variables sobre la base subida
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Mostramos cobertura sobre RUTs válidos y también sobre los RUTs encontrados.
                  </p>
                </div>
                <p className="text-xs text-slate-400">
                  {formatNumber(analysis.unique_count)} registros únicos analizados
                </p>
              </div>

              {analysis.coverage.length === 0 ? (
                <EmptyState
                  title="Sin variables seleccionadas"
                  description="Elige al menos una variable para medir cobertura y exportarla."
                />
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {analysis.coverage.map(item => (
                    <div key={item.field} className="rounded-xl border border-[#253357] bg-[#0b1328] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-white">{item.label}</p>
                          <p className="text-xs text-slate-500 mt-1">
                            {formatNumber(item.count)} con dato
                          </p>
                        </div>
                        <span className="text-sm font-semibold text-brand-400">
                          {formatPercentage(item.pct)}
                        </span>
                      </div>
                      <div className="mt-3 h-2 rounded-full bg-[#111827] overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-cyan-500 to-brand-500"
                          style={{ width: `${Math.min(item.pct, 100)}%` }}
                        />
                      </div>
                      <div className="mt-3 text-[11px] text-slate-500 space-y-1">
                        <div className="flex items-center justify-between">
                          <span>Sobre válidos</span>
                          <span>{formatNumber(item.count)} / {formatNumber(item.total)}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Sobre encontrados</span>
                          <span>{formatPercentage(item.matched_pct)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-semibold text-slate-200">Previsualización</h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Vista rápida de los primeros registros que saldrán en la exportación.
                  </p>
                </div>
                <p className="text-xs text-slate-400">
                  {formatNumber(analysis.rows.length)} filas listas para descargar
                </p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-slate-500 border-b border-[#253357]">
                      <th className="py-2 pr-3 font-medium">RUT</th>
                      <th className="py-2 pr-3 font-medium">Estado</th>
                      {analysis.selected_fields.map(field => (
                        <th key={field} className="py-2 pr-3 font-medium">
                          {BASE_BUILDER_FIELDS.find(item => item.key === field)?.label ?? field}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.rows.slice(0, 20).map((row, index) => (
                      <tr key={`${row.rut_input}-${index}`} className="border-b border-[#13203d]">
                        <td className="py-2 pr-3 text-slate-200">{row.rut_formateado}</td>
                        <td className="py-2 pr-3">
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full px-2 py-1 text-[10px] font-medium',
                              row.match_status === 'matched'
                                ? 'bg-green-500/10 text-green-300'
                                : row.match_status === 'not_found'
                                  ? 'bg-amber-500/10 text-amber-300'
                                  : 'bg-rose-500/10 text-rose-300'
                            )}
                          >
                            {row.match_status === 'matched'
                              ? 'Encontrado'
                              : row.match_status === 'not_found'
                                ? 'No encontrado'
                                : 'Inválido'}
                          </span>
                        </td>
                        {analysis.selected_fields.map(field => (
                          <td key={field} className="py-2 pr-3 text-slate-400">
                            {typeof row[field] === 'boolean'
                              ? row[field] ? 'Sí' : 'No'
                              : field === 'totalavaluos'
                                ? formatCurrency(
                                    row[field] !== null && row[field] !== undefined
                                      ? Number(row[field])
                                      : null
                                  )
                                : String(row[field] ?? '—')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : (
          <div className="card p-5">
            <EmptyState
              title="Todavía no hay análisis"
              description="Sube una base de RUTs, elige variables y ejecuta el análisis para ver cobertura y descargar la base final."
            />
          </div>
        )}
      </div>
    </>
  )
}
