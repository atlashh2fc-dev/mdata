'use client'

import { useMemo, useState } from 'react'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import {
  Check, CircleAlert, Download, FileText, ScanSearch, Table2, Upload,
} from 'lucide-react'
import { Header } from '@/components/layout/Header'
import { EmptyState, Spinner } from '@/components/ui/Spinner'
import {
  BASE_BUILDER_FIELDS,
  type BaseBuilderAnalysisResult,
  type BaseBuilderFieldDefinition,
  type BaseBuilderFieldKey,
} from '@/types/base-builder'
import {
  cn,
  formatCurrency,
  formatNumber,
  formatPercentage,
} from '@/lib/utils/formatters'
import { validateRut } from '@/lib/utils/rut'

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

type ParsedUpload = {
  headers: string[]
  rows: Record<string, string>[]
  detectedRutColumn: string | null
}

function toSafeHeader(value: string, index: number): string {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : `columna_${index + 1}`
}

function ensureUniqueHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>()

  return headers.map((header, index) => {
    const base = toSafeHeader(header, index)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}_${count + 1}`
  })
}

function normalizeColumnName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
}

function looksLikeRutDigits(values: string[]): boolean {
  const sample = values.filter(Boolean).slice(0, 50)
  if (sample.length === 0) return false
  const count = sample.filter(value => /^\d{7,8}$/.test(value)).length
  return count / sample.length >= 0.7
}

function looksLikeFullRut(values: string[]): boolean {
  const sample = values.filter(Boolean).slice(0, 50)
  if (sample.length === 0) return false
  const count = sample.filter(value => validateRut(value)).length
  return count / sample.length >= 0.6
}

function detectBestRutColumn(headers: string[], rows: Record<string, string>[]): string | null {
  let bestHeader: string | null = null
  let bestScore = 0

  for (const header of headers) {
    const normalized = normalizeColumnName(header)
    const values = rows.map(row => String(row[header] ?? '').trim()).filter(Boolean)
    if (values.length === 0) continue

    let score = 0
    if (normalized === 'rut' || normalized === 'rutid' || normalized === 'run') score += 5
    else if (normalized.includes('rut')) score += 3

    if (looksLikeFullRut(values)) score += 4
    if (looksLikeRutDigits(values)) score += 2

    if (score > bestScore) {
      bestScore = score
      bestHeader = header
    }
  }

  return bestScore >= 3 ? bestHeader : null
}

function rowsFromMatrix(matrix: string[][]): ParsedUpload {
  const nonEmptyRows = matrix.filter(row => row.some(cell => String(cell ?? '').trim().length > 0))
  if (nonEmptyRows.length < 2) {
    return { headers: [], rows: [], detectedRutColumn: null }
  }

  const headers = ensureUniqueHeaders(nonEmptyRows[0].map((cell, index) => toSafeHeader(cell, index)))
  const rows = nonEmptyRows.slice(1).map(row => {
    const record: Record<string, string> = {}
    headers.forEach((header, index) => {
      record[header] = String(row[index] ?? '').trim()
    })
    return record
  })

  return {
    headers,
    rows,
    detectedRutColumn: detectBestRutColumn(headers, rows),
  }
}

async function parseUploadedFile(file: File): Promise<ParsedUpload> {
  const lowerName = file.name.toLowerCase()

  if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) {
    const buffer = await file.arrayBuffer()
    const workbook = XLSX.read(buffer, { type: 'array' })
    const firstSheetName = workbook.SheetNames[0]
    const firstSheet = workbook.Sheets[firstSheetName]

    if (!firstSheet) return { headers: [], rows: [], detectedRutColumn: null }

    const matrix = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(firstSheet, {
      header: 1,
      raw: false,
      defval: '',
    }).map(row => row.map(cell => String(cell ?? '').trim()))

    return rowsFromMatrix(matrix)
  }

  const text = await file.text()
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true })

  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors[0]?.message ?? 'No se pudo leer el archivo.')
  }

  const matrix = parsed.data.map(row => row.map(cell => String(cell ?? '').trim()))
  return rowsFromMatrix(matrix)
}

function buildFieldLabelMap() {
  return new Map(BASE_BUILDER_FIELDS.map(field => [field.key, `Maestro - ${field.label}`]))
}

function exportRowsToCsv(
  rows: Record<string, string | number | boolean | null>[],
  originalColumns: string[],
  selectedFields: BaseBuilderFieldKey[]
): string {
  const fieldLabelMap = buildFieldLabelMap()
  const enrichedColumns = selectedFields.map(field => fieldLabelMap.get(field) ?? field)

  const exportRows = rows.map(row => {
    const record: Record<string, string | number | boolean | null> = {}

    for (const column of originalColumns) {
      record[column] = row[column]
    }

    record['RUT Formateado'] = row.rut_formateado
    record['RUT Maestro'] = row.rutid
    record['Estado Match'] = row.match_status

    for (const column of enrichedColumns) {
      record[column] = row[column]
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

function getExportBaseName(fileName?: string | null): string {
  if (!fileName) return 'base-poblada'
  return fileName.replace(/\.[^.]+$/, '')
}

export function PoblarBasePage() {
  const [exportFormat, setExportFormat] = useState<'csv' | 'json'>('csv')
  const [selectedFields, setSelectedFields] = useState<BaseBuilderFieldKey[]>(DEFAULT_FIELDS)
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [parsedUpload, setParsedUpload] = useState<ParsedUpload>({
    headers: [],
    rows: [],
    detectedRutColumn: null,
  })
  const [selectedRutColumn, setSelectedRutColumn] = useState<string>('')
  const [loadingFile, setLoadingFile] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportDone, setExportDone] = useState(false)
  const [analysis, setAnalysis] = useState<BaseBuilderAnalysisResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fieldLabelMap = useMemo(() => buildFieldLabelMap(), [])
  const previewOriginalColumns = analysis?.original_columns.slice(0, 4) ?? parsedUpload.headers.slice(0, 4)
  const previewEnrichedColumns = selectedFields.map(field => fieldLabelMap.get(field) ?? field)

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
      const parsed = await parseUploadedFile(file)
      setUploadedFile(file)
      setParsedUpload(parsed)
      setSelectedRutColumn(parsed.detectedRutColumn ?? parsed.headers[0] ?? '')
    } catch (err) {
      setUploadedFile(null)
      setParsedUpload({ headers: [], rows: [], detectedRutColumn: null })
      setSelectedRutColumn('')
      setError(err instanceof Error ? err.message : 'No se pudo leer el archivo.')
    } finally {
      setLoadingFile(false)
    }
  }

  async function handleAnalyze() {
    if (parsedUpload.rows.length === 0 || !selectedRutColumn) return

    setAnalyzing(true)
    setError(null)
    setExportDone(false)

    try {
      const res = await fetch('/api/base-builder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: parsedUpload.rows,
          rut_column: selectedRutColumn,
          selected_fields: selectedFields,
        }),
      })

      const json = await res.json()
      if (!res.ok) {
        throw new Error(json.error ?? 'No se pudo poblar la base.')
      }

      setAnalysis(json.data ?? null)
    } catch (err) {
      setAnalysis(null)
      setError(err instanceof Error ? err.message : 'No se pudo poblar la base.')
    } finally {
      setAnalyzing(false)
    }
  }

  async function handleExport() {
    if (!analysis) return

    setExporting(true)
    setExportDone(false)

    try {
      const baseName = `${getExportBaseName(uploadedFile?.name)}-poblada`

      if (exportFormat === 'csv') {
        const csv = exportRowsToCsv(analysis.rows, analysis.original_columns, analysis.selected_fields)
        downloadFile(csv, `${baseName}.csv`, 'text/csv;charset=utf-8;')
      } else {
        downloadFile(
          JSON.stringify(analysis.rows, null, 2),
          `${baseName}.json`,
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
        title="Poblar base"
        subtitle="Sube tu archivo, cruza por RUT contra el maestro y exporta la misma base enriquecida"
      />

      <div className="p-6 space-y-5">
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          <div className="xl:col-span-2 card p-5">
            <div className="flex items-center justify-between gap-4 mb-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-200">
                  Poblamiento desde maestro
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Conservamos tus columnas originales y agregamos las variables que elijas del maestro.
                </p>
              </div>
              {uploadedFile && (
                <div className="text-right">
                  <p className="text-xs text-slate-400">{uploadedFile.name}</p>
                  <p className="text-[11px] text-brand-400">
                    {formatNumber(parsedUpload.rows.length)} filas, {formatNumber(parsedUpload.headers.length)} columnas
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
                  {loadingFile ? 'Leyendo archivo...' : 'Subir base para poblar'}
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  CSV o Excel. Detectamos la columna RUT y luego te dejamos elegir qué traer del maestro.
                </p>
              </div>
            </label>

            <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-xl border border-[#253357] bg-[#0b1328] p-4">
                <p className="text-xs font-medium text-slate-400 mb-2">Columna RUT detectada</p>
                <select
                  value={selectedRutColumn}
                  onChange={event => {
                    setSelectedRutColumn(event.target.value)
                    setAnalysis(null)
                    setExportDone(false)
                  }}
                  disabled={parsedUpload.headers.length === 0}
                  className="input-base"
                >
                  {parsedUpload.headers.length === 0 ? (
                    <option value="">Sin columnas detectadas</option>
                  ) : (
                    parsedUpload.headers.map(header => (
                      <option key={header} value={header}>{header}</option>
                    ))
                  )}
                </select>
                <p className="text-xs text-slate-500 mt-2">
                  {parsedUpload.detectedRutColumn
                    ? `Sugerencia automática: ${parsedUpload.detectedRutColumn}`
                    : 'Si la detección no fue correcta, puedes cambiarla aquí.'}
                </p>
              </div>

              <div className="rounded-xl border border-[#253357] bg-[#0b1328] p-4">
                <p className="text-xs font-medium text-slate-400 mb-2">Qué va a salir</p>
                <p className="text-sm text-slate-200">
                  Se exporta tu archivo original más:
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <span className="badge badge-neutral text-[11px] px-2 py-1">Estado Match</span>
                  <span className="badge badge-neutral text-[11px] px-2 py-1">RUT Maestro</span>
                  {selectedFields.slice(0, 4).map(field => (
                    <span key={field} className="badge badge-info text-[11px] px-2 py-1">
                      {BASE_BUILDER_FIELDS.find(item => item.key === field)?.label ?? field}
                    </span>
                  ))}
                  {selectedFields.length > 4 && (
                    <span className="badge badge-neutral text-[11px] px-2 py-1">
                      +{selectedFields.length - 4} más
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h4 className="text-sm font-semibold text-slate-200">
                    Campos a poblar desde maestro
                  </h4>
                  <p className="text-xs text-slate-500 mt-1">
                    Elige qué columnas quieres agregar a tu base al exportar.
                  </p>
                </div>
                <span className="text-xs text-brand-400">
                  {formatNumber(selectedFields.length)} campos seleccionados
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
              Cruce y exportación
            </h3>

            <div className="space-y-4">
              <div className="p-3 bg-[#111827] rounded-lg border border-[#253357]">
                <p className="text-xs text-slate-400 mb-1">Archivo cargado</p>
                <p className="text-sm font-medium text-white">
                  {uploadedFile?.name ?? 'Aún no subes un archivo'}
                </p>
                <p className="text-xs text-brand-400 mt-1">
                  {formatNumber(parsedUpload.rows.length)} filas listas para poblar
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-2">
                  Formato de salida
                </label>
                <div className="space-y-2">
                  {[
                    { value: 'csv', label: 'CSV', icon: FileText, desc: 'Compatible con Excel' },
                    { value: 'json', label: 'JSON', icon: Table2, desc: 'Para integraciones' },
                  ].map(option => {
                    const Icon = option.icon
                    return (
                      <button
                        key={option.value}
                        onClick={() => setExportFormat(option.value as 'csv' | 'json')}
                        className={cn(
                          'w-full flex items-center gap-3 p-3 rounded-lg border transition-all',
                          exportFormat === option.value
                            ? 'border-brand-500/50 bg-brand-500/10'
                            : 'border-[#253357] hover:border-brand-500/30'
                        )}
                      >
                        <Icon className={cn(
                          'w-4 h-4',
                          exportFormat === option.value ? 'text-brand-400' : 'text-slate-500'
                        )} />
                        <div className="text-left">
                          <p className="text-sm font-medium text-white">{option.label}</p>
                          <p className="text-xs text-slate-500">{option.desc}</p>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>

              <button
                onClick={handleAnalyze}
                disabled={parsedUpload.rows.length === 0 || !selectedRutColumn || analyzing}
                className="btn-primary w-full justify-center"
              >
                {analyzing ? (
                  <>
                    <Spinner size="sm" />
                    Cruzando...
                  </>
                ) : (
                  <>
                    <ScanSearch className="w-4 h-4" />
                    Poblar y analizar
                  </>
                )}
              </button>

              {analysis && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-[#253357] bg-[#111827] p-3">
                      <p className="text-[11px] text-slate-500">Cruce exitoso</p>
                      <p className="text-lg font-semibold text-white mt-1">
                        {formatPercentage(analysis.match_rate)}
                      </p>
                    </div>
                    <div className="rounded-lg border border-[#253357] bg-[#111827] p-3">
                      <p className="text-[11px] text-slate-500">Con RUT válido</p>
                      <p className="text-lg font-semibold text-white mt-1">
                        {formatNumber(analysis.valid_rut_count)}
                      </p>
                    </div>
                  </div>
                  <div className="rounded-lg border border-[#253357] bg-[#111827] p-3 text-xs text-slate-400 space-y-1">
                    <div className="flex items-center justify-between">
                      <span>Filas subidas</span>
                      <span className="text-slate-200">{formatNumber(analysis.requested_count)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Cruzaron con maestro</span>
                      <span className="text-slate-200">{formatNumber(analysis.matched_count)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>No cruzaron</span>
                      <span className="text-slate-200">{formatNumber(analysis.unmatched_count)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>RUT inválido</span>
                      <span className="text-slate-200">{formatNumber(analysis.invalid_rut_count)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Duplicados</span>
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
                    Exportando...
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    Descargar base poblada
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
                    Cobertura del poblamiento
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Qué tanto pudimos completar de los campos elegidos sobre tu base.
                  </p>
                </div>
                <p className="text-xs text-slate-400">
                  RUT usado para cruce: {analysis.rut_column ?? '—'}
                </p>
              </div>

              {analysis.coverage.length === 0 ? (
                <EmptyState
                  title="Sin campos extra seleccionados"
                  description="Puedes exportar solo con el estado del match o elegir campos del maestro para poblar."
                />
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {analysis.coverage.map(item => (
                    <div key={item.field} className="rounded-xl border border-[#253357] bg-[#0b1328] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-white">{item.label}</p>
                          <p className="text-xs text-slate-500 mt-1">
                            {formatNumber(item.count)} filas pobladas
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
                          <span>Sobre cruzados</span>
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
                  <h3 className="text-sm font-semibold text-slate-200">Previsualización de salida</h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Vista rápida de cómo sale tu base ya poblada.
                  </p>
                </div>
                <p className="text-xs text-slate-400">
                  {formatNumber(analysis.rows.length)} filas exportables
                </p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-slate-500 border-b border-[#253357]">
                      {previewOriginalColumns.map(column => (
                        <th key={column} className="py-2 pr-3 font-medium">{column}</th>
                      ))}
                      <th className="py-2 pr-3 font-medium">Estado</th>
                      {previewEnrichedColumns.map(column => (
                        <th key={column} className="py-2 pr-3 font-medium">{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.rows.slice(0, 20).map((row, index) => (
                      <tr key={`${row.rut_input}-${index}`} className="border-b border-[#13203d]">
                        {previewOriginalColumns.map(column => (
                          <td key={column} className="py-2 pr-3 text-slate-200">
                            {String(row[column] ?? '—')}
                          </td>
                        ))}
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
                              ? 'Cruzó'
                              : row.match_status === 'not_found'
                                ? 'Sin match'
                                : 'Inválido'}
                          </span>
                        </td>
                        {previewEnrichedColumns.map(column => (
                          <td key={column} className="py-2 pr-3 text-slate-400">
                            {column === 'Maestro - Total avalúos'
                              ? formatCurrency(row[column] !== null && row[column] !== undefined ? Number(row[column]) : null)
                              : typeof row[column] === 'boolean'
                                ? row[column] ? 'Sí' : 'No'
                                : String(row[column] ?? '—')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {analysis.original_columns.length > previewOriginalColumns.length && (
                <p className="text-xs text-slate-500 mt-3">
                  La previsualización muestra {previewOriginalColumns.length} columnas originales de {analysis.original_columns.length}. La descarga incluye todas.
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="card p-5">
            <EmptyState
              title="Todavía no hay poblamiento"
              description="Sube tu base, confirma la columna RUT, elige qué campos del maestro quieres agregar y luego exporta la base enriquecida."
            />
          </div>
        )}
      </div>
    </>
  )
}
