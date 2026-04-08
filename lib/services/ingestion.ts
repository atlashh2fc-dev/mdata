'use server'

import { db } from '@/lib/db/supabase'
import { validateRut, normalizeRut, detectRutColumn } from '@/lib/utils/rut'
import type {
  DataSource,
  IngestionJob,
  IngestionLog,
  SourceColumnMapping,
  StagingRow,
  DetectedColumn,
  ColumnMappingDraft,
} from '@/types'

// ============================================================
// DATA SOURCES
// ============================================================

export async function getFuentes(): Promise<DataSource[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const datasetOverview = (db as any)
    .from('dataset_overview')
    .select('*')
    .order('created_at', { ascending: false })

  const { data, error } = await datasetOverview

  if (error) {
    const fallback = await db
      .from('data_sources')
      .select('*')
      .order('created_at', { ascending: false })

    if (fallback.error) {
      console.error('[getFuentes]', fallback.error)
      return []
    }

    return (fallback.data ?? []) as DataSource[]
  }
  return (data ?? []) as DataSource[]
}

export async function createFuente(
  name: string,
  sourceType: string,
  description: string | null,
  userId: string
): Promise<DataSource | null> {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  const { data, error } = await db
    .from('data_sources')
    .insert({
      name,
      slug,
      source_type: sourceType,
      description,
      created_by: userId,
    })
    .select()
    .single()

  if (error) {
    console.error('[createFuente]', error)
    return null
  }
  return data as DataSource
}

// ============================================================
// INGESTION JOBS
// ============================================================

export async function getIngestionJobs(
  page = 1,
  pageSize = 20
): Promise<{ data: IngestionJob[]; total: number }> {
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  const { data, error, count } = await db
    .from('ingestion_jobs')
    .select(`*, data_sources (name, source_type)`, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to)

  if (error) {
    console.error('[getIngestionJobs]', error)
    return { data: [], total: 0 }
  }

  const normalized = (data ?? []).map((row: Record<string, unknown>) => ({
    ...row,
    data_source: row.data_sources ?? null,
  }))

  return { data: normalized as IngestionJob[], total: count ?? 0 }
}

export async function getIngestionJobById(id: string): Promise<IngestionJob | null> {
  const { data, error } = await db
    .from('ingestion_jobs')
    .select(`*, data_sources (name, source_type)`)
    .eq('id', id)
    .single()

  if (error || !data) return null
  return {
    ...(data as Record<string, unknown>),
    data_source: (data as Record<string, unknown>).data_sources ?? null,
  } as IngestionJob
}

export async function createIngestionJob(
  sourceId: string | null,
  fileName: string,
  fileSize: number,
  userId: string
): Promise<IngestionJob | null> {
  const { data, error } = await db
    .from('ingestion_jobs')
    .insert({
      source_id: sourceId,
      file_name: fileName,
      file_size: fileSize,
      status: 'pending',
      created_by: userId,
    })
    .select()
    .single()

  if (error) {
    console.error('[createIngestionJob]', error)
    return null
  }
  return data as IngestionJob
}

export async function updateJobStatus(
  jobId: string,
  status: string,
  updates?: Partial<IngestionJob>
): Promise<void> {
  const payload: Record<string, unknown> = { status, ...updates }
  if (status === 'processing') payload.started_at = new Date().toISOString()
  if (status === 'completed' || status === 'failed') {
    payload.completed_at = new Date().toISOString()
  }

  await db.from('ingestion_jobs').update(payload).eq('id', jobId)
}

// ============================================================
// INGESTION LOGS
// ============================================================

export async function getJobLogs(jobId: string): Promise<IngestionLog[]> {
  const { data, error } = await db
    .from('ingestion_logs')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: true })
    .limit(500)

  if (error) return []
  return (data ?? []) as IngestionLog[]
}

export async function addLog(
  jobId: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  rowNumber?: number,
  rawData?: Record<string, unknown>
): Promise<void> {
  await db.from('ingestion_logs').insert({
    job_id: jobId,
    level,
    message,
    row_number: rowNumber ?? null,
    raw_data: rawData ?? null,
  })
}

// ============================================================
// COLUMN MAPPINGS
// ============================================================

export async function getColumnMappings(sourceId: string): Promise<SourceColumnMapping[]> {
  const { data, error } = await db
    .from('source_column_mappings')
    .select('*')
    .eq('source_id', sourceId)
    .order('created_at', { ascending: true })

  if (error) return []
  return (data ?? []) as SourceColumnMapping[]
}

