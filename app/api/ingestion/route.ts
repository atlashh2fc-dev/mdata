import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import {
  createIngestionJob,
  updateJobStatus,
  getIngestionJobs,
  getIngestionJobById,
  getJobLogs,
  insertStagingBatch,
  mergeStagingToMaster,
  addLog,
  detectColumns,
} from '@/lib/services/ingestion'
import type { ColumnMappingDraft } from '@/types'

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { searchParams } = req.nextUrl
  const jobId = searchParams.get('job_id')
  const section = searchParams.get('section')

  if (jobId && section === 'logs') {
    const logs = await getJobLogs(jobId)
    return NextResponse.json({ success: true, data: logs })
  }

  if (jobId) {
    const job = await getIngestionJobById(jobId)
    if (!job) return NextResponse.json({ error: 'Job no encontrado' }, { status: 404 })
    return NextResponse.json({ success: true, data: job })
  }

  const page = parseInt(searchParams.get('page') ?? '1')
  const pageSize = parseInt(searchParams.get('page_size') ?? '20')
  const { data, total } = await getIngestionJobs(page, pageSize)
  return NextResponse.json({ success: true, data, total })
}

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const body = await req.json()
  const { action } = body

  // -------------------------------------------------------
  // 1. Crear job de ingesta
  // -------------------------------------------------------
  if (action === 'create_job') {
    const { source_id, file_name, file_size } = body
    const job = await createIngestionJob(source_id ?? null, file_name, file_size ?? 0, user.id)
    if (!job) return NextResponse.json({ error: 'Error al crear job' }, { status: 500 })
    return NextResponse.json({ success: true, data: job }, { status: 201 })
  }

  // -------------------------------------------------------
  // 2. Detectar columnas de muestra
  // -------------------------------------------------------
  if (action === 'detect_columns') {
    const { rows } = body as { rows: Record<string, string>[] }
    const columns = await detectColumns(rows, 30)
    return NextResponse.json({ success: true, data: columns })
  }

  // -------------------------------------------------------
  // 3. Cargar datos a staging
  // -------------------------------------------------------
  if (action === 'load_staging') {
    const { job_id, rows, mappings } = body as {
      job_id: string
      rows: Record<string, string>[]
      mappings: ColumnMappingDraft[]
    }

    await updateJobStatus(job_id, 'processing')
    await addLog(job_id, 'info', `Iniciando carga de ${rows.length} filas a staging`)

    try {
      const { valid, invalid } = await insertStagingBatch(job_id, rows, mappings)
      await updateJobStatus(job_id, 'validating', {
        total_rows: rows.length,
        valid_rows: valid,
        invalid_rows: invalid,
      })
      await addLog(
        job_id,
        'info',
        `Staging completado: ${valid} válidos, ${invalid} inválidos`
      )
      return NextResponse.json({ success: true, valid, invalid })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error desconocido'
      await updateJobStatus(job_id, 'failed', { error_message: msg })
      await addLog(job_id, 'error', `Error en staging: ${msg}`)
      return NextResponse.json({ error: msg }, { status: 500 })
    }
  }

  // -------------------------------------------------------
  // 4. Ejecutar merge staging → master
  // -------------------------------------------------------
  if (action === 'merge') {
    const { job_id } = body

    await updateJobStatus(job_id, 'merging')
    await addLog(job_id, 'info', 'Iniciando merge hacia master_personas')

    try {
      const { merged, created, skipped } = await mergeStagingToMaster(job_id)
      await updateJobStatus(job_id, 'completed', {
        merged_rows: merged,
        new_rows: created,
      })
      await addLog(
        job_id,
        'info',
        `Merge completado: ${merged} actualizados, ${created} nuevos, ${skipped} omitidos`
      )
      return NextResponse.json({ success: true, merged, created, skipped })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error en merge'
      await updateJobStatus(job_id, 'failed', { error_message: msg })
      await addLog(job_id, 'error', `Error en merge: ${msg}`)
      return NextResponse.json({ error: msg }, { status: 500 })
    }
  }

  // -------------------------------------------------------
  // 5. Cancelar job
  // -------------------------------------------------------
  if (action === 'cancel') {
    const { job_id } = body
    await updateJobStatus(job_id, 'cancelled')
    return NextResponse.json({ success: true })
  }

  return NextResponse.json({ error: 'Acción no reconocida' }, { status: 400 })
}
