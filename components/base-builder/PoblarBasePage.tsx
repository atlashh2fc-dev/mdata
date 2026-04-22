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
  type BaseBuilderExportRow,
  type BaseBuilderFieldDefinition,
  type BaseBuilderFieldKey,
  type BaseBuilderMatchMode,
  type BaseBuilderWebEnrichmentResult,
} from '@/types/base-builder'
import type { CommercialRutSummary } from '@/types'
import {
  cn,
  formatCurrency,
  formatNumber,
  formatPercentage,
} from '@/lib/utils/formatters'
import { validateRut } from '@/lib/utils/rut'

const PERSON_DEFAULT_FIELDS: BaseBuilderFieldKey[] = [
  'nombre_completo',
  'email',
  'fono_cel',
  'comuna_canonica',
  'region_canonica',
]

const COMPANY_DEFAULT_FIELDS: BaseBuilderFieldKey[] = [
  'razon_social_empresa',
  'email',
  'fono_cel',
  'comuna_canonica',
  'region_canonica',
]

const MAX_AUTO_WEB_PASSES = 50
const CRM_EXPORT_COLUMNS = [
  'CRM - Tiene historial',
  'CRM - Última gestión',
  'CRM - Último resultado',
  'CRM - Subresultado',
  'CRM - Último canal',
  'CRM - Último agente',
  'CRM - Última campaña',
  'CRM - Último contacto',
  'CRM - Última venta',
  'CRM - Total gestiones',
  'CRM - Contactos efectivos',
  'CRM - Intereses',
  'CRM - Callbacks',
  'CRM - Ventas',
  'CRM - Próxima acción',
  'CRM - Prioridad',
  'CRM - Canal sugerido',
  'CRM - Mejor hora',
  'CRM - Mejor teléfono',
  'CRM - Mejor email',
] as const

type AnalyzeProgress = {
  pass: number
  totalCandidates: number | null
  processed: number
  attempted: number
  fromCache: number
  limited: boolean
}

function emptyProviderMetrics(): NonNullable<BaseBuilderWebEnrichmentResult['providers']> {
  return {
    brave: 0,
    duckduckgo: 0,
    bing: 0,
    none: 0,
    error: 0,
  }
}

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
  detectedPersonNameColumn: string | null
  detectedCompanyColumn: string | null
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

function inferColumnHeader(values: string[], index: number): string {
  const sample = values
    .map(value => String(value ?? '').trim())
    .filter(Boolean)
    .slice(0, 100)

  if (sample.length > 0) {
    const rutLike = sample.filter(value => validateRut(value)).length / sample.length
    if (rutLike >= 0.6) return 'RUT'

    const emailLike = sample.filter(value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)).length / sample.length
    if (emailLike >= 0.6) return 'Email'

    const codeLike = sample.filter(value => /^\d+(?:-\d+)+$/.test(value)).length / sample.length
    if (codeLike >= 0.6) return 'Código'

    const addressLike = sample.filter(value => (
      /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(value) &&
      /\d/.test(value) &&
      value.length >= 8
    )).length / sample.length
    if (addressLike >= 0.5) return 'Dirección'

    const activityLike = sample.filter(looksLikeActivityValue).length / sample.length
    if (activityLike >= 0.5) return 'Giro'

    const companyOrPersonLike = sample.filter(value => (
      looksLikeCompanyValue(value) || looksLikePersonNameValue(value)
    )).length / sample.length
    if (companyOrPersonLike >= 0.5) return 'Nombre / razón social'

    const textLike = sample.filter(value => (
      /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(value) &&
      !/\d/.test(value) &&
      value.length >= 5
    )).length / sample.length
    if (textLike >= 0.6) return 'Giro'
  }

  return `Columna ${index + 1}`
}

function normalizeColumnName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
}

function looksLikeHeaderCell(value: string): boolean {
  const normalized = normalizeColumnName(value)
  if (!normalized) return false
  if (validateRut(value)) return false

  return [
    'rut',
    'run',
    'dv',
    'nombre',
    'razon',
    'empresa',
    'direccion',
    'domicilio',
    'giro',
    'rubro',
    'actividad',
    'comuna',
    'region',
    'email',
    'correo',
    'telefono',
    'fono',
    'celular',
    'codigo',
    'id',
  ].some(token => normalized === token || normalized.includes(token))
}

function looksLikeDataCell(value: string): boolean {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return false
  if (validateRut(trimmed)) return true
  if (/^\d+(?:-\d+)+$/.test(trimmed)) return true
  if (looksLikeCompanyValue(trimmed) || looksLikePersonNameValue(trimmed)) return true

  return /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(trimmed) &&
    /\d/.test(trimmed) &&
    trimmed.length >= 8
}

function matrixHasHeaderRow(rows: string[][]): boolean {
  const firstRow = rows[0] ?? []
  const secondRow = rows[1] ?? []
  const firstNonEmpty = firstRow.filter(cell => String(cell ?? '').trim().length > 0)
  if (firstNonEmpty.length === 0) return false

  const headerSignals = firstNonEmpty.filter(looksLikeHeaderCell).length
  const firstDataSignals = firstNonEmpty.filter(looksLikeDataCell).length
  const secondDataSignals = secondRow.filter(looksLikeDataCell).length

  if (firstNonEmpty.some(cell => validateRut(cell))) return false
  if (headerSignals >= 2 && firstDataSignals <= 1) return true
  if (headerSignals >= Math.ceil(firstNonEmpty.length * 0.5)) return true
  if (firstDataSignals >= 2 && secondDataSignals >= 2) return false

  return true
}