export async function saveColumnMappings(
  sourceId: string,
  mappings: ColumnMappingDraft[]
): Promise<void> {
  // Eliminar mappings anteriores de esta fuente
  await db
    .from('source_column_mappings')
    .delete()
    .eq('source_id', sourceId)

  if (mappings.length === 0) return

  const rows = mappings
    .filter(m => m.target_table && m.target_column)
    .map(m => ({
      source_id: sourceId,
      source_column: m.source_column,
      target_table: m.target_table!,
      target_column: m.target_column!,
      transform_fn: m.transform_fn,
      is_rut_column: m.is_rut_column,
      is_required: m.is_rut_column,
    }))

  if (rows.length > 0) {
    await db.from('source_column_mappings').insert(rows)
  }
}

// ============================================================
// COLUMN DETECTION
// ============================================================

export async function detectColumns(
  rows: Record<string, string>[],
  sampleSize = 20
): Promise<DetectedColumn[]> {
  if (!rows || rows.length === 0) return []

  const headers = Object.keys(rows[0])
  const sample = rows.slice(0, sampleSize)

  return headers.map(col => {
    const values = sample.map(r => String(r[col] ?? '')).filter(v => v.trim() !== '')
    const nullCount = sample.length - values.length

    let inferredType: DetectedColumn['inferred_type'] = 'text'

    if (detectRutColumn(values)) {
      inferredType = 'rut'
    } else if (values.every(v => !isNaN(Number(v)))) {
      inferredType = 'number'
    } else if (values.every(v => /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(v))) {
      inferredType = 'date'
    } else if (values.every(v => /^(true|false|si|no|1|0)$/i.test(v))) {
      inferredType = 'boolean'
    }

    const uniqueValues = new Set(values)

    return {
      name: col,
      sample_values: values.slice(0, 5),
      inferred_type: inferredType,
      null_pct: sample.length > 0 ? Math.round((nullCount / sample.length) * 100) : 0,
      unique_count: uniqueValues.size,
    }
  })
}

// ============================================================
// STAGING
// ============================================================

export async function insertStagingBatch(
  jobId: string,
  rows: Record<string, string>[],
  mappings: ColumnMappingDraft[],
  batchSize = 500
): Promise<{ valid: number; invalid: number }> {
  const rutMapping = mappings.find(m => m.is_rut_column)
  let valid = 0
  let invalid = 0

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)

    const stagingRows = batch.map((row, idx) => {
      const resolvedRut = rutMapping ? resolveRutFromRow(row, rutMapping.source_column) : null
      const rawRut = resolvedRut?.raw ?? ''
      const isValidRut = resolvedRut?.isValid ?? false
      const rutid = resolvedRut?.normalized ?? null

      // Aplicar mapeo
      const mappedData: Record<string, unknown> = {}
      for (const mapping of mappings) {
        if (!mapping.target_table || !mapping.target_column) continue
        let val = row[mapping.source_column] ?? null
        if (val && mapping.transform_fn) {
          val = applyTransform(val, mapping.transform_fn)
        }
        const key = `${mapping.target_table}.${mapping.target_column}`
        mappedData[key] = val
      }

      const errors: string[] = []
      if (rutMapping && !isValidRut) {
        errors.push(`RUT inválido: ${rawRut}`)
        invalid++
      } else {
        valid++
      }

      return {
        job_id: jobId,
        row_number: i + idx + 1,
        raw_data: row as unknown as Record<string, unknown>,
        mapped_data: mappedData,
        rutid,
        is_valid_rut: isValidRut,
        validation_errors: errors,
        status: errors.length > 0 ? 'invalid' : 'valid',
      }
    })

    await db.from('staging_data').insert(stagingRows)
  }

  return { valid, invalid }
}

function applyTransform(value: string, fn: string): string {
  switch (fn) {
    case 'uppercase':   return value.toUpperCase()
    case 'lowercase':   return value.toLowerCase()
    case 'trim':        return value.trim()
    case 'rut_format':  return normalizeRut(value)
    default:            return value
  }
}

function normalizeColumnKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
}

