'use server'

import { db, hasSupabaseAdminEnv } from '@/lib/db/supabase'
import { cleanRut, displayRut, validateRut } from '@/lib/utils/rut'
import type {
  BaseBuilderAnalysisResult,
  BaseBuilderCoverageItem,
  BaseBuilderExportRow,
  BaseBuilderFieldKey,
} from '@/types/base-builder'
import type { PersonaView } from '@/types'
import { BASE_BUILDER_FIELDS } from '@/types/base-builder'

const BATCH_SIZE = 500
const VALID_FIELDS = new Set<BaseBuilderFieldKey>(
  BASE_BUILDER_FIELDS.map(field => field.key)
)

type PersonaSubset = Pick<PersonaView, 'rutid'> & Partial<PersonaView>

function normalizeColumnKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
}

function toPaddedRut(rut: string): string {
  return cleanRut(rut).padStart(10, '0')
}

function sanitizeSelectedFields(fields: string[]): BaseBuilderFieldKey[] {
  const seen = new Set<BaseBuilderFieldKey>()
  const validFields: BaseBuilderFieldKey[] = []

  for (const field of fields) {
    if (!VALID_FIELDS.has(field as BaseBuilderFieldKey)) continue
    const typedField = field as BaseBuilderFieldKey
    if (seen.has(typedField)) continue
    seen.add(typedField)
    validFields.push(typedField)
  }

  return validFields
}

function isPresent(value: string | number | boolean | null | undefined): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  return true
}

function buildFieldLabelMap() {
  return new Map(BASE_BUILDER_FIELDS.map(field => [field.key, `Maestro - ${field.label}`]))
}

function findDvValue(row: Record<string, string>, rutColumnName: string): string | null {
  const rutKey = normalizeColumnKey(rutColumnName)

  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = normalizeColumnKey(key)
    if (normalizedKey === rutKey) continue

    if (
      normalizedKey === 'dv' ||
      normalizedKey === 'digitoverificador' ||
      normalizedKey === 'digverificador' ||
      normalizedKey === 'verificador'
    ) {
      const cleaned = String(value ?? '').trim().toUpperCase()
      if (/^[0-9K]$/i.test(cleaned)) return cleaned
    }
  }

  return null
}

function resolveRutFromRow(
  row: Record<string, string>,
  rutColumnName: string
): {
  raw: string | null
  formatted: string | null
  paddedRut: string | null
  isValid: boolean
} {
  const rawBase = String(row[rutColumnName] ?? '').trim()
  if (!rawBase) {
    return { raw: null, formatted: null, paddedRut: null, isValid: false }
  }

  if (validateRut(rawBase)) {
    return {
      raw: rawBase,
      formatted: displayRut(rawBase),
      paddedRut: toPaddedRut(rawBase),
      isValid: true,
    }
  }

  const dv = findDvValue(row, rutColumnName)
  if (dv) {
    const combined = `${rawBase}${dv}`
    if (validateRut(combined)) {
      return {
        raw: combined,
        formatted: displayRut(combined),
        paddedRut: toPaddedRut(combined),
        isValid: true,
      }
    }
  }

  return {
    raw: rawBase,
    formatted: rawBase,
    paddedRut: null,
    isValid: false,
  }
}