function looksLikeActivityValue(value: string): boolean {
  const normalized = normalizeColumnName(value)
  if (!normalized) return false
  if (validateRut(value)) return false
  if (looksLikeCompanyValue(value)) return false

  return [
    'imprenta',
    'importacion',
    'exportacion',
    'fabrica',
    'fca',
    'planta',
    'reciclaje',
    'relleno',
    'sanitario',
    'packing',
    'paking',
    'taller',
    'barraca',
    'distribucion',
    'pintura',
    'funebre',
    'agricola',
  ].some(token => normalized.includes(token))
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

function scoreRutColumn(header: string, rows: Record<string, string>[]): number {
  const normalized = normalizeColumnName(header)
  const values = rows.map(row => String(row[header] ?? '').trim()).filter(Boolean)
  if (values.length === 0) return 0

  let score = 0
  if (normalized === 'rut' || normalized === 'rutid' || normalized === 'run') score += 5
  else if (normalized.includes('rut')) score += 3

  if (looksLikeFullRut(values)) score += 4
  if (looksLikeRutDigits(values)) score += 2

  return score
}

function detectBestRutColumn(headers: string[], rows: Record<string, string>[]): string | null {
  let bestHeader: string | null = null
  let bestScore = 0

  for (const header of headers) {
    const score = scoreRutColumn(header, rows)
    if (score > bestScore) {
      bestScore = score
      bestHeader = header
    }
  }

  return bestScore >= 3 ? bestHeader : null
}

function looksLikeSupportedRutColumn(header: string, rows: Record<string, string>[]): boolean {
  return scoreRutColumn(header, rows) >= 2
}

function looksLikeCompanyValue(value: string): boolean {
  const normalized = String(value ?? '').trim()
  if (!normalized) return false
  if (validateRut(normalized)) return false
  return /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(normalized) &&
    normalized.length >= 5 &&
    /\b(SPA|S\.P\.A|LTDA|LIMITADA|S\.A|SA|EIRL|EMPRESA|COMERCIAL|SOCIEDAD|INVERSIONES)\b/i.test(normalized)
}

function scoreCompanyColumn(header: string, rows: Record<string, string>[]): number {
  const normalized = normalizeColumnName(header)
  const values = rows.map(row => String(row[header] ?? '').trim()).filter(Boolean)
  if (values.length === 0) return 0

  let score = 0
  if (
    normalized === 'razonsocial' ||
    normalized === 'razonsocialempresa' ||
    normalized === 'empresa' ||
    normalized === 'nombreempresa'
  ) score += 5
  else if (
    normalized.includes('razonsocial') ||
    normalized.includes('empresa') ||
    normalized.includes('social')
  ) score += 3

  const sample = values.slice(0, 50)
  const companyLikeCount = sample.filter(looksLikeCompanyValue).length
  if (sample.length > 0 && companyLikeCount / sample.length >= 0.7) score += 3

  return score
}

function detectBestCompanyColumn(headers: string[], rows: Record<string, string>[]): string | null {
  let bestHeader: string | null = null
  let bestScore = 0

  for (const header of headers) {
    const score = scoreCompanyColumn(header, rows)
    if (score > bestScore) {
      bestScore = score
      bestHeader = header
    }
  }

  return bestScore >= 3 ? bestHeader : null
}

function looksLikeSupportedCompanyColumn(header: string, rows: Record<string, string>[]): boolean {
  return scoreCompanyColumn(header, rows) >= 2
}

function looksLikePersonNameValue(value: string): boolean {
  const normalized = String(value ?? '').trim()
  if (!normalized) return false
  if (validateRut(normalized)) return false
  if (normalized.includes('@')) return false
  if (looksLikeCompanyValue(normalized)) return false

  const words = normalized
    .split(/\s+/)
    .filter(word => /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(word))

  return words.length >= 2 && normalized.length >= 5
}

function scorePersonNameColumn(header: string, rows: Record<string, string>[]): number {
  const normalized = normalizeColumnName(header)
  const values = rows.map(row => String(row[header] ?? '').trim()).filter(Boolean)
  if (values.length === 0) return 0

  let score = 0
  if (
    normalized === 'nombre' ||
    normalized === 'nombres' ||
    normalized === 'nombrecompleto' ||
    normalized === 'persona' ||
    normalized === 'cliente' ||
    normalized === 'titular' ||
    normalized === 'propietario'
  ) score += 5
  else if (
    normalized.includes('nombre') ||
    normalized.includes('persona') ||
    normalized.includes('cliente') ||
    normalized.includes('titular') ||
    normalized.includes('propietario')
  ) score += 3

  const sample = values.slice(0, 50)
  const personLikeCount = sample.filter(looksLikePersonNameValue).length
  if (sample.length > 0 && personLikeCount / sample.length >= 0.6) score += 3

  return score
}

function detectBestPersonNameColumn(headers: string[], rows: Record<string, string>[]): string | null {
  let bestHeader: string | null = null
  let bestScore = 0

  for (const header of headers) {
    const score = scorePersonNameColumn(header, rows)
    if (score > bestScore) {
      bestScore = score
      bestHeader = header
    }
  }

  return bestScore >= 3 ? bestHeader : null
}

function looksLikeSupportedPersonNameColumn(header: string, rows: Record<string, string>[]): boolean {
  return scorePersonNameColumn(header, rows) >= 2
}

function findLikelyDvColumn(headers: string[], rutColumnName: string): string | null {
  const rutKey = normalizeColumnName(rutColumnName)

  for (const header of headers) {
    const normalized = normalizeColumnName(header)
    if (normalized === rutKey) continue

    if (
      normalized === 'dv' ||
      normalized === 'digitoverificador' ||
      normalized === 'digverificador' ||
      normalized === 'verificador'
    ) {
      return header
    }
  }

  return null
}

function rowsFromMatrix(matrix: string[][]): ParsedUpload {
  const nonEmptyRows = matrix.filter(row => row.some(cell => String(cell ?? '').trim().length > 0))
  if (nonEmptyRows.length < 2) {
    return {
      headers: [],
      rows: [],
      detectedRutColumn: null,
      detectedPersonNameColumn: null,
      detectedCompanyColumn: null,
    }
  }

  const hasHeaderRow = matrixHasHeaderRow(nonEmptyRows)
  const dataRows = hasHeaderRow ? nonEmptyRows.slice(1) : nonEmptyRows
  const maxColumnCount = Math.max(...nonEmptyRows.map(row => row.length))
  const headerSource = hasHeaderRow
    ? nonEmptyRows[0].map((cell, index) => toSafeHeader(cell, index))
    : Array.from({ length: maxColumnCount }, (_, index) => (
        inferColumnHeader(nonEmptyRows.map(row => row[index] ?? ''), index)
      ))
  const headers = ensureUniqueHeaders(headerSource)
  const rows = dataRows.map(row => {
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
    detectedPersonNameColumn: detectBestPersonNameColumn(headers, rows),
    detectedCompanyColumn: detectBestCompanyColumn(headers, rows),
  }
}

async function parseUploadedFile(file: File): Promise<ParsedUpload> {
  const lowerName = file.name.toLowerCase()

  if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) {
    const buffer = await file.arrayBuffer()
    const workbook = XLSX.read(buffer, { type: 'array' })
    const firstSheetName = workbook.SheetNames[0]
    const firstSheet = workbook.Sheets[firstSheetName]

    if (!firstSheet) {
      return {
        headers: [],
        rows: [],
        detectedRutColumn: null,
        detectedPersonNameColumn: null,
        detectedCompanyColumn: null,
      }
    }

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
  selectedFields: BaseBuilderFieldKey[],
  extraColumns: string[] = []
): string {
  const fieldLabelMap = buildFieldLabelMap()
  const enrichedColumns = selectedFields.map(field => fieldLabelMap.get(field) ?? field)
  const includeEmailSource = rows.some(row => isPresentForExport(row['Fuente Email']))
  const includePhoneSource = rows.some(row => isPresentForExport(row['Fuente Teléfono']))
  const includeWebsite = rows.some(row => isPresentForExport(row['Web - Sitio']))

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

    if (includeEmailSource) record['Fuente Email'] = row['Fuente Email']
    if (includePhoneSource) record['Fuente Teléfono'] = row['Fuente Teléfono']
    if (includeWebsite) record['Web - Sitio'] = row['Web - Sitio']
    for (const column of extraColumns) {
      record[column] = row[column]
    }

    return record
  })

  return Papa.unparse(exportRows)
}

