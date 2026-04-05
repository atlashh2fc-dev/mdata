'use client'

import { useState, useEffect, useRef } from 'react'
import { Header } from '@/components/layout/Header'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { LoadingState, EmptyState, Spinner } from '@/components/ui/Spinner'
import { Pagination } from '@/components/ui/Pagination'
import type {
  IngestionJob,
  DataSource,
  DetectedColumn,
  ColumnMappingDraft,
  IngestionLog,
} from '@/types'
import { TARGET_COLUMNS } from '@/types'
import {
  Upload, FileText, ChevronRight, X, Check,
  ArrowRight, AlertCircle, Info, RefreshCw,
  Download, Columns, Merge, Eye,
} from 'lucide-react'
import { formatDatetime, formatFileSize, formatNumber } from '@/lib/utils/formatters'

// ============================================================
// WIZARD STEPS
// ============================================================

type WizardStep = 'upload' | 'detect' | 'map' | 'process' | 'done'

const STEPS: { key: WizardStep; label: string }[] = [
  { key: 'upload', label: 'Subir archivo' },
  { key: 'detect', label: 'Detectar columnas' },
  { key: 'map', label: 'Mapear campos' },
  { key: 'process', label: 'Procesar' },
  { key: 'done', label: 'Resultado' },
]

// ============================================================
// HELPERS
// ============================================================

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''))
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim().replace(/^["']|["']$/g, ''))
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = values[i] ?? '' })
    return row
  })
}

// ============================================================
// COLUMN MAPPING ROW
// ============================================================

interface MappingRowProps {
  col: DetectedColumn
  mapping: ColumnMappingDraft
  onChange: (updated: ColumnMappingDraft) => void
}