function findDvValue(row: Record<string, string>, rutColumnName: string): string | null {
  const entries = Object.entries(row)
  const rutKey = normalizeColumnKey(rutColumnName)

  for (const [key, value] of entries) {
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
): { raw: string; normalized: string | null; isValid: boolean } | null {
  const rawBase = String(row[rutColumnName] ?? '').trim()
  if (!rawBase) return null

  const directRut = rawBase
  if (validateRut(directRut)) {
    return {
      raw: directRut,
      normalized: normalizeRut(directRut),
      isValid: true,
    }
  }

  const dv = findDvValue(row, rutColumnName)
  if (dv) {
    const combined = `${rawBase}${dv}`
    if (validateRut(combined)) {
      return {
        raw: combined,
        normalized: normalizeRut(combined),
        isValid: true,
      }
    }
  }

  return {
    raw: directRut,
    normalized: null,
    isValid: false,
  }
}

// ============================================================
// MERGE ENGINE
// ============================================================

export async function mergeStagingToMaster(jobId: string): Promise<{
  merged: number
  created: number
  skipped: number
}> {
  let merged = 0
  let created = 0
  let skipped = 0

  // Leer staging válido en lotes
  const PAGE_SIZE = 1000
  let page = 0
  let hasMore = true

  while (hasMore) {
    const { data: stagingRows, error } = await db
      .from('staging_data')
      .select('*')
      .eq('job_id', jobId)
      .eq('status', 'valid')
      .not('rutid', 'is', null)
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

    if (error || !stagingRows || stagingRows.length === 0) {
      hasMore = false
      break
    }

    for (const row of stagingRows) {
      if (!row.rutid) continue

      const mapped = row.mapped_data as Record<string, unknown> ?? {}
      const existingMaster = await db
        .from('master_personas')
        .select('rutid')
        .eq('rutid', row.rutid)
        .maybeSingle()

      // 1. Upsert master_personas
      await db
        .from('master_personas')
        .upsert({ rutid: row.rutid }, { onConflict: 'rutid', ignoreDuplicates: true })

      const isNew = !existingMaster.data

      // 2. Upsert pernat_resumen
      const pernatData = extractTableData(mapped, 'pernat_resumen')
      if (Object.keys(pernatData).length > 0) {
        const existing = await db
          .from('pernat_resumen')
          .select('id')
          .eq('rutid', row.rutid)
          .single()

        if (existing.data) {
          await db
            .from('pernat_resumen')
            .update(pernatData)
            .eq('rutid', row.rutid)
        } else {
          await db
            .from('pernat_resumen')
            .insert({ rutid: row.rutid, ...pernatData })
        }
      }

      // 3. Upsert autos_resumen
      const autosData = extractTableData(mapped, 'autos_resumen')
      if (Object.keys(autosData).length > 0) {
        await db
          .from('autos_resumen')
          .upsert({ rutid: row.rutid, ...autosData }, { onConflict: 'rutid' })
      }

      // 4. Upsert empresa_resumen
      const empresaData = extractTableData(mapped, 'empresa_resumen')
      if (Object.keys(empresaData).length > 0) {
        const ex = await db
          .from('empresa_resumen')
          .select('id')
          .eq('rutid', row.rutid)
          .single()
        if (ex.data) {
          await db.from('empresa_resumen').update(empresaData).eq('rutid', row.rutid)
        } else {
          await db.from('empresa_resumen').insert({ rutid: row.rutid, ...empresaData })
        }
      }

      // 5. Upsert domicilio_resumen
      const domicilioData = extractTableData(mapped, 'domicilio_resumen')
      if (Object.keys(domicilioData).length > 0) {
        const ex = await db
          .from('domicilio_resumen')
          .select('id')
          .eq('rutid', row.rutid)
          .single()
        if (ex.data) {
          await db.from('domicilio_resumen').update(domicilioData).eq('rutid', row.rutid)
        } else {
          await db.from('domicilio_resumen').insert({ rutid: row.rutid, ...domicilioData })
        }
      }

      // 6. Upsert acumulado_resumen
      const acumuladoData = extractTableData(mapped, 'acumulado_resumen')
      if (Object.keys(acumuladoData).length > 0) {
        await db
          .from('acumulado_resumen')
          .upsert({ rutid: row.rutid, ...acumuladoData }, { onConflict: 'rutid' })
      }

      // Marcar como merged
      await db
        .from('staging_data')
        .update({ status: 'merged' })
        .eq('id', row.id)

      if (isNew) created++
      else merged++
    }

    if (stagingRows.length < PAGE_SIZE) hasMore = false
    page++
  }

  return { merged, created, skipped }
}

function extractTableData(
  mapped: Record<string, unknown>,
  tableName: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const prefix = `${tableName}.`
  for (const [key, value] of Object.entries(mapped)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = value
    }
  }
  return result
}

// ============================================================
// EXPORT
// ============================================================

export async function getEstadisticas() {
  const { data: jobs } = await db
    .from('ingestion_jobs')
    .select('status, total_rows, valid_rows, invalid_rows, merged_rows, new_rows, created_at')
    .order('created_at', { ascending: false })
    .limit(30)

  return jobs ?? []
}