function isPresentForExport(value: string | number | boolean | null | undefined): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  return true
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

function formatHour(hour: number | null | undefined): string {
  if (hour === null || hour === undefined || !Number.isFinite(hour)) return ''
  const normalized = ((Math.round(hour) % 24) + 24) % 24
  return `${String(normalized).padStart(2, '0')}:00`
}

type CrmSummaryApiResponse = {
  success?: boolean
  data?: CommercialRutSummary[]
  error?: string
  message?: string
}

async function readCrmSummaryResponse(res: Response): Promise<CrmSummaryApiResponse> {
  const raw = await res.text()
  const body = raw.trim()

  if (!body) {
    return {
      success: false,
      error: `El CRM devolvió una respuesta vacía (HTTP ${res.status}).`,
    }
  }

  try {
    return JSON.parse(body) as CrmSummaryApiResponse
  } catch {
    return {
      success: false,
      error: res.ok
        ? 'El CRM devolvió una respuesta inválida.'
        : body.slice(0, 300) || `No se pudo actualizar la exportación contra el CRM (HTTP ${res.status}).`,
    }
  }
}

async function fetchCrmSummariesForRows(rows: BaseBuilderExportRow[]) {
  const rutids = [...new Set(
    rows
      .map(row => row.rutid)
      .filter((rutid): rutid is string => Boolean(rutid))
  )]

  if (!rutids.length) {
    return new Map<string, CommercialRutSummary>()
  }

  const res = await fetch('/api/commercial-intelligence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'summary',
      rutids,
    }),
  })

  const json = await readCrmSummaryResponse(res)

  if (!res.ok || !json.success) {
    throw new Error(json.error ?? json.message ?? 'No se pudo actualizar la exportación contra el CRM.')
  }

  const items = Array.isArray(json.data) ? json.data : []
  return new Map(items.map(item => [item.rutid, item]))
}