export async function analyzeRutsForBaseBuilder(
  rawRuts: string[],
  requestedFields: string[]
): Promise<BaseBuilderAnalysisResult> {
  const selectedFields = sanitizeSelectedFields(requestedFields)
  const requestedCount = rawRuts.filter(value => String(value ?? '').trim().length > 0).length

  const preparedEntries: {
    raw: string
    paddedRut: string | null
    formattedRut: string
    isValid: boolean
  }[] = []

  let duplicateCount = 0
  const dedupe = new Set<string>()

  for (const value of rawRuts) {
    const raw = String(value ?? '').trim()
    if (!raw) continue

    const cleaned = cleanRut(raw)
    if (!cleaned) continue

    const isValid = validateRut(raw)
    const paddedRut = isValid ? toPaddedRut(raw) : null
    const dedupeKey = isValid ? `rut:${paddedRut}` : `raw:${cleaned}`

    if (dedupe.has(dedupeKey)) {
      duplicateCount += 1
      continue
    }

    dedupe.add(dedupeKey)
    preparedEntries.push({
      raw,
      paddedRut,
      formattedRut: isValid ? displayRut(raw) : raw,
      isValid,
    })
  }

  const validEntries = preparedEntries.filter(entry => entry.isValid && entry.paddedRut)
  const validRuts = validEntries.map(entry => entry.paddedRut as string)

  const rowsByRut = new Map<string, PersonaSubset>()

  if (hasSupabaseAdminEnv && validRuts.length > 0) {
    const selectColumns = ['rutid', ...selectedFields].join(',')

    for (let i = 0; i < validRuts.length; i += BATCH_SIZE) {
      const batch = validRuts.slice(i, i + BATCH_SIZE)
      const { data, error } = await db
        .from('master_personas_view')
        .select(selectColumns)
        .in('rutid', batch)

      if (error) {
        console.error('[analyzeRutsForBaseBuilder]', error)
        throw new Error('No se pudo consultar la base maestra.')
      }

      for (const row of (data ?? []) as PersonaSubset[]) {
        rowsByRut.set(row.rutid, row)
      }
    }
  }

  const exportRows: BaseBuilderExportRow[] = preparedEntries.map(entry => {
    if (!entry.isValid || !entry.paddedRut) {
      const invalidRow: BaseBuilderExportRow = {
        rut_input: entry.raw,
        rut_formateado: entry.formattedRut,
        rutid: null,
        match_status: 'invalid',
      }

      for (const field of selectedFields) {
        invalidRow[field] = null
      }

      return invalidRow
    }

    const matchedRow = rowsByRut.get(entry.paddedRut)
    const baseRow: BaseBuilderExportRow = {
      rut_input: entry.raw,
      rut_formateado: entry.formattedRut,
      rutid: matchedRow?.rutid ?? entry.paddedRut,
      match_status: matchedRow ? 'matched' : 'not_found',
    }

    for (const field of selectedFields) {
      const value = matchedRow?.[field]
      baseRow[field] =
        value === undefined ? null : (value as string | number | boolean | null)
    }

    return baseRow
  })

  const matchedCount = exportRows.filter(row => row.match_status === 'matched').length
  const validRutCount = validEntries.length
  const unmatchedCount = validRutCount - matchedCount
  const invalidRutCount = exportRows.filter(row => row.match_status === 'invalid').length
  const matchRate = validRutCount > 0 ? (matchedCount / validRutCount) * 100 : 0

  const coverage: BaseBuilderCoverageItem[] = selectedFields.map(field => {
    const definition = BASE_BUILDER_FIELDS.find(item => item.key === field)
    const count = exportRows.reduce((acc, row) => {
      if (row.match_status !== 'matched') return acc
      return acc + (isPresent(row[field]) ? 1 : 0)
    }, 0)

    return {
      field,
      label: definition?.label ?? field,
      count,
      total: validRutCount,
      matched_total: matchedCount,
      pct: validRutCount > 0 ? (count / validRutCount) * 100 : 0,
      matched_pct: matchedCount > 0 ? (count / matchedCount) * 100 : 0,
    }
  })

  return {
    requested_count: requestedCount,
    unique_count: preparedEntries.length,
    valid_rut_count: validRutCount,
    invalid_rut_count: invalidRutCount,
    duplicate_count: duplicateCount,
    matched_count: matchedCount,
    unmatched_count: unmatchedCount,
    match_rate: matchRate,
    rut_column: null,
    original_columns: [],
    selected_fields: selectedFields,
    coverage,
    rows: exportRows,
  }
}