function MappingRow({ col, mapping, onChange }: MappingRowProps) {
  const targetTables = Object.keys(TARGET_COLUMNS)

  return (
    <tr>
      <td>
        <div>
          <p className="text-xs font-medium text-slate-200">{col.name}</p>
          <div className="flex items-center gap-1 mt-0.5">
            <span className={`badge text-[9px] px-1 py-0 ${
              col.inferred_type === 'rut' ? 'badge-brand' :
              col.inferred_type === 'number' ? 'badge-info' :
              'badge-neutral'
            }`}>
              {col.inferred_type}
            </span>
            <span className="text-[9px] text-slate-600">{col.null_pct}% nulos</span>
          </div>
        </div>
      </td>
      <td>
        <div className="flex flex-wrap gap-1">
          {col.sample_values.slice(0, 3).map((v, i) => (
            <span key={i} className="text-[10px] bg-[#111827] px-1.5 py-0.5 rounded text-slate-400">
              {v}
            </span>
          ))}
        </div>
      </td>
      <td>
        <div className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={mapping.is_rut_column}
            onChange={e => onChange({ ...mapping, is_rut_column: e.target.checked })}
            className="w-3.5 h-3.5 accent-brand-500"
          />
          <span className="text-[10px] text-slate-500">RUT</span>
        </div>
      </td>
      <td>
        <select
          value={mapping.target_table ?? ''}
          onChange={e => onChange({
            ...mapping,
            target_table: e.target.value || null,
            target_column: null,
          })}
          className="input-base py-1 text-xs"
        >
          <option value="">— No mapear —</option>
          {targetTables.map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </td>
      <td>
        {mapping.target_table && (
          <select
            value={mapping.target_column ?? ''}
            onChange={e => onChange({ ...mapping, target_column: e.target.value || null })}
            className="input-base py-1 text-xs"
          >
            <option value="">— Seleccionar —</option>
            {TARGET_COLUMNS[mapping.target_table]?.map(c => (
              <option key={c.column} value={c.column}>{c.label}</option>
            ))}
          </select>
        )}
      </td>
      <td>
        <select
          value={mapping.transform_fn ?? ''}
          onChange={e => onChange({ ...mapping, transform_fn: e.target.value || null })}
          className="input-base py-1 text-xs"
        >
          <option value="">Ninguna</option>
          <option value="uppercase">MAYÚSCULAS</option>
          <option value="lowercase">minúsculas</option>
          <option value="trim">Trim</option>
          <option value="rut_format">Formato RUT</option>
        </select>
      </td>
    </tr>
  )
}

// ============================================================
// MAIN PAGE
// ============================================================

export default function IngestaPage() {
  // Jobs list
  const [jobs, setJobs] = useState<IngestionJob[]>([])
  const [jobsTotal, setJobsTotal] = useState(0)
  const [jobsPage, setJobsPage] = useState(1)
  const [jobsLoading, setJobsLoading] = useState(true)
  const [selectedJob, setSelectedJob] = useState<string | null>(null)
  const [jobLogs, setJobLogs] = useState<IngestionLog[]>([])

  // Wizard state
  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardStep, setWizardStep] = useState<WizardStep>('upload')
  const [fuentes, setFuentes] = useState<DataSource[]>([])
  const [selectedSource, setSelectedSource] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [parsedRows, setParsedRows] = useState<Record<string, string>[]>([])
  const [detectedColumns, setDetectedColumns] = useState<DetectedColumn[]>([])
  const [mappings, setMappings] = useState<ColumnMappingDraft[]>([])
  const [currentJob, setCurrentJob] = useState<IngestionJob | null>(null)
  const [processing, setProcessing] = useState(false)
  const [processLogs, setProcessLogs] = useState<string[]>([])
  const [mergeResult, setMergeResult] = useState<{merged: number; created: number} | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { loadJobs() }, [jobsPage])
  useEffect(() => { if (wizardOpen) loadFuentes() }, [wizardOpen])

  async function loadJobs() {
    setJobsLoading(true)
    const res = await fetch(`/api/ingestion?page=${jobsPage}&page_size=20`)
    const json = await res.json()
    setJobs(json.data ?? [])
    setJobsTotal(json.total ?? 0)
    setJobsLoading(false)
  }

  async function loadFuentes() {
    const res = await fetch('/api/fuentes')
    const json = await res.json()
    setFuentes(json.data ?? [])
  }

  async function loadJobLogs(jobId: string) {
    const res = await fetch(`/api/ingestion?job_id=${jobId}&section=logs`)
    const json = await res.json()
    setJobLogs(json.data ?? [])
  }

  function addProcessLog(msg: string) {
    setProcessLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`])
  }

  // Step 1: File Upload
  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
  }

  // Step 2: Detect columns
  async function handleDetectColumns() {
    if (!file) return
    setWizardStep('detect')

    const text = await file.text()
    const rows = parseCSV(text)
    setParsedRows(rows)

    const res = await fetch('/api/ingestion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'detect_columns', rows: rows.slice(0, 30) }),
    })
    const json = await res.json()
    const detected: DetectedColumn[] = json.data ?? []
    setDetectedColumns(detected)

    // Init mappings
    setMappings(detected.map(col => ({
      source_column: col.name,
      target_table: null,
      target_column: null,
      transform_fn: null,
      is_rut_column: col.inferred_type === 'rut',
      sample_values: col.sample_values,
      inferred_type: col.inferred_type,
    })))

    setWizardStep('map')
  }

  // Step 3: Process
  async function handleProcess() {
    setWizardStep('process')
    setProcessing(true)
    setProcessLogs([])

    addProcessLog(`Iniciando ingesta de ${parsedRows.length} filas...`)

    // Create job
    const jobRes = await fetch('/api/ingestion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create_job',
        source_id: selectedSource || null,
        file_name: file?.name,
        file_size: file?.size,
      }),
    })
    const jobJson = await jobRes.json()
    const job = jobJson.data
    setCurrentJob(job)
    addProcessLog(`Job creado: ${job.id}`)

    // Load staging
    addProcessLog('Cargando datos a staging...')
    const stagingRes = await fetch('/api/ingestion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'load_staging',
        job_id: job.id,
        rows: parsedRows,
        mappings,
      }),
    })
    const stagingJson = await stagingRes.json()
    addProcessLog(`Staging: ${stagingJson.valid} válidos, ${stagingJson.invalid} inválidos`)

    // Merge
    addProcessLog('Ejecutando merge hacia master_personas...')
    const mergeRes = await fetch('/api/ingestion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'merge', job_id: job.id }),
    })
    const mergeJson = await mergeRes.json()
    setMergeResult({ merged: mergeJson.merged, created: mergeJson.created })
    addProcessLog(`Merge: ${mergeJson.created} nuevos, ${mergeJson.merged} actualizados`)
    addProcessLog('✓ Proceso completado exitosamente')

    setProcessing(false)
    setWizardStep('done')
    loadJobs()
  }

  function resetWizard() {
    setWizardOpen(false)
    setWizardStep('upload')
    setFile(null)
    setParsedRows([])
    setDetectedColumns([])
    setMappings([])
    setCurrentJob(null)
    setProcessLogs([])
    setMergeResult(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const currentStepIndex = STEPS.findIndex(s => s.key === wizardStep)

  return (
    <>
      <Header
        title="Ingesta de datos"
        subtitle="Pipeline de carga, validación y merge"
        actions={
          <button onClick={() => setWizardOpen(true)} className="btn-primary">
            <Upload className="w-4 h-4" />
            Nueva ingesta
          </button>
        }
      />

      <div className="p-6 space-y-6">
        {/* Jobs List */}
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-[#253357]">
            <h3 className="text-sm font-semibold text-slate-200">
              Jobs de ingesta
              {jobsTotal > 0 && (
                <span className="ml-2 text-xs text-slate-500">({formatNumber(jobsTotal)})</span>
              )}
            </h3>
            <button onClick={loadJobs} className="btn-secondary text-xs py-1.5 px-3">
              <RefreshCw className="w-3 h-3" />
              Actualizar
            </button>
          </div>

          {jobsLoading ? (
            <LoadingState />
          ) : jobs.length === 0 ? (
            <EmptyState
              title="Sin jobs de ingesta"
              description="Sube un archivo para iniciar"
            />
          ) : (
            <>
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Archivo</th>
                    <th>Fuente</th>
                    <th>Estado</th>
                    <th>Filas</th>
                    <th>Válidas</th>
                    <th>Nuevos</th>
                    <th>Fecha</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map(job => (
                    <tr key={job.id}>
                      <td>
                        <div className="flex items-center gap-2">
                          <FileText className="w-3.5 h-3.5 text-slate-500" />
                          <span className="text-xs font-medium text-slate-200">
                            {job.file_name ?? 'Sin nombre'}
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className="text-xs text-slate-500">
                          {(job.data_source as DataSource)?.name ?? '—'}
                        </span>
                      </td>
                      <td><StatusBadge status={job.status} /></td>
                      <td><span className="text-xs">{formatNumber(job.total_rows)}</span></td>
                      <td>
                        <span className="text-xs text-green-400">{formatNumber(job.valid_rows)}</span>
                      </td>
                      <td>
                        <span className="text-xs text-brand-400">{formatNumber(job.new_rows)}</span>
                      </td>
                      <td>
                        <span className="text-xs text-slate-500">
                          {formatDatetime(job.created_at)}
                        </span>
                      </td>
                      <td>
                        <button
                          onClick={async () => {
                            setSelectedJob(job.id)
                            await loadJobLogs(job.id)
                          }}
                          className="btn-secondary text-xs py-1 px-2"
                        >
                          <Eye className="w-3 h-3" />
                          Logs
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-4">
                <Pagination
                  page={jobsPage}
                  totalPages={Math.ceil(jobsTotal / 20)}
                  total={jobsTotal}
                  pageSize={20}
                  onPageChange={setJobsPage}
                />
              </div>
            </>
          )}
        </div>

        {/* Job Logs */}
        {selectedJob && (
          <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-slate-200">
                Logs del job: <span className="font-mono text-xs text-brand-400">{selectedJob.slice(0,8)}...</span>
              </h3>
              <button onClick={() => setSelectedJob(null)} className="text-slate-500 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {jobLogs.map(log => (
                <div key={log.id} className="flex items-start gap-2 text-xs">
                  <span className={`flex-shrink-0 badge text-[9px] px-1 py-0 ${
                    log.level === 'error' ? 'badge-danger' :
                    log.level === 'warn' ? 'badge-warning' : 'badge-info'
                  }`}>
                    {log.level}
                  </span>
                  <span className="text-slate-400">{log.message}</span>
                  {log.row_number && (
                    <span className="text-slate-600">fila {log.row_number}</span>
                  )}
                </div>
              ))}
              {jobLogs.length === 0 && (
                <p className="text-xs text-slate-600">Sin logs para este job</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ================================================================
          WIZARD MODAL
          ================================================================ */}
      {wizardOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-start justify-center z-50 p-4 pt-8 overflow-y-auto">
          <div className="card w-full max-w-4xl animate-slide-in">
            {/* Wizard Header */}
            <div className="flex items-center justify-between p-5 border-b border-[#253357]">
              <h2 className="text-base font-semibold text-white">Pipeline de ingesta</h2>
              <button onClick={resetWizard} className="text-slate-500 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Steps */}
            <div className="flex items-center gap-0 px-5 py-4 border-b border-[#253357] overflow-x-auto">
              {STEPS.map((step, i) => (
                <div key={step.key} className="flex items-center">
                  <div className={`flex items-center gap-2 text-xs font-medium px-1 ${
                    i < currentStepIndex ? 'text-green-400' :
                    i === currentStepIndex ? 'text-white' : 'text-slate-600'
                  }`}>
                    <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${
                      i < currentStepIndex ? 'bg-green-500 text-white' :
                      i === currentStepIndex ? 'bg-brand-600 text-white' :
                      'bg-[#253357] text-slate-600'
                    }`}>
                      {i < currentStepIndex ? <Check className="w-3 h-3" /> : i + 1}
                    </div>
                    <span className="hidden sm:inline">{step.label}</span>
                  </div>
                  {i < STEPS.length - 1 && (
                    <ChevronRight className="w-3.5 h-3.5 text-slate-700 mx-1 flex-shrink-0" />
                  )}
                </div>
              ))}
            </div>

            {/* Step Content */}
            <div className="p-6">
              {/* STEP 1: Upload */}
              {wizardStep === 'upload' && (
                <div className="space-y-5">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">
                      Fuente de datos (opcional)
                    </label>
                    <select
                      value={selectedSource}
                      onChange={e => setSelectedSource(e.target.value)}
                      className="input-base"
                    >
                      <option value="">Sin fuente específica</option>
                      {fuentes.map(f => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                  </div>

                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all ${
                      file
                        ? 'border-green-500/50 bg-green-500/5'
                        : 'border-[#253357] hover:border-brand-500/50 hover:bg-brand-500/5'
                    }`}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv,.xlsx,.xls"
                      onChange={handleFileSelect}
                      className="hidden"
                    />
                    {file ? (
                      <div className="flex flex-col items-center gap-2">
                        <Check className="w-8 h-8 text-green-400" />
                        <p className="text-sm font-medium text-green-400">{file.name}</p>
                        <p className="text-xs text-slate-500">{formatFileSize(file.size)}</p>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <Upload className="w-8 h-8 text-slate-600" />
                        <p className="text-sm text-slate-400">Arrastra o haz click para subir</p>
                        <p className="text-xs text-slate-600">CSV o Excel (.csv, .xlsx)</p>
                      </div>
                    )}
                  </div>

                  <div className="flex justify-end">
                    <button
                      onClick={handleDetectColumns}
                      disabled={!file}
                      className="btn-primary"
                    >
                      Detectar columnas
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 2-3: Map (detect was merged into map) */}
              {wizardStep === 'map' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-slate-300">
                      Se detectaron <strong className="text-white">{detectedColumns.length}</strong> columnas en{' '}
                      <strong className="text-white">{formatNumber(parsedRows.length)}</strong> filas.
                      Mapea cada columna a su destino.
                    </p>
                  </div>

                  <div className="overflow-x-auto max-h-96 overflow-y-auto">
                    <table className="table-base">
                      <thead className="sticky top-0 bg-[#111827]">
                        <tr>
                          <th>Columna origen</th>
                          <th>Muestra</th>
                          <th>RUT?</th>
                          <th>Tabla destino</th>
                          <th>Columna destino</th>
                          <th>Transformación</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detectedColumns.map((col, i) => (
                          <MappingRow
                            key={col.name}
                            col={col}
                            mapping={mappings[i] ?? {
                              source_column: col.name,
                              target_table: null,
                              target_column: null,
                              transform_fn: null,
                              is_rut_column: false,
                              sample_values: col.sample_values,
                              inferred_type: col.inferred_type,
                            }}
                            onChange={updated => {
                              const newMappings = [...mappings]
                              newMappings[i] = updated
                              setMappings(newMappings)
                            }}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {!mappings.some(m => m.is_rut_column) && (
                    <div className="flex items-center gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                      <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                      <p className="text-xs text-amber-400">
                        Debes marcar al menos una columna como RUT para poder procesar los datos
                      </p>
                    </div>
                  )}

                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setWizardStep('upload')}
                      className="btn-secondary"
                    >
                      Atrás
                    </button>
                    <button
                      onClick={handleProcess}
                      disabled={!mappings.some(m => m.is_rut_column)}
                      className="btn-primary"
                    >
                      <Merge className="w-4 h-4" />
                      Procesar e ingestar
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 4: Processing */}
              {wizardStep === 'process' && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 mb-4">
                    {processing ? (
                      <Spinner size="sm" />
                    ) : (
                      <Check className="w-5 h-5 text-green-400" />
                    )}
                    <p className="text-sm font-medium text-white">
                      {processing ? 'Procesando datos...' : 'Proceso completado'}
                    </p>
                  </div>

                  <div className="bg-[#0d1529] rounded-xl p-4 font-mono text-xs space-y-1 max-h-48 overflow-y-auto">
                    {processLogs.map((log, i) => (
                      <p key={i} className={`${
                        log.includes('✓') ? 'text-green-400' :
                        log.includes('Error') ? 'text-red-400' :
                        'text-slate-400'
                      }`}>
                        {log}
                      </p>
                    ))}
                    {processing && (
                      <p className="text-brand-400 animate-pulse">█</p>
                    )}
                  </div>
                </div>
              )}

              {/* STEP 5: Done */}
              {wizardStep === 'done' && (
                <div className="text-center space-y-5 py-4">
                  <div className="w-16 h-16 rounded-full bg-green-500/15 flex items-center justify-center mx-auto border border-green-500/20">
                    <Check className="w-8 h-8 text-green-400" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-white">Ingesta completada</h3>
                    <p className="text-sm text-slate-400 mt-1">Los datos han sido procesados y mergeados</p>
                  </div>

                  {mergeResult && (
                    <div className="grid grid-cols-2 gap-4 max-w-xs mx-auto">
                      <div className="card p-4 text-center">
                        <p className="text-2xl font-bold text-brand-400">
                          {formatNumber(mergeResult.created)}
                        </p>
                        <p className="text-xs text-slate-500 mt-1">RUTs nuevos</p>
                      </div>
                      <div className="card p-4 text-center">
                        <p className="text-2xl font-bold text-green-400">
                          {formatNumber(mergeResult.merged)}
                        </p>
                        <p className="text-xs text-slate-500 mt-1">Actualizados</p>
                      </div>
                    </div>
                  )}

                  <div className="flex justify-center gap-3">
                    <button onClick={resetWizard} className="btn-secondary">
                      Cerrar
                    </button>
                    <button
                      onClick={() => {
                        resetWizard()
                        setWizardOpen(true)
                      }}
                      className="btn-primary"
                    >
                      Nueva ingesta
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