function attachCrmSummaryToRows(
  rows: BaseBuilderExportRow[],
  crmSummaryMap: Map<string, CommercialRutSummary>
): BaseBuilderExportRow[] {
  return rows.map(row => {
    const summary = row.rutid ? crmSummaryMap.get(row.rutid) : undefined

    return {
      ...row,
      'CRM - Tiene historial': summary?.feedback_coverage ? 'Sí' : 'No',
      'CRM - Última gestión': summary?.latest_managed_at ?? summary?.last_feedback_at ?? null,
      'CRM - Último resultado': summary?.latest_outcome ?? null,
      'CRM - Subresultado': summary?.latest_outcome_subtype ?? null,
      'CRM - Último canal': summary?.latest_channel ?? null,
      'CRM - Último agente': summary?.latest_agent_name ?? null,
      'CRM - Última campaña': summary?.latest_campaign_name ?? null,
      'CRM - Último contacto': summary?.last_contact_at ?? null,
      'CRM - Última venta': summary?.last_sale_at ?? null,
      'CRM - Total gestiones': summary?.total_interactions ?? null,
      'CRM - Contactos efectivos': summary?.effective_contacts ?? null,
      'CRM - Intereses': summary?.interest_events ?? null,
      'CRM - Callbacks': summary?.callback_events ?? null,
      'CRM - Ventas': summary?.sales_events ?? null,
      'CRM - Próxima acción': summary?.next_best_action ?? null,
      'CRM - Prioridad': summary?.action_priority ?? null,
      'CRM - Canal sugerido': summary?.best_channel ?? null,
      'CRM - Mejor hora': formatHour(summary?.best_contact_hour),
      'CRM - Mejor teléfono': summary?.best_phone ?? null,
      'CRM - Mejor email': summary?.best_email ?? null,
    }
  })
}

function getExportBaseName(fileName?: string | null): string {
  if (!fileName) return 'base-poblada'
  return fileName.replace(/\.[^.]+$/, '')
}

function getCoverageTone(pct: number): string {
  if (pct >= 70) return 'text-green-300'
  if (pct >= 40) return 'text-amber-300'
  return 'text-slate-300'
}