export async function analyzeRowsForBaseBuilder(
  sourceRows: Record<string, string>[],
  rutColumn: string,
  requestedFields: string[]
): Promise<BaseBuilderAnalysisResult> {
  const selectedFields = sanitizeSelectedFields(requestedFields)
  const fieldLabelMap = buildFieldLabelMap()
  const originalColumns = sourceRows[0] ? Object.keys(sourceRows[0]) : []

  const preparedEntries = sourceRows.map((row, index) => {
    const resolvedRut = resolveRutFromRow(row, rutColumn)
    return {
      row,
      rowNumber: index + 1,
      ...resolvedRut,
    }
  })

  const validEntries = preparedEntries.filter(entry => entry.isValid && entry.paddedRut)
  const uniqueValidRuts = [...new Set(validEntries.map(entry => entry.paddedRut as string))]
  const duplicateCount = validEntries.length - uniqueValidRuts.length
  const rowsByRut = new Map<string, PersonaSubset>()

  if (hasSupabaseAdminEnv && uniqueValidRuts.length > 0) {
    const selectColumns = ['rutid', ...selectedFields].join(',')

    for (let i = 0; i < uniqueValidRuts.length; i += BATCH_SIZE) {
      const batch = uniqueValidRuts.slice(i, i + BATCH_SIZE)
      const { data, error } = await db
        .from('master_personas_view')
        .select(selectColumns)
        .in('rutid', batch)

      if (error) {
        console.error('[analyzeRowsForBaseBuilder]', error)
        throw new Error('No se pudo consultar la base maestra.')
      }

      for (const row of (data ?? []) as PersonaSubset[]) {
        rowsByRut.set(row.rutid, row)
      }
    }
  }

  const exportRows: BaseBuilderExportRow[] = preparedEntries.map(entry => {
    const matchedRow = entry.paddedRut ? rowsByRut.get(entry.paddedRut) : undefined
    const baseRow: BaseBuilderExportRow = {
      ...entry.row,
      rut_input: entry.raw ?? '',
      rut_formateado: entry.formatted ?? '',
      rutid: matchedRow?.rutid ?? entry.paddedRut,
      match_status: entry.isValid ? (matchedRow ? 'matched' : 'not_found') : 'invalid',
    }

    for (const field of selectedFields) {
      const label = fieldLabelMap.get(field) ?? field
      const value = matchedRow?.[field]
      baseRow[label] =
        value === undefined ? null : (value as string | number | boolean | null)
    }

    return baseRow
  })

  const matchedCount = exportRows.filter(row => row.match_status === 'matched').length
  const validRutCount = validEntries.length
  const invalidRutCount = exportRows.filter(row => row.match_status === 'invalid').length
  const unmatchedCount = validRutCount - matchedCount
  const matchRate = validRutCount > 0 ? (matchedCount / validRutCount) * 100 : 0

  const coverage: BaseBuilderCoverageItem[] = selectedFields.map(field => {
    const definition = BASE_BUILDER_FIELDS.find(item => item.key === field)
    const label = fieldLabelMap.get(field) ?? field
    const count = exportRows.reduce((acc, row) => {
      if (row.match_status !== 'matched') return acc
      return acc + (isPresent(row[label]) ? 1 : 0)
    }, 0)

    return {
      field,
      label: definition?.label ?? field,
      count,
      total: validRutCount,
      matched_total: matchedCount,
      pct: validRutCount > 0 ? (count / validRutCount) * 100 : 0,
      matched_pct: matchedCount > 0 ? (count / matchedCount) * 100 : 0,
    }
  })

  return {
    requested_count: sourceRows.length,
    unique_count: sourceRows.length,
    valid_rut_count: validRutCount,
    invalid_rut_count: invalidRutCount,
    duplicate_count: duplicateCount,
    matched_count: matchedCount,
    unmatched_count: unmatchedCount,
    match_rate: matchRate,
    rut_column: rutColumn,
    original_columns: originalColumns,
    selected_fields: selectedFields,
    coverage,
    rows: exportRows,
  }
}