export function PoblarBasePage() {
  const [exportFormat, setExportFormat] = useState<'csv' | 'json'>('csv')
  const [selectedMatchMode, setSelectedMatchMode] = useState<BaseBuilderMatchMode>('rut')
  const [enrichMissingContactsWithWeb, setEnrichMissingContactsWithWeb] = useState(false)
  const [selectedFields, setSelectedFields] = useState<BaseBuilderFieldKey[]>(PERSON_DEFAULT_FIELDS)
  const [didCustomizeFields, setDidCustomizeFields] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [parsedUpload, setParsedUpload] = useState<ParsedUpload>({
    headers: [],
    rows: [],
    detectedRutColumn: null,
    detectedPersonNameColumn: null,
    detectedCompanyColumn: null,
  })
  const [selectedMatchColumn, setSelectedMatchColumn] = useState<string>('')
  const [loadingFile, setLoadingFile] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeStatus, setAnalyzeStatus] = useState<string>('Cruzando...')
  const [analyzeProgress, setAnalyzeProgress] = useState<AnalyzeProgress | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportStatus, setExportStatus] = useState<string>('Exportando...')
  const [exportDone, setExportDone] = useState(false)
  const [analysis, setAnalysis] = useState<BaseBuilderAnalysisResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fieldLabelMap = useMemo(() => buildFieldLabelMap(), [])
  const previewOriginalColumns = analysis?.original_columns.slice(0, 4) ?? parsedUpload.headers.slice(0, 4)
  const previewEnrichedColumns = selectedFields.map(field => fieldLabelMap.get(field) ?? field)
  const contactFieldSelected = selectedFields.includes('email') || selectedFields.includes('fono_cel')
  const selectedColumnLooksLikeRut = selectedMatchColumn
    ? looksLikeSupportedRutColumn(selectedMatchColumn, parsedUpload.rows)
    : false
  const selectedColumnLooksLikeCompany = selectedMatchColumn
    ? looksLikeSupportedCompanyColumn(selectedMatchColumn, parsedUpload.rows)
    : false
  const selectedColumnLooksLikePersonName = selectedMatchColumn
    ? looksLikeSupportedPersonNameColumn(selectedMatchColumn, parsedUpload.rows)
    : false
  const selectedDvColumn = selectedMatchColumn
    ? findLikelyDvColumn(parsedUpload.headers, selectedMatchColumn)
    : null
  const selectedColumnIsValid = selectedMatchMode === 'rut'
    ? selectedColumnLooksLikeRut
    : selectedMatchMode === 'nombre_persona'
      ? selectedColumnLooksLikePersonName
      : selectedColumnLooksLikeCompany
  const detectedColumnForMode = selectedMatchMode === 'rut'
    ? parsedUpload.detectedRutColumn
    : selectedMatchMode === 'nombre_persona'
      ? parsedUpload.detectedPersonNameColumn
      : parsedUpload.detectedCompanyColumn
  const webEnrichmentAvailable = selectedMatchMode !== 'nombre_persona'

  function getMatchModeLabel(mode: BaseBuilderMatchMode) {
    if (mode === 'rut') return 'RUT'
    if (mode === 'nombre_persona') return 'nombre'
    return 'razón social'
  }

  function resetAnalysisState() {
    setAnalysis(null)
    setExportDone(false)
    setError(null)
    setAnalyzeProgress(null)
  }

  function toggleField(field: BaseBuilderFieldKey) {
    setExportDone(false)
    setAnalysis(null)
    setDidCustomizeFields(true)
    setSelectedFields(prev => (
      prev.includes(field)
        ? prev.filter(item => item !== field)
        : [...prev, field]
    ))
  }

  function applyMatchMode(mode: BaseBuilderMatchMode, upload: ParsedUpload = parsedUpload) {
    setSelectedMatchMode(mode)
    setSelectedMatchColumn(
      mode === 'rut'
        ? upload.detectedRutColumn ?? ''
        : mode === 'nombre_persona'
          ? upload.detectedPersonNameColumn ?? ''
          : upload.detectedCompanyColumn ?? ''
    )
    resetAnalysisState()
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
      const nextMode: BaseBuilderMatchMode = parsed.detectedRutColumn
        ? 'rut'
        : parsed.detectedPersonNameColumn
          ? 'nombre_persona'
          : 'razon_social'
      setUploadedFile(file)
      setParsedUpload(parsed)
      if (!didCustomizeFields) {
        setSelectedFields(nextMode === 'razon_social' ? COMPANY_DEFAULT_FIELDS : PERSON_DEFAULT_FIELDS)
      }
      setSelectedMatchMode(nextMode)
      setSelectedMatchColumn(
        nextMode === 'rut'
          ? parsed.detectedRutColumn ?? ''
          : nextMode === 'nombre_persona'
            ? parsed.detectedPersonNameColumn ?? ''
            : parsed.detectedCompanyColumn ?? ''
      )
    } catch (err) {
      setUploadedFile(null)
      setParsedUpload({
        headers: [],
        rows: [],
        detectedRutColumn: null,
        detectedPersonNameColumn: null,
        detectedCompanyColumn: null,
      })
      setSelectedMatchColumn('')
      setError(err instanceof Error ? err.message : 'No se pudo leer el archivo.')
    } finally {
      setLoadingFile(false)
    }
  }

  async function handleAnalyze() {
    if (parsedUpload.rows.length === 0 || !selectedMatchColumn) return

    if (!selectedColumnIsValid) {
      setAnalysis(null)
      setError(
        selectedMatchMode === 'rut'
          ? 'La columna seleccionada no parece contener RUTs válidos.'
          : selectedMatchMode === 'nombre_persona'
            ? 'La columna seleccionada no parece contener nombres de personas utilizables para cruzar.'
            : 'La columna seleccionada no parece contener razones sociales utilizables para cruzar.'
      )
      return
    }

    setAnalyzing(true)
    setAnalyzeStatus('Cruzando...')
    setAnalyzeProgress(
      enrichMissingContactsWithWeb
        ? {
            pass: 0,
            totalCandidates: null,
            processed: 0,
            attempted: 0,
            fromCache: 0,
            limited: false,
          }
        : null
    )
    setError(null)
    setExportDone(false)

    try {
      const companyColumnForPayload = selectedMatchMode === 'rut'
        ? parsedUpload.detectedCompanyColumn
        : selectedMatchMode === 'razon_social'
          ? selectedMatchColumn
          : null

      const compactRows = parsedUpload.rows.map(row => {
        const compactRow: Record<string, string> = {
          [selectedMatchColumn]: String(row[selectedMatchColumn] ?? ''),
        }

        if (selectedMatchMode === 'rut' && selectedDvColumn) {
          compactRow[selectedDvColumn] = String(row[selectedDvColumn] ?? '')
        }

        if (
          companyColumnForPayload &&
          companyColumnForPayload !== selectedMatchColumn &&
          companyColumnForPayload !== selectedDvColumn
        ) {
          compactRow[companyColumnForPayload] = String(row[companyColumnForPayload] ?? '')
        }

        return compactRow
      })

      async function runAnalysisPass() {
        const res = await fetch('/api/base-builder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rows: compactRows,
            match_mode: selectedMatchMode,
            match_column: selectedMatchColumn,
            company_column: companyColumnForPayload,
            enrich_missing_contacts_with_web: false,
            selected_fields: selectedFields,
          }),
        })

        const contentType = res.headers.get('content-type') ?? ''
        const payload = contentType.includes('application/json')
          ? await res.json()
          : await res.text()

        if (!res.ok) {
          const message = typeof payload === 'string'
            ? payload
            : payload?.error

          throw new Error(message ?? 'No se pudo poblar la base.')
        }

        if (typeof payload === 'string' || !payload?.data) {
          throw new Error('El servidor devolvió una respuesta inválida.')
        }

        return payload.data as BaseBuilderAnalysisResult
      }

      async function runWebEnrichmentPass() {
        const res = await fetch('/api/base-builder/web-enrichment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rows: compactRows,
            match_mode: selectedMatchMode,
            match_column: selectedMatchColumn,
            company_column: companyColumnForPayload,
            selected_fields: selectedFields,
          }),
        })

        const contentType = res.headers.get('content-type') ?? ''
        const payload = contentType.includes('application/json')
          ? await res.json()
          : await res.text()

        if (!res.ok) {
          const message = typeof payload === 'string'
            ? payload
            : payload?.error

          throw new Error(message ?? 'No se pudo ejecutar el enriquecimiento web.')
        }

        if (typeof payload === 'string') {
          throw new Error('El servidor devolvió una respuesta inválida al enriquecer en web.')
        }

        return (payload?.data ?? null) as BaseBuilderWebEnrichmentResult | null
      }

      let latestAnalysis = await runAnalysisPass()
      let aggregateWeb: BaseBuilderWebEnrichmentResult | undefined

      if (enrichMissingContactsWithWeb && contactFieldSelected && webEnrichmentAvailable) {
        let webPass = 0

        while (webPass < MAX_AUTO_WEB_PASSES) {
          webPass += 1
          setAnalyzeStatus(webPass === 1 ? 'Enriqueciendo web...' : `Enriqueciendo web (pasada ${webPass})...`)

          const webPassResult = await runWebEnrichmentPass()
          if (!webPassResult?.enabled) break

          aggregateWeb = aggregateWeb
            ? {
                ...aggregateWeb,
                candidates: Math.max(aggregateWeb.candidates, webPassResult.candidates),
                attempted: aggregateWeb.attempted + webPassResult.attempted,
                from_cache: Math.max(aggregateWeb.from_cache, webPassResult.from_cache),
                limited: webPassResult.limited,
                without_result: aggregateWeb.without_result + webPassResult.without_result,
                email_found: aggregateWeb.email_found + webPassResult.email_found,
                phone_found: aggregateWeb.phone_found + webPassResult.phone_found,
                providers: {
                  brave: (aggregateWeb.providers?.brave ?? 0) + (webPassResult.providers?.brave ?? 0),
                  duckduckgo: (aggregateWeb.providers?.duckduckgo ?? 0) + (webPassResult.providers?.duckduckgo ?? 0),
                  bing: (aggregateWeb.providers?.bing ?? 0) + (webPassResult.providers?.bing ?? 0),
                  none: (aggregateWeb.providers?.none ?? 0) + (webPassResult.providers?.none ?? 0),
                  error: (aggregateWeb.providers?.error ?? 0) + (webPassResult.providers?.error ?? 0),
                },
              }
            : {
                ...webPassResult,
                providers: webPassResult.providers ?? emptyProviderMetrics(),
              }

          setAnalyzeProgress({
            pass: webPass,
            totalCandidates: aggregateWeb.candidates,
            processed: Math.min(
              aggregateWeb.candidates,
              aggregateWeb.attempted + aggregateWeb.from_cache
            ),
            attempted: webPassResult.attempted,
            fromCache: aggregateWeb.from_cache,
            limited: webPassResult.limited,
          })

          latestAnalysis = await runAnalysisPass()

          if (!webPassResult.limited || webPassResult.attempted === 0) {
            break
          }
        }
      }

      const mergedRows = parsedUpload.rows.map((row, index) => ({
        ...row,
        ...(latestAnalysis.rows[index] ?? {}),
      }))

      setAnalysis({
        ...latestAnalysis,
        web_enrichment: aggregateWeb,
        rows: mergedRows,
        original_columns: parsedUpload.headers,
        match_mode: selectedMatchMode,
        match_column: selectedMatchColumn,
        rut_column: selectedMatchMode === 'rut' ? selectedMatchColumn : null,
      })
    } catch (err) {
      setAnalysis(null)
      setError(err instanceof Error ? err.message : 'No se pudo poblar la base.')
    } finally {
      setAnalyzing(false)
      setAnalyzeStatus('Cruzando...')
      setAnalyzeProgress(null)
    }
  }

  async function handleExport() {
    if (!analysis) return

    const shouldUpdateAgainstCrm = window.confirm(
      '¿Quieres actualizar esta descarga contra el CRM antes de exportarla?'
    )

    setExporting(true)
    setExportStatus(shouldUpdateAgainstCrm ? 'Actualizando contra CRM...' : 'Exportando...')
    setExportDone(false)
    setError(null)

    try {
      const baseName = `${getExportBaseName(uploadedFile?.name)}-poblada`
      let rowsToExport = analysis.rows
      let extraColumns: string[] = []
      let crmExportWarning: string | null = null

      if (shouldUpdateAgainstCrm) {
        try {
          rowsToExport = attachCrmSummaryToRows(
            analysis.rows,
            await fetchCrmSummariesForRows(analysis.rows)
          )
          extraColumns = [...CRM_EXPORT_COLUMNS]
        } catch (err) {
          const message = err instanceof Error ? err.message : 'error desconocido'
          crmExportWarning = `No se pudo actualizar contra el CRM (${message}). Descargué la base poblada sin columnas CRM.`
        }
      }

      if (exportFormat === 'csv') {
        const csv = exportRowsToCsv(
          rowsToExport,
          analysis.original_columns,
          analysis.selected_fields,
          extraColumns
        )
        downloadFile(csv, `${baseName}.csv`, 'text/csv;charset=utf-8;')
      } else {
        downloadFile(
          JSON.stringify(rowsToExport, null, 2),
          `${baseName}.json`,
          'application/json'
        )
      }

      if (crmExportWarning) {
        setError(crmExportWarning)
      }
      setExportDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo exportar la base.')
    } finally {
      setExporting(false)
      setExportStatus('Exportando...')
    }
  }

  return (
    <>
      <Header
        title="Poblar base"
        subtitle="Sube tu archivo, cruza por RUT, nombre o razón social contra el maestro y exporta la misma base enriquecida"
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
                  CSV o Excel. Puedes cruzar por RUT, nombre de persona o razón social y luego elegir qué traer del maestro.
                </p>
              </div>
            </label>

            <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-xl border border-[#253357] bg-[#0b1328] p-4">
                <p className="text-xs font-medium text-slate-400 mb-3">Cómo quieres cruzar</p>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { value: 'rut', label: 'Por RUT' },
                    { value: 'nombre_persona', label: 'Por nombre' },
                    { value: 'razon_social', label: 'Por razón social' },
                  ].map(option => (
                    <button
                      key={option.value}
                      onClick={() => applyMatchMode(option.value as BaseBuilderMatchMode)}
                      disabled={parsedUpload.headers.length === 0}
                      className={cn(
                        'rounded-lg border px-3 py-2 text-sm transition-all',
                        selectedMatchMode === option.value
                          ? 'border-brand-500/50 bg-brand-500/10 text-white'
                          : 'border-[#253357] text-slate-400 hover:border-brand-500/30'
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs font-medium text-slate-400 mt-4 mb-2">
                  {selectedMatchMode === 'rut'
                    ? 'Columna RUT detectada'
                    : selectedMatchMode === 'nombre_persona'
                      ? 'Columna nombre detectada'
                      : 'Columna razón social detectada'}
                </p>
                <select
                  value={selectedMatchColumn}
                  onChange={event => {
                    setSelectedMatchColumn(event.target.value)
                    resetAnalysisState()
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
                  {detectedColumnForMode
                    ? `Sugerencia automática: ${detectedColumnForMode}`
                    : selectedMatchMode === 'rut'
                      ? 'Si tu archivo no trae RUT, este modo no va a poder cruzar contra el maestro.'
                      : selectedMatchMode === 'nombre_persona'
                        ? 'Si tu archivo no trae nombres completos, cambia la columna o usa cruce por RUT.'
                        : 'Si tu archivo no trae una razón social clara, cambia la columna o usa cruce por RUT.'}
                </p>
                {selectedMatchMode === 'nombre_persona' && (
                  <p className="text-xs text-slate-500 mt-2">
                    El cruce por nombre normaliza tildes y mayúsculas. Si un nombre aparece en más de un RUT, queda como ambiguo.
                  </p>
                )}
                {selectedMatchMode === 'razon_social' && (
                  <p className="text-xs text-slate-500 mt-2">
                    El cruce por razón social normaliza tildes, mayúsculas y sufijos como SpA o Ltda.
                  </p>
                )}
                {selectedMatchColumn && !selectedColumnIsValid && (
                  <p className="text-xs text-amber-300 mt-2">
                    {selectedMatchMode === 'rut'
                      ? 'La columna elegida no parece ser RUT.'
                      : selectedMatchMode === 'nombre_persona'
                        ? 'La columna elegida no parece contener nombres de personas.'
                        : 'La columna elegida no parece ser una razón social utilizable.'}
                  </p>
                )}
                {selectedMatchMode === 'rut' && selectedDvColumn && selectedColumnLooksLikeRut && (
                  <p className="text-xs text-emerald-300 mt-2">
                    Detectamos también la columna DV: {selectedDvColumn}
                  </p>
                )}
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

              <div className="mb-4 rounded-xl border border-[#253357] bg-[#0b1328] p-4">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enrichMissingContactsWithWeb && webEnrichmentAvailable}
                    onChange={event => {
                      setEnrichMissingContactsWithWeb(event.target.checked)
                      resetAnalysisState()
                    }}
                    disabled={!webEnrichmentAvailable}
                    className="mt-1"
                  />
                  <div>
                    <p className="text-sm font-medium text-white">
                      Opcional: buscar mails y teléfonos faltantes en la web
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      Usa búsqueda web + IA para intentar encontrar contactos cuando el maestro no los trae.
                      En RUT y razón social, la búsqueda usa la empresa detectada y avanza en tandas automáticas.
                    </p>
                    {!webEnrichmentAvailable && (
                      <p className="text-xs text-amber-300 mt-2">
                        El cruce por nombre pobla datos desde el maestro; la búsqueda web queda reservada para empresas.
                      </p>
                    )}
                    {!contactFieldSelected && (
                      <p className="text-xs text-amber-300 mt-2">
                        Esta opción solo aplica si seleccionas Email o Teléfono celular.
                      </p>
                    )}
                  </div>
                </label>
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
                disabled={
                  parsedUpload.rows.length === 0 ||
                  !selectedMatchColumn ||
                  !selectedColumnIsValid ||
                  analyzing
                }
                className="btn-primary w-full justify-center"
              >
                {analyzing ? (
                  <>
                    <Spinner size="sm" />
                    {analyzeStatus}
                  </>
                ) : (
                  <>
                    <ScanSearch className="w-4 h-4" />
                    Poblar y analizar
                  </>
                )}
              </button>

              {analyzing && (
                <div className="rounded-lg border border-[#253357] bg-[#111827] p-3 space-y-2">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-slate-400">Progreso del poblamiento</span>
                    <span className="text-brand-300 font-medium">{analyzeStatus}</span>
                  </div>

                  {analyzeProgress && analyzeProgress.totalCandidates !== null ? (
                    <>
                      <div className="flex items-center justify-between gap-3 text-xs text-slate-400">
                        <span>Empresas web procesadas</span>
                        <span className="text-slate-200">
                          {formatNumber(analyzeProgress.processed)} de {formatNumber(analyzeProgress.totalCandidates)}
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-[#0b1328] overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-cyan-500 to-brand-500 transition-all"
                          style={{
                            width: `${analyzeProgress.totalCandidates > 0
                              ? Math.max(6, Math.min(100, (analyzeProgress.processed / analyzeProgress.totalCandidates) * 100))
                              : 100}%`,
                          }}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-3 text-[11px] text-slate-500">
                        <span>Lote actual: {formatNumber(analyzeProgress.attempted)}</span>
                        <span>Desde cache: {formatNumber(analyzeProgress.fromCache)}</span>
                        <span>Pasada: {formatNumber(analyzeProgress.pass)}</span>
                      </div>
                    </>
                  ) : (
                    <div className="space-y-2">
                      <div className="h-2 rounded-full bg-[#0b1328] overflow-hidden">
                        <div className="h-full w-1/3 bg-gradient-to-r from-cyan-500 to-brand-500 animate-pulse" />
                      </div>
                      <p className="text-[11px] text-slate-500">
                        Preparando cruce y estimando empresas candidatas para búsqueda web.
                      </p>
                    </div>
                  )}
                </div>
              )}

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
                      <p className="text-[11px] text-slate-500">
                        {analysis.match_mode === 'rut'
                          ? 'Con RUT válido'
                          : analysis.match_mode === 'nombre_persona'
                            ? 'Con nombre útil'
                            : 'Con razón social útil'}
                      </p>
                      <p className="text-lg font-semibold text-white mt-1">
                        {formatNumber(analysis.valid_input_count)}
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
                      <span>
                        {analysis.match_mode === 'rut'
                          ? 'RUT inválido'
                          : analysis.match_mode === 'nombre_persona'
                            ? 'Sin nombre útil'
                            : 'Sin razón social útil'}
                      </span>
                      <span className="text-slate-200">{formatNumber(analysis.invalid_input_count)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Ambiguos</span>
                      <span className="text-slate-200">{formatNumber(analysis.ambiguous_count)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Duplicados</span>
                      <span className="text-slate-200">{formatNumber(analysis.duplicate_count)}</span>
                    </div>
                  </div>

                  {analysis.coverage.length > 0 && (
                    <div className="rounded-lg border border-[#253357] bg-[#111827] p-3">
                      <p className="text-xs font-medium text-slate-300 mb-2">
                        Qué pudimos poblar de lo pedido
                      </p>
                      <div className="space-y-1.5">
                        {analysis.coverage.map(item => (
                          <div
                            key={item.field}
                            className="flex items-center justify-between gap-3 text-xs"
                          >
                            <span className="text-slate-400">{item.label}</span>
                            <div className="text-right">
                              <span className={cn('font-medium', getCoverageTone(item.pct))}>
                                {formatNumber(item.count)}
                              </span>
                              <span className="text-slate-500">
                                {' '}de {formatNumber(analysis.requested_count)} ({formatPercentage(item.pct)})
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {analysis.web_enrichment?.enabled && (
                    <div className="rounded-lg border border-[#253357] bg-[#111827] p-3 text-xs text-slate-400 space-y-1">
                      <div className="flex items-center justify-between">
                        <span>Ejecución web</span>
                        <span className="text-emerald-300 font-medium">Sí, ejecutada</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Empresas candidatas</span>
                        <span className="text-slate-200">{formatNumber(analysis.web_enrichment.candidates)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Web scraping intentado</span>
                        <span className="text-slate-200">{formatNumber(analysis.web_enrichment.attempted)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Resultados desde cache</span>
                        <span className="text-slate-200">{formatNumber(analysis.web_enrichment.from_cache)}</span>
                      </div>
                      {analysis.web_enrichment.providers && (
                        <>
                          <div className="flex items-center justify-between">
                            <span>Busquedas con Brave</span>
                            <span className="text-slate-200">{formatNumber(analysis.web_enrichment.providers.brave)}</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span>Fallback DuckDuckGo</span>
                            <span className="text-slate-200">{formatNumber(analysis.web_enrichment.providers.duckduckgo)}</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span>Fallback Bing</span>
                            <span className="text-slate-200">{formatNumber(analysis.web_enrichment.providers.bing)}</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span>Errores de busqueda</span>
                            <span className="text-slate-200">{formatNumber(analysis.web_enrichment.providers.error)}</span>
                          </div>
                        </>
                      )}
                      <div className="flex items-center justify-between">
                        <span>Email encontrado en web</span>
                        <span className="text-slate-200">{formatNumber(analysis.web_enrichment.email_found)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Teléfono encontrado en web</span>
                        <span className="text-slate-200">{formatNumber(analysis.web_enrichment.phone_found)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Sin hallazgo usable</span>
                        <span className="text-slate-200">{formatNumber(analysis.web_enrichment.without_result)}</span>
                      </div>
                      {analysis.web_enrichment.limited && (
                        <p className="text-amber-300 pt-1">
                          Quedaron empresas nuevas pendientes de búsqueda web para próximas corridas.
                        </p>
                      )}
                      {analysis.web_enrichment.candidates === 0 && (
                        <p className="text-slate-500 pt-1">
                          Esta corrida no tenía empresas cruzadas con faltantes de contacto para buscar.
                        </p>
                      )}
                      {analysis.web_enrichment.candidates > 0 &&
                        analysis.web_enrichment.email_found === 0 &&
                        analysis.web_enrichment.phone_found === 0 && (
                        <p className="text-slate-500 pt-1">
                          Sí se ejecutó, pero en esta corrida no encontró mails o teléfonos nuevos utilizables.
                        </p>
                      )}
                    </div>
                  )}
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
                    {exportStatus}
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
                  Cruce por {getMatchModeLabel(analysis.match_mode)} en: {analysis.match_column ?? '—'}
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
                                : row.match_status === 'ambiguous'
                                  ? 'bg-orange-500/10 text-orange-300'
                                : row.match_status === 'not_found'
                                  ? 'bg-amber-500/10 text-amber-300'
                                  : 'bg-rose-500/10 text-rose-300'
                            )}
                          >
                            {row.match_status === 'matched'
                              ? 'Cruzó'
                              : row.match_status === 'ambiguous'
                                ? 'Ambiguo'
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
              description="Sube tu base, elige si quieres cruzar por RUT, nombre o razón social, selecciona qué campos del maestro agregar y luego exporta la base enriquecida."
            />
          </div>
        )}
      </div>
    </>
  )
}
