'use client'

import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import {
  BrainCircuit,
  Cpu,
  Database,
  Download,
  Mail,
  Phone,
  RefreshCcw,
  ShieldCheck,
  Target,
  TrendingUp,
  Upload,
} from 'lucide-react'
import { Header } from '@/components/layout/Header'
import { EmptyState, LoadingState, Spinner } from '@/components/ui/Spinner'
import {
  cn,
  formatDate,
  formatNumber,
} from '@/lib/utils/formatters'
import type {
  EquifaxCatalogSummary,
  EquifaxCrmPushFilters,
  EquifaxPipelineLatestResponse,
  EquifaxPipelineRunResult,
  EquifaxCrmPushResult,
  EquifaxLeadGenerationResult,
  EquifaxLeadPreviewResult,
  EquifaxLeadScenario,
  EquifaxUniversePreviewResult,
  EquifaxProductCatalogItem,
} from '@/types/equifax'

type CatalogResponse = {
  summary: EquifaxCatalogSummary
  products: EquifaxProductCatalogItem[]
}

async function parseApiResponse<T>(res: Response): Promise<T> {
  const contentType = res.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    return res.json() as Promise<T>
  }

  const text = await res.text()
  throw new Error(text || 'La API respondió en un formato inesperado.')
}

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string
  value: string
  hint: string
  icon: typeof Database
}) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</div>
          <div className="mt-2 text-3xl font-semibold text-white">{value}</div>
          <div className="mt-1 text-xs text-slate-400">{hint}</div>
        </div>
        <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-3 text-cyan-300">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  )
}

function getTemperatureStyles(temperature: 'green' | 'yellow' | 'red') {
  if (temperature === 'green') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
  }
  if (temperature === 'yellow') {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-200'
  }
  return 'border-rose-500/30 bg-rose-500/10 text-rose-200'
}

function getTemperatureLabel(temperature: 'green' | 'yellow' | 'red') {
  if (temperature === 'green') return 'Verde'
  if (temperature === 'yellow') return 'Amarillo'
  return 'Rojo'
}

function getPipelineModeLabel(mode?: string | null) {
  if (mode === 'force') return 'Force'
  if (mode === 'dry-run') return 'Dry run'
  return 'Safe'
}

function getPipelineStatusStyles(status?: string | null) {
  if (status === 'success') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
  if (status === 'failed') return 'border-rose-500/30 bg-rose-500/10 text-rose-200'
  return 'border-amber-500/30 bg-amber-500/10 text-amber-200'
}

function formatPercent(value: unknown) {
  return `${formatNumber(Number(value ?? 0))}%`
}

function formatRatioAsPercent(value: unknown) {
  return `${formatNumber(Number(value ?? 0) * 100)}%`
}

async function parseSpreadsheet(file: File) {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: 'array', raw: false })
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) return []
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    raw: false,
    defval: '',
  })
}

async function extractPdfTextInBrowser(file: File) {
  const { PDFParse } = await import('pdf-parse')
  PDFParse.setWorker('/pdf.worker.min.mjs')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const parser = new PDFParse({ data: bytes })

  try {
    const result = await parser.getText()
    return String(result.text ?? '').trim()
  } finally {
    await parser.destroy()
  }
}

function downloadCsv(rows: EquifaxLeadGenerationResult['rows']) {
  if (!rows.length) return

  const headers = [
    'rutid',
    'company_name',
    'region',
    'comuna',
    'best_phone',
    'best_email',
    'phone_count',
    'email_count',
    'contactability_score',
    'purchase_propensity_score',
    'equifax_fit_score',
    'priority_score',
    'contact_probability',
    'interest_probability',
    'purchase_probability',
    'lead_score',
    'lead_temperature',
    'recommended_channel',
    'recommended_hour',
    'is_existing_customer',
    'last_equifax_sale_at',
    'services_bought',
    'reason_tags',
  ]

  const csv = [
    headers.join(','),
    ...rows.map(row => headers.map(header => {
      const rawValue = row[header as keyof typeof row]
      const value = Array.isArray(rawValue) ? rawValue.join(' | ') : String(rawValue ?? '')
      return `"${value.replace(/"/g, '""')}"`
    }).join(',')),
  ].join('\n')

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'equifax-leads-crm.csv'
  link.click()
  URL.revokeObjectURL(url)
}

export function EquifaxLeadBuilderPage() {
  const [loading, setLoading] = useState(true)
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([])
  const [prompt, setPrompt] = useState('')
  const [regions, setRegions] = useState('')
  const [volume, setVolume] = useState(30000)
  const [minPhoneCount, setMinPhoneCount] = useState(1)
  const [minEmailCount, setMinEmailCount] = useState(0)
  const [includeExistingCustomers, setIncludeExistingCustomers] = useState(true)
  const [savingProducts, setSavingProducts] = useState(false)
  const [buildingUniverse, setBuildingUniverse] = useState(false)
  const [useProductValidation, setUseProductValidation] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [generatingScenarioKey, setGeneratingScenarioKey] = useState<string | null>(null)
  const [pushingToCrm, setPushingToCrm] = useState(false)
  const [loadingPipeline, setLoadingPipeline] = useState(false)
  const [runningPipeline, setRunningPipeline] = useState(false)
  const [pipelineMode, setPipelineMode] = useState<'safe' | 'dry-run' | 'force'>('safe')
  const [universePreview, setUniversePreview] = useState<EquifaxUniversePreviewResult | null>(null)
  const [universeRequestKey, setUniverseRequestKey] = useState<string | null>(null)
  const [preview, setPreview] = useState<EquifaxLeadPreviewResult | null>(null)
  const [previewRequestKey, setPreviewRequestKey] = useState<string | null>(null)
  const [result, setResult] = useState<EquifaxLeadGenerationResult | null>(null)
  const [crmPushResult, setCrmPushResult] = useState<EquifaxCrmPushResult | null>(null)
  const [crmPushFilters, setCrmPushFilters] = useState<EquifaxCrmPushFilters>({
    allowed_temperatures: ['green', 'yellow'],
    min_lead_score: 35,
    min_contact_probability: 35,
    min_purchase_probability: 10,
    exclude_existing_customers: false,
    exclude_active_crm_targets: true,
    exclude_recent_crm_days: 7,
    max_leads: null,
  })
  const [pipelineOverview, setPipelineOverview] = useState<EquifaxPipelineLatestResponse | null>(null)
  const [pipelineRunResult, setPipelineRunResult] = useState<EquifaxPipelineRunResult | null>(null)
  const [productImportMessage, setProductImportMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function loadCatalog() {
    setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/equifax/catalog')
      const json = await parseApiResponse<{ success?: boolean; data?: CatalogResponse; error?: string }>(res)
      if (!res.ok) throw new Error(json.error ?? 'No se pudo cargar Equifax.')
      setCatalog(json.data ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando módulo Equifax.')
    } finally {
      setLoading(false)
    }
  }

  async function loadPipelineOverview() {
    setLoadingPipeline(true)

    try {
      const res = await fetch('/api/equifax/pipeline?section=latest')
      const json = await parseApiResponse<{ success?: boolean; data?: EquifaxPipelineLatestResponse; error?: string }>(res)
      if (!res.ok) throw new Error(json.error ?? 'No se pudo cargar el control del modelo Equifax.')
      setPipelineOverview(json.data ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el control del modelo Equifax.')
    } finally {
      setLoadingPipeline(false)
    }
  }

  useEffect(() => {
    loadCatalog()
    loadPipelineOverview()
  }, [])

  const selectedProducts = useMemo(() => {
    const ids = new Set(selectedProductIds)
    return (catalog?.products ?? []).filter(item => ids.has(item.id))
  }, [catalog?.products, selectedProductIds])

  const universePayload = useMemo(() => ({
    volume,
    regions: regions.split(',').map(item => item.trim()).filter(Boolean),
    include_existing_customers: includeExistingCustomers,
    min_phone_count: minPhoneCount,
    min_email_count: minEmailCount,
    universe_source: 'fresh_companies' as const,
    scored_universe_limit: Math.min(180000, Math.max(Math.ceil(volume * 6), 60000)),
  }), [
    includeExistingCustomers,
    minEmailCount,
    minPhoneCount,
    regions,
    volume,
  ])

  const generationPayload = useMemo(() => ({
    ...universePayload,
    product_ids: useProductValidation ? selectedProductIds : [],
    prompt,
  }), [
    prompt,
    selectedProductIds,
    universePayload,
    useProductValidation,
  ])

  const currentRequestKey = useMemo(
    () => JSON.stringify(generationPayload),
    [generationPayload]
  )
  const currentUniverseRequestKey = useMemo(
    () => JSON.stringify(universePayload),
    [universePayload]
  )

  const isPreviewStale = Boolean(preview && previewRequestKey && previewRequestKey !== currentRequestKey)
  const isUniverseStale = Boolean(universePreview && universeRequestKey && universeRequestKey !== currentUniverseRequestKey)
  const hasValidatedUniverse = Boolean(universePreview && universeRequestKey === currentUniverseRequestKey)
  const latestPipelineRun = pipelineOverview?.latest as Record<string, unknown> | null
  const latestPipelineStatus = String(latestPipelineRun?.status ?? '')
  const pipelineIsActive = latestPipelineStatus === 'running'
  const latestTraining = latestPipelineRun?.training_payload as Record<string, unknown> | null
  const latestTargets = Array.isArray(latestTraining?.targets)
    ? latestTraining.targets as Array<Record<string, unknown>>
    : []
  const crosscheckOverall = pipelineOverview?.crosscheck?.overall ?? null
  const crosscheckByTemperature = pipelineOverview?.crosscheck?.by_temperature ?? []

  useEffect(() => {
    if (latestPipelineStatus !== 'running') return

    const intervalId = window.setInterval(() => {
      void loadPipelineOverview()
    }, 5000)

    return () => window.clearInterval(intervalId)
  }, [latestPipelineStatus])

  async function handleProductUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setSavingProducts(true)
    setError(null)
    setProductImportMessage(null)

    try {
      const lowerName = file.name.toLowerCase()
      let insertedIds: string[] = []

      if (lowerName.endsWith('.pdf')) {
        const extractedText = await extractPdfTextInBrowser(file)
        if (!extractedText) {
          throw new Error('No pude extraer texto útil desde el PDF.')
        }

        const res = await fetch('/api/equifax/catalog', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            file_name: file.name,
            document_text: extractedText.slice(0, 120000),
          }),
        })
        const json = await parseApiResponse<{ success?: boolean; data?: { items?: EquifaxProductCatalogItem[]; extracted_products?: number }; error?: string }>(res)
        if (!res.ok) throw new Error(json.error ?? 'No se pudo procesar el PDF.')

        insertedIds = (json.data?.items ?? []).map((item: EquifaxProductCatalogItem) => item.id)
        setProductImportMessage(
          `PDF procesado: ${formatNumber(json.data?.extracted_products ?? insertedIds.length)} producto(s) extraído(s).`
        )
      } else {
        const rows = await parseSpreadsheet(file)
        if (rows.length === 0) {
          throw new Error('El archivo no trae filas válidas de productos.')
        }

        const res = await fetch('/api/equifax/catalog', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ rows }),
        })
        const json = await parseApiResponse<{ success?: boolean; data?: { items?: EquifaxProductCatalogItem[] }; error?: string }>(res)
        if (!res.ok) throw new Error(json.error ?? 'No se pudo guardar el catálogo.')

        insertedIds = (json.data?.items ?? []).map((item: EquifaxProductCatalogItem) => item.id)
        setProductImportMessage(`Se cargaron ${formatNumber(insertedIds.length)} producto(s) desde planilla.`)
      }
      setSelectedProductIds(prev => [...new Set([...insertedIds, ...prev])])
      await loadCatalog()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo subir productos.')
    } finally {
      setSavingProducts(false)
      event.target.value = ''
    }
  }

  async function handleBuildUniverse() {
    setBuildingUniverse(true)
    setError(null)
    setPreview(null)
    setResult(null)

    try {
      const res = await fetch('/api/equifax/leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'preview_universe',
          ...universePayload,
        }),
      })
      const json = await parseApiResponse<{ success?: boolean; data?: EquifaxUniversePreviewResult; error?: string }>(res)
      if (!res.ok) throw new Error(json.error ?? 'No se pudo construir el universo.')
      setUniversePreview(json.data ?? null)
      setUniverseRequestKey(currentUniverseRequestKey)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo construir el universo.')
    } finally {
      setBuildingUniverse(false)
    }
  }

  async function handleAnalyze() {
    setAnalyzing(true)
    setError(null)
    setResult(null)

    try {
      const res = await fetch('/api/equifax/leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'preview',
          ...generationPayload,
        }),
      })
      const json = await parseApiResponse<{ success?: boolean; data?: EquifaxLeadPreviewResult; error?: string }>(res)
      if (!res.ok) throw new Error(json.error ?? 'No se pudieron analizar escenarios.')
      setPreview(json.data ?? null)
      setPreviewRequestKey(currentRequestKey)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron analizar escenarios.')
    } finally {
      setAnalyzing(false)
    }
  }

  async function handleGenerateScenario(scenario: EquifaxLeadScenario) {
    setGeneratingScenarioKey(scenario.key)
    setError(null)
    setCrmPushResult(null)

    try {
      const res = await fetch('/api/equifax/leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'generate',
          scenario_key: scenario.key,
          ...generationPayload,
        }),
      })
      const json = await parseApiResponse<{ success?: boolean; data?: EquifaxLeadGenerationResult; error?: string }>(res)
      if (!res.ok) throw new Error(json.error ?? 'No se pudo generar la base elegida.')
      setResult(json.data ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo generar la base elegida.')
    } finally {
      setGeneratingScenarioKey(null)
    }
  }

  async function handlePushToCrm() {
    if (!result?.run_id) return

    setPushingToCrm(true)
    setError(null)

    try {
      const res = await fetch('/api/equifax/leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'push_to_crm',
          run_id: result.run_id,
          allowed_temperatures: crmPushFilters.allowed_temperatures,
          min_lead_score: crmPushFilters.min_lead_score,
          min_contact_probability: crmPushFilters.min_contact_probability,
          min_purchase_probability: crmPushFilters.min_purchase_probability,
          exclude_existing_customers: crmPushFilters.exclude_existing_customers,
          exclude_active_crm_targets: crmPushFilters.exclude_active_crm_targets,
          exclude_recent_crm_days: crmPushFilters.exclude_recent_crm_days,
          max_leads: crmPushFilters.max_leads,
        }),
      })
      const json = await parseApiResponse<{ success?: boolean; data?: EquifaxCrmPushResult; error?: string }>(res)
      if (!res.ok) throw new Error(json.error ?? 'No se pudo exportar el run al CRM.')
      setCrmPushResult(json.data ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo exportar el run al CRM.')
    } finally {
      setPushingToCrm(false)
    }
  }

  async function handleRunPipeline() {
    setRunningPipeline(true)
    setError(null)

    try {
      const res = await fetch('/api/equifax/pipeline', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'run',
          mode: pipelineMode,
        }),
      })
      const json = await parseApiResponse<{ success?: boolean; data?: EquifaxPipelineRunResult; error?: string }>(res)
      if (!res.ok) throw new Error(json.error ?? 'No se pudieron actualizar los colores Equifax.')
      setPipelineRunResult(json.data ?? null)
      await loadPipelineOverview()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron actualizar los colores Equifax.')
    } finally {
      setRunningPipeline(false)
    }
  }

  if (loading) {
    return <LoadingState text="Cargando módulo Equifax..." />
  }

  return (
    <>
      <Header
        title="Armado de BDD Equifax"
        subtitle="Histórico de ventas, catálogo de productos y priorización IA para bases listas para CRM"
        actions={result?.rows?.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handlePushToCrm}
              disabled={pushingToCrm}
              className="inline-flex items-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs font-semibold text-cyan-300 transition hover:bg-cyan-500/15 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pushingToCrm ? <Spinner size="sm" /> : <Upload className="h-4 w-4" />}
              {crmPushResult?.run_id === result.run_id ? 'Reenviar al CRM' : 'Enviar al CRM'}
            </button>
            <button
              onClick={() => downloadCsv(result.rows)}
              className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-500/15"
            >
              <Download className="h-4 w-4" />
              Exportar CSV CRM
            </button>
          </div>
        ) : null}
      />

      <div className="space-y-6 p-6">
        {error && (
          <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Ventas Equifax"
            value={formatNumber(catalog?.summary.total_sales ?? 0)}
            hint={`${formatNumber(catalog?.summary.total_customers ?? 0)} empresas con compra histórica`}
            icon={Database}
          />
          <StatCard
            label="Catálogo Activo"
            value={formatNumber(catalog?.summary.total_products ?? 0)}
            hint="Productos disponibles para priorización"
            icon={Target}
          />
          <StatCard
            label="Recurrentes"
            value={formatNumber(catalog?.summary.recurrent_sales ?? 0)}
            hint="Ventas de continuidad ya cargadas"
            icon={RefreshCcw}
          />
          <StatCard
            label="One Time"
            value={formatNumber(catalog?.summary.one_time_sales ?? 0)}
            hint={`Última venta: ${formatDate(catalog?.summary.last_sale_at)}`}
            icon={BrainCircuit}
          />
        </div>

        <section className="card p-5">
          <div>
            <h2 className="text-sm font-semibold text-white">1. Definir universo a trabajar</h2>
            <p className="mt-1 text-xs text-slate-400">
              Partimos desde empresas activas, sacamos lo ya gestionado por call/CRM y limpiamos no-target antes de aplicar colores.
            </p>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="block">
              <span className="text-xs font-medium text-slate-400">¿Cuántos registros quieres exportar?</span>
              <select
                value={volume}
                onChange={event => setVolume(Number(event.target.value))}
                className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
              >
                <option value={30000}>30.000 registros</option>
                <option value={40000}>40.000 registros</option>
                <option value={50000}>50.000 registros</option>
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-400">Mínimo teléfonos</span>
              <input
                type="number"
                min={0}
                max={10}
                value={minPhoneCount}
                onChange={event => setMinPhoneCount(Number(event.target.value))}
                className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-400">Mínimo emails</span>
              <input
                type="number"
                min={0}
                max={10}
                value={minEmailCount}
                onChange={event => setMinEmailCount(Number(event.target.value))}
                className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
              />
            </label>

            <label className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-3 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={includeExistingCustomers}
                onChange={event => setIncludeExistingCustomers(event.target.checked)}
              />
              <span>Incluir clientes Equifax actuales</span>
            </label>
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
            <label className="block">
              <span className="text-xs font-medium text-slate-400">Regiones objetivo</span>
              <input
                value={regions}
                onChange={event => setRegions(event.target.value)}
                placeholder="Ej: Metropolitana, Valparaíso, Biobío"
                className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
              />
            </label>

            <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-3 text-xs text-slate-400">
              La base se arma en cascada: empresas activas 2024, sin gestión previa de call, sin iglesias/corporaciones/fundaciones/gobierno y con contacto útil.
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              onClick={handleBuildUniverse}
              disabled={buildingUniverse}
              className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {buildingUniverse ? <Spinner size="sm" /> : <Database className="h-4 w-4" />}
              {universePreview ? 'Reconstruir universo' : 'Buscar universo'}
            </button>
            {isUniverseStale && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                Cambiaste reglas. Vuelve a buscar el universo.
              </div>
            )}
          </div>

          {universePreview && (
            <div className="mt-5 space-y-4">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                <div className="rounded-xl border border-slate-800 bg-slate-950/45 px-3 py-3">
                  <div className="text-lg font-semibold text-white">{formatNumber(universePreview.eligible_matches)}</div>
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Listos para exportar</div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/45 px-3 py-3">
                  <div className="text-lg font-semibold text-white">{formatNumber(universePreview.universe_analyzed)}</div>
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Universo revisado</div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/45 px-3 py-3">
                  <div className="text-lg font-semibold text-white">{formatNumber(universePreview.summary.with_phone)}</div>
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Con teléfono</div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/45 px-3 py-3">
                  <div className="text-lg font-semibold text-white">{formatNumber(universePreview.summary.with_email)}</div>
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Con email</div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/45 px-3 py-3">
                  <div className="text-lg font-semibold text-white">{formatNumber(universePreview.summary.pyme)}</div>
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">PyME</div>
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Reglas aplicadas</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {universePreview.rules.map(rule => (
                      <span key={rule} className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-200">
                        {rule}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Muestra top</div>
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    {universePreview.sample_rows.slice(0, 4).map(row => (
                      <div key={row.rutid} className="rounded-lg border border-slate-800 bg-slate-950/45 px-3 py-2">
                        <div className="text-sm font-medium text-white">{row.company_name}</div>
                        <div className="mt-1 text-xs text-slate-400">{row.region ?? 'Sin región'} · {row.segment ?? 'Sin segmento'}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        <div className="grid gap-6">
          <section className="card p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-white">2. Validación de productos Equifax</h2>
                <p className="mt-1 text-xs text-slate-400">
                  Opcional: usa productos para ajustar el fit comercial después de validar el universo.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-200">
                  <input
                    type="checkbox"
                    checked={useProductValidation}
                    onChange={event => setUseProductValidation(event.target.checked)}
                  />
                  <span>Incluir productos</span>
                </label>
                {savingProducts && <Spinner size="sm" />}
              </div>
            </div>

            <label className="mt-4 flex cursor-pointer items-center justify-center gap-3 rounded-2xl border border-dashed border-amber-500/35 bg-amber-500/5 px-4 py-6 text-sm text-amber-200 transition hover:bg-amber-500/10">
              <Upload className="h-4 w-4" />
              <span>Subir catálogo o PDF comercial</span>
              <input
                type="file"
                accept=".xlsx,.xls,.csv,.pdf"
                className="hidden"
                onChange={handleProductUpload}
              />
            </label>

            <p className="mt-3 text-xs text-slate-500">
              Ejemplo: brochure PDF, ficha de producto, propuesta comercial o planilla estructurada.
            </p>

            {productImportMessage && (
              <div className="mt-4 rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-4 text-sm text-emerald-100">
                {productImportMessage}
              </div>
            )}

            <div className="mt-5 flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Productos seleccionados
              </div>
              <div className="text-xs text-slate-500">{formatNumber(selectedProducts.length)} elegidos</div>
            </div>

            {(catalog?.products?.length ?? 0) === 0 ? (
              <EmptyState
                title="Sin productos cargados"
                description="Sube el catálogo comercial para que el motor pueda inferir el mejor fit."
              />
            ) : (
              <div className="mt-3 max-h-[360px] space-y-2 overflow-y-auto pr-1">
                {catalog?.products.map(product => {
                  const checked = selectedProductIds.includes(product.id)
                  return (
                    <label
                      key={product.id}
                      className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-2xl border px-3 py-3 transition',
                        checked
                          ? 'border-cyan-500/35 bg-cyan-500/10'
                          : 'border-slate-800 bg-slate-950/30 hover:border-slate-700'
                      )}
                    >
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={checked}
                        onChange={event => {
                          setSelectedProductIds(prev =>
                            event.target.checked
                              ? [...prev, product.id]
                              : prev.filter(id => id !== product.id)
                          )
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="font-medium text-white">{product.name}</div>
                          {product.category && (
                            <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-400">
                              {product.category}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-xs text-slate-400">
                          {product.description || product.target_rubro || 'Sin descripción adicional'}
                        </div>
                        {!!product.target_company_keywords?.length && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {product.target_company_keywords.slice(0, 6).map(keyword => (
                              <span key={`${product.id}-${keyword}`} className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300">
                                {keyword}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </label>
                  )
                })}
              </div>
            )}
          </section>
        </div>

        <section className="card p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-white">3. Aplicar colores al universo</h2>
              <p className="mt-1 text-xs text-slate-400">
                Después de definir el universo, actualiza el semáforo y valida los modelos que colorean la base final.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={pipelineMode}
                onChange={event => setPipelineMode(event.target.value as 'safe' | 'dry-run' | 'force')}
                disabled={!hasValidatedUniverse || runningPipeline || pipelineIsActive}
                className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-white outline-none focus:border-cyan-500"
              >
                <option value="safe">Modo safe</option>
                <option value="dry-run">Modo dry-run</option>
                <option value="force">Modo force</option>
              </select>
              <button
                onClick={handleRunPipeline}
                disabled={!hasValidatedUniverse || runningPipeline || pipelineIsActive}
                className="inline-flex items-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs font-semibold text-cyan-300 transition hover:bg-cyan-500/15 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {runningPipeline || pipelineIsActive ? <Spinner size="sm" /> : <RefreshCcw className="h-4 w-4" />}
                {!hasValidatedUniverse ? 'Primero valida universo' : pipelineIsActive ? 'Colores actualizándose' : 'Actualizar colores'}
              </button>
            </div>
          </div>

          {pipelineRunResult && (
            <div className={cn(
              'mt-4 rounded-2xl border px-4 py-3 text-sm',
              pipelineRunResult.status === 'failed'
                ? 'border-rose-500/25 bg-rose-500/10 text-rose-100'
                : pipelineRunResult.status === 'running'
                  ? 'border-amber-500/25 bg-amber-500/10 text-amber-100'
                  : 'border-cyan-500/25 bg-cyan-500/10 text-cyan-100'
            )}>
              {pipelineRunResult.status === 'running'
                ? `${pipelineRunResult.message ?? (pipelineRunResult.already_running ? 'Ya había una corrida en progreso.' : 'Colores en actualización.')} Run ${pipelineRunResult.run_id} · modo ${getPipelineModeLabel(pipelineRunResult.trigger_mode)}.`
                : `Colores actualizados. Run ${pipelineRunResult.run_id} · modo ${getPipelineModeLabel(pipelineRunResult.trigger_mode)} · ${formatNumber(pipelineRunResult.refreshed_rutids)} RUTs refrescados.`}
            </div>
          )}

          <div className="mt-5 grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
            <div className="space-y-4">
              <div className="rounded-2xl border border-slate-800 bg-slate-950/35 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Última corrida</div>
                  {loadingPipeline && <Spinner size="sm" />}
                </div>

                {latestPipelineRun ? (
                  <div className="mt-3 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-semibold', getPipelineStatusStyles(String(latestPipelineRun.status ?? 'running')))}>
                        {String(latestPipelineRun.status ?? 'running')}
                      </span>
                      <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300">
                        {getPipelineModeLabel(String(latestPipelineRun.trigger_mode ?? 'safe'))}
                      </span>
                      <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300">
                        {String(latestPipelineRun.trigger_source ?? 'manual')}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
                        <div className="text-lg font-semibold text-white">{formatNumber(Number(latestPipelineRun.refreshed_rutids ?? 0))}</div>
                        <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">RUTs refrescados</div>
                      </div>
                      <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
                        <div className="text-lg font-semibold text-white">{formatNumber(Number(latestPipelineRun.models_trained ?? 0))}</div>
                        <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Targets evaluados</div>
                      </div>
                    </div>

                    <div className="text-xs text-slate-400">
                      Inició {formatDate(String(latestPipelineRun.started_at ?? null))} · terminó {formatDate(String(latestPipelineRun.finished_at ?? null))}
                    </div>
                    {Boolean(latestPipelineRun.notes) && (
                      <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-300">
                        {String(latestPipelineRun.notes)}
                      </div>
                    )}
                    {Boolean(latestPipelineRun.error_message) && (
                      <div className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                        {String(latestPipelineRun.error_message)}
                      </div>
                    )}
                  </div>
                ) : (
                  <EmptyState
                    title="Sin corridas registradas"
                    description="Cuando ejecutes el pipeline, aquí verás el estado del aprendizaje y las proyecciones."
                  />
                )}
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-950/35 p-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <Cpu className="h-4 w-4 text-cyan-300" />
                  Modelos activos
                </div>
                <div className="mt-3 space-y-2">
                  {(pipelineOverview?.active_models?.length ?? 0) > 0 ? pipelineOverview?.active_models.map(model => {
                    const validation = (model.metrics?.validation ?? {}) as Record<string, unknown>
                    return (
                      <div key={`${model.target}-${model.model_version}`} className="rounded-xl border border-slate-800 bg-slate-950/45 px-3 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="rounded-full border border-cyan-500/25 bg-cyan-500/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-200">
                              {model.target}
                            </span>
                            <span className="text-sm font-medium text-white">{model.model_version}</span>
                          </div>
                          <span className="text-[11px] text-slate-500">{formatDate(model.trained_at)}</span>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-300">
                          <div>Valid loss: {formatNumber(Number(validation.log_loss ?? 0))}</div>
                          <div>Accuracy: {formatPercent(validation.accuracy)}</div>
                          <div>Top decile: {formatPercent(validation.top_decile_precision)}</div>
                          <div>Filas: {formatNumber(model.trained_rows)}</div>
                        </div>
                      </div>
                    )
                  }) : (
                    <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-3 text-sm text-slate-400">
                      Sin modelos activos visibles todavía.
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-2xl border border-slate-800 bg-slate-950/35 p-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <TrendingUp className="h-4 w-4 text-emerald-300" />
                  Proyección esperada
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {[
                    { key: 'portfolio', label: 'Portfolio completo', bucket: pipelineOverview?.projections?.portfolio },
                    { key: 'top_1000', label: 'Top 1.000', bucket: pipelineOverview?.projections?.top_1000 },
                    { key: 'top_3000', label: 'Top 3.000', bucket: pipelineOverview?.projections?.top_3000 },
                    { key: 'top_10000', label: 'Top 10.000', bucket: pipelineOverview?.projections?.top_10000 },
                  ].map(item => (
                    <div key={item.key} className="rounded-xl border border-slate-800 bg-slate-950/45 p-3">
                      <div className="text-sm font-semibold text-white">{item.label}</div>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <div>
                          <div className="text-lg font-semibold text-cyan-300">{formatNumber(item.bucket?.expected_contacts ?? 0)}</div>
                          <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Contactos esp.</div>
                        </div>
                        <div>
                          <div className="text-lg font-semibold text-amber-300">{formatNumber(item.bucket?.expected_interests ?? 0)}</div>
                          <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Intereses esp.</div>
                        </div>
                        <div>
                          <div className="text-lg font-semibold text-emerald-300">{formatNumber(item.bucket?.expected_purchases ?? 0)}</div>
                          <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Compras esp.</div>
                        </div>
                        <div>
                          <div className="text-lg font-semibold text-white">{formatPercent(item.bucket?.avg_lead_score ?? 0)}</div>
                          <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Lead score prom.</div>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
                        <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-emerald-200">
                          {formatNumber(item.bucket?.green ?? 0)} verdes
                        </span>
                        <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-amber-200">
                          {formatNumber(item.bucket?.yellow ?? 0)} amarillos
                        </span>
                        <span className="rounded-full border border-rose-500/25 bg-rose-500/10 px-2 py-1 text-rose-200">
                          {formatNumber(item.bucket?.red ?? 0)} rojos
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-950/35 p-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <ShieldCheck className="h-4 w-4 text-cyan-300" />
                  Guardrails de entrenamiento
                </div>
                <div className="mt-3 space-y-2">
                  {latestTargets.length > 0 ? latestTargets.map(target => (
                    <div key={String(target.target)} className="rounded-xl border border-slate-800 bg-slate-950/45 px-3 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300">
                            {String(target.target)}
                          </span>
                          <span className={cn(
                            'rounded-full border px-2 py-0.5 text-[11px] font-semibold',
                            target.activated
                              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                              : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                          )}>
                            {target.activated ? 'Activo' : 'No activo'}
                          </span>
                        </div>
                        <span className="text-[11px] text-slate-500">{String(target.activation_reason ?? 'sin motivo')}</span>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-300">
                        <div>Val. loss: {formatNumber(Number(target.validation_log_loss ?? 0))}</div>
                        <div>Heurística loss: {formatNumber(Number(target.heuristic_validation_log_loss ?? 0))}</div>
                        <div>Val. accuracy: {formatPercent(target.validation_accuracy)}</div>
                        <div>Top decile: {formatPercent(target.validation_top_decile_precision)}</div>
                      </div>
                    </div>
                  )) : (
                    <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-3 text-sm text-slate-400">
                      La última corrida todavía no trae targets evaluados visibles.
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-950/35 p-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <ShieldCheck className="h-4 w-4 text-emerald-300" />
                  Cross-check histórico del semáforo
                </div>

                {pipelineOverview?.crosscheck ? (
                  <div className="mt-3 space-y-3">
                    <div className="rounded-xl border border-slate-800 bg-slate-950/45 px-3 py-3 text-xs text-slate-300">
                      Valida el modelo actual contra RUTs con feedback real. Muestra si cada color sostiene contacto y compra observada, en vez de asumir que el umbral está bien.
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-xl border border-slate-800 bg-slate-950/45 px-3 py-3">
                        <div className="text-lg font-semibold text-white">{formatNumber(pipelineOverview.crosscheck.sample_size)}</div>
                        <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Casos con feedback</div>
                      </div>
                      <div className="rounded-xl border border-slate-800 bg-slate-950/45 px-3 py-3">
                        <div className="text-lg font-semibold text-white">{pipelineOverview.crosscheck.model_type}</div>
                        <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Modelo evaluado</div>
                      </div>
                    </div>

                    {crosscheckOverall && (
                      <div className="rounded-xl border border-slate-800 bg-slate-950/45 px-3 py-3 text-xs text-slate-300">
                        <div className="mb-2 text-sm font-semibold text-white">Base histórica total</div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>Contacto real: {formatRatioAsPercent(crosscheckOverall.actual_contact_rate)}</div>
                          <div>Compra real: {formatRatioAsPercent(crosscheckOverall.actual_purchase_rate)}</div>
                          <div>Teléfonos prom.: {formatNumber(crosscheckOverall.avg_phone_count)}</div>
                          <div>Emails prom.: {formatNumber(crosscheckOverall.avg_email_count)}</div>
                        </div>
                      </div>
                    )}

                    <div className="space-y-2">
                      {crosscheckByTemperature.map(bucket => (
                        <div key={bucket.temperature} className="rounded-xl border border-slate-800 bg-slate-950/45 px-3 py-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-semibold', getTemperatureStyles(bucket.temperature as 'green' | 'yellow' | 'red'))}>
                              {getTemperatureLabel(bucket.temperature as 'green' | 'yellow' | 'red')}
                            </span>
                            <span className="text-[11px] text-slate-500">
                              {formatNumber(bucket.sample_size)} casos · {formatRatioAsPercent(bucket.share)} de la muestra
                            </span>
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-300">
                            <div>Contacto pred.: {formatPercent(bucket.avg_contact_probability)}</div>
                            <div>Contacto real: {formatRatioAsPercent(bucket.actual_contact_rate)}</div>
                            <div>Compra pred.: {formatPercent(bucket.avg_purchase_probability)}</div>
                            <div>Compra real: {formatRatioAsPercent(bucket.actual_purchase_rate)}</div>
                            <div>Lead score prom.: {formatPercent(bucket.avg_lead_score)}</div>
                            <div>Cobertura prom.: {formatPercent(bucket.avg_coverage_pct)}</div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="rounded-xl border border-slate-800 bg-slate-950/45 px-3 py-3 text-xs text-slate-400">
                      Verde exige contacto &gt;= {formatNumber(pipelineOverview.crosscheck.thresholds.green.min_contact_probability)}%, compra &gt;= {formatNumber(pipelineOverview.crosscheck.thresholds.green.min_purchase_probability)}% y lead score &gt;= {formatNumber(pipelineOverview.crosscheck.thresholds.green.min_lead_score)}. Amarillo exige contacto &gt;= {formatNumber(pipelineOverview.crosscheck.thresholds.yellow.min_contact_probability)}% y lead score &gt;= {formatNumber(pipelineOverview.crosscheck.thresholds.yellow.min_lead_score)}.
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-3 text-sm text-slate-400">
                    Todavía no hay suficiente feedback histórico para cruzar colores vs. resultados reales.
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="card p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-white">4. Explorar escenarios y generar base</h2>
              <p className="mt-1 text-xs text-slate-400">
                Con el universo definido y los colores disponibles, analizamos escenarios y generamos la base final.
              </p>
            </div>
            {analyzing && <Spinner size="sm" />}
          </div>

          <div className="mt-5 grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-3 text-xs text-slate-400">
              Exportación objetivo: {formatNumber(volume)} registros · mínimo {formatNumber(minPhoneCount)} teléfono(s) · mínimo {formatNumber(minEmailCount)} email(s){regions ? ` · regiones: ${regions}` : ''}.
            </div>
            <label className="block">
              <span className="text-xs font-medium text-slate-400">Brief comercial para la IA</span>
              <textarea
                value={prompt}
                onChange={event => setPrompt(event.target.value)}
                rows={3}
                placeholder="Ej: prioriza empresas con alta contactabilidad, foco en B2B, riesgo y verificación comercial."
                className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
              />
            </label>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              onClick={handleAnalyze}
              disabled={analyzing || !hasValidatedUniverse || isUniverseStale || (useProductValidation && selectedProductIds.length === 0)}
              className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <BrainCircuit className="h-4 w-4" />
              {preview ? 'Reestimar escenarios' : 'Estimar escenarios'}
            </button>
            {preview && (
              <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-300">
                Universo analizado: {formatNumber(preview.universe_analyzed)} · Matches elegibles: {formatNumber(preview.eligible_matches)}
              </div>
            )}
            <div className="text-xs text-slate-500">
              {!hasValidatedUniverse
                ? 'Primero busca y valida el universo'
                : useProductValidation
                  ? selectedProducts.length > 0
                    ? `${formatNumber(selectedProducts.length)} producto(s) seleccionado(s)`
                    : 'Selecciona al menos un producto o desactiva validación de productos'
                  : 'Validación de productos desactivada'}
            </div>
          </div>

          {preview && (
            <div className="mt-5 space-y-4">
              {isPreviewStale && (
                <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                  Cambiaste filtros después del último análisis. Vuelve a analizar para recalcular escenarios antes de generar una base final.
                </div>
              )}

              <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">Lectura de la IA</div>
                <p className="mt-2 text-sm text-slate-200">
                  {String(preview.ai_profile.notes ?? 'Sin explicación adicional.')}
                </p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {Array.isArray(preview.ai_profile.buyer_signals) && preview.ai_profile.buyer_signals.map(signal => (
                    <span key={String(signal)} className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-200">
                      {String(signal)}
                    </span>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-3">
                {preview.scenarios.map(scenario => {
                  const isRecommended = preview.recommended_scenario_key === scenario.key
                  const isGenerating = generatingScenarioKey === scenario.key

                  return (
                    <div
                      key={scenario.key}
                      className={cn(
                        'rounded-2xl border p-4',
                        isRecommended
                          ? 'border-cyan-500/35 bg-cyan-500/8'
                          : 'border-slate-800 bg-slate-950/35'
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-sm font-semibold text-white">{scenario.title}</h3>
                            {isRecommended && (
                              <span className="rounded-full border border-cyan-500/35 bg-cyan-500/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-200">
                                Recomendado
                              </span>
                            )}
                          </div>
                          <p className="mt-2 text-xs text-slate-400">{scenario.description}</p>
                        </div>
                        {isGenerating && <Spinner size="sm" />}
                      </div>

                      <div className="mt-4 grid grid-cols-2 gap-2">
                        <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
                          <div className="text-lg font-semibold text-white">{formatNumber(scenario.generated_count)}</div>
                          <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Volumen</div>
                        </div>
                        <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
                          <div className="text-lg font-semibold text-white">{formatNumber(scenario.summary.avg_priority_score)}</div>
                          <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Priority</div>
                        </div>
                        <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
                          <div className="text-lg font-semibold text-white">{formatNumber(scenario.summary.existing_customers)}</div>
                          <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Clientes</div>
                        </div>
                        <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
                          <div className="text-lg font-semibold text-white">{formatNumber(scenario.summary.prospects)}</div>
                          <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Prospects</div>
                        </div>
                      </div>

                      <div className="mt-3 grid grid-cols-3 gap-2">
                        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/8 px-3 py-2 text-center">
                          <div className="text-sm font-semibold text-emerald-200">{formatNumber(scenario.summary.green_leads)}</div>
                          <div className="text-[10px] uppercase tracking-[0.16em] text-emerald-300/80">Verde</div>
                        </div>
                        <div className="rounded-xl border border-amber-500/20 bg-amber-500/8 px-3 py-2 text-center">
                          <div className="text-sm font-semibold text-amber-200">{formatNumber(scenario.summary.yellow_leads)}</div>
                          <div className="text-[10px] uppercase tracking-[0.16em] text-amber-300/80">Amarillo</div>
                        </div>
                        <div className="rounded-xl border border-rose-500/20 bg-rose-500/8 px-3 py-2 text-center">
                          <div className="text-sm font-semibold text-rose-200">{formatNumber(scenario.summary.red_leads)}</div>
                          <div className="text-[10px] uppercase tracking-[0.16em] text-rose-300/80">Rojo</div>
                        </div>
                      </div>

                      <div className="mt-4 space-y-2">
                        {scenario.highlights.map(highlight => (
                          <div key={`${scenario.key}-${highlight}`} className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-300">
                            {highlight}
                          </div>
                        ))}
                      </div>

                      <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-3 text-xs text-emerald-100">
                        {scenario.recommendation}
                      </div>

                      <div className="mt-4">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Muestra top</div>
                        <div className="mt-2 space-y-2">
                          {scenario.sample_rows.slice(0, 4).map(row => (
                            <div key={`${scenario.key}-${row.rutid}`} className="rounded-xl border border-slate-800 bg-slate-950/45 px-3 py-2">
                              <div className="flex items-center justify-between gap-3">
                                <div className="font-medium text-white">{row.company_name}</div>
                                <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-semibold', getTemperatureStyles(row.lead_temperature))}>
                                  {getTemperatureLabel(row.lead_temperature)}
                                </span>
                              </div>
                              <div className="mt-1 text-xs text-slate-400">
                                {row.region ?? 'Sin región'} · Score {formatNumber(row.priority_score)} · Contacto {formatNumber(row.contact_probability)}% · Compra {formatNumber(row.purchase_probability)}%
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <button
                        onClick={() => handleGenerateScenario(scenario)}
                        disabled={isGenerating || isPreviewStale}
                        className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Download className="h-4 w-4" />
                        Generar esta base
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </section>

        {result && (
          <section className="card p-5">
            {crmPushResult?.run_id === result.run_id && (
              <div className="mb-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                Run enviado al CRM. Se creó el run {crmPushResult.crm_run_id} con {formatNumber(crmPushResult.lead_instructions)} leads sobre {formatNumber(crmPushResult.attempted_leads)} evaluados. Se filtraron {formatNumber(crmPushResult.skipped_active_targets)} activos, {formatNumber(crmPushResult.skipped_non_target_entities)} no target y {formatNumber(crmPushResult.skipped_recent_pushes)} pushes recientes.
              </div>
            )}

            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-white">Resultado de priorización</h2>
                <p className="mt-1 text-xs text-slate-400">
                  {result.scenario_title} · Run {result.run_id} · {formatNumber(result.generated_count)} leads generados sobre {formatNumber(result.requested_volume)} solicitados
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-4 xl:grid-cols-7">
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-center">
                  <div className="text-lg font-semibold text-white">{formatNumber(result.summary.prospects)}</div>
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Prospects</div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-center">
                  <div className="text-lg font-semibold text-white">{formatNumber(result.summary.existing_customers)}</div>
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Clientes actuales</div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-center">
                  <div className="text-lg font-semibold text-white">{formatNumber(result.summary.avg_priority_score)}</div>
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Priority score</div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-center">
                  <div className="text-lg font-semibold text-white">{formatNumber(result.summary.avg_equifax_fit_score)}</div>
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Fit Equifax</div>
                </div>
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/8 px-3 py-2 text-center">
                  <div className="text-lg font-semibold text-emerald-200">{formatNumber(result.summary.green_leads)}</div>
                  <div className="text-[11px] uppercase tracking-[0.16em] text-emerald-300/80">Verde</div>
                </div>
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/8 px-3 py-2 text-center">
                  <div className="text-lg font-semibold text-amber-200">{formatNumber(result.summary.yellow_leads)}</div>
                  <div className="text-[11px] uppercase tracking-[0.16em] text-amber-300/80">Amarillo</div>
                </div>
                <div className="rounded-xl border border-rose-500/20 bg-rose-500/8 px-3 py-2 text-center">
                  <div className="text-lg font-semibold text-rose-200">{formatNumber(result.summary.red_leads)}</div>
                  <div className="text-[11px] uppercase tracking-[0.16em] text-rose-300/80">Rojo</div>
                </div>
              </div>
            </div>

            <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-950/35 p-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                <Upload className="h-4 w-4 text-cyan-300" />
                Gobierno de push al CRM
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <label className="block">
                  <span className="text-xs font-medium text-slate-400">Mínimo lead score</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={crmPushFilters.min_lead_score}
                    onChange={event => setCrmPushFilters(prev => ({ ...prev, min_lead_score: Number(event.target.value) }))}
                    className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-slate-400">Mínimo contacto</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={crmPushFilters.min_contact_probability}
                    onChange={event => setCrmPushFilters(prev => ({ ...prev, min_contact_probability: Number(event.target.value) }))}
                    className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-slate-400">Mínimo compra</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={crmPushFilters.min_purchase_probability}
                    onChange={event => setCrmPushFilters(prev => ({ ...prev, min_purchase_probability: Number(event.target.value) }))}
                    className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-slate-400">Máximo leads a empujar</span>
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    value={crmPushFilters.max_leads ?? ''}
                    onChange={event => setCrmPushFilters(prev => ({
                      ...prev,
                      max_leads: event.target.value ? Number(event.target.value) : null,
                    }))}
                    placeholder="Sin tope"
                    className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
                  />
                </label>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-3">
                  <div className="text-xs font-medium text-slate-400">Semáforos a incluir</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(['green', 'yellow', 'red'] as const).map(temperature => {
                      const checked = crmPushFilters.allowed_temperatures.includes(temperature)
                      return (
                        <label key={temperature} className="inline-flex items-center gap-2 text-xs text-slate-200">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={event => {
                              setCrmPushFilters(prev => ({
                                ...prev,
                                allowed_temperatures: event.target.checked
                                  ? [...new Set([...prev.allowed_temperatures, temperature])]
                                  : prev.allowed_temperatures.filter(item => item !== temperature),
                              }))
                            }}
                          />
                          <span>{getTemperatureLabel(temperature)}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>

                <label className="block">
                  <span className="text-xs font-medium text-slate-400">Bloqueo por pushes recientes</span>
                  <input
                    type="number"
                    min={0}
                    max={90}
                    value={crmPushFilters.exclude_recent_crm_days}
                    onChange={event => setCrmPushFilters(prev => ({ ...prev, exclude_recent_crm_days: Number(event.target.value) }))}
                    className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
                  />
                </label>

                <label className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-3 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    checked={crmPushFilters.exclude_active_crm_targets}
                    onChange={event => setCrmPushFilters(prev => ({ ...prev, exclude_active_crm_targets: event.target.checked }))}
                  />
                  <span>Excluir leads activos en CRM</span>
                </label>

                <label className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-3 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    checked={crmPushFilters.exclude_existing_customers}
                    onChange={event => setCrmPushFilters(prev => ({ ...prev, exclude_existing_customers: event.target.checked }))}
                  />
                  <span>Excluir clientes Equifax actuales</span>
                </label>
              </div>
            </div>

            <div className="mt-4 grid gap-4 xl:grid-cols-[0.85fr_1.15fr]">
              <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">Perfil IA</div>
                <p className="mt-2 text-sm text-slate-200">
                  {String(result.ai_profile.notes ?? 'Sin explicación adicional.')}
                </p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {Array.isArray(result.ai_profile.buyer_signals) && result.ai_profile.buyer_signals.map(signal => (
                    <span key={String(signal)} className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-200">
                      {String(signal)}
                    </span>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-950/35 p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Top leads</div>
                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-[0.16em] text-slate-500">
                        <th className="pb-2 pr-4">Empresa</th>
                        <th className="pb-2 pr-4">Contacto</th>
                        <th className="pb-2 pr-4">Probabilidades</th>
                        <th className="pb-2 pr-4">Señales</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.slice(0, 120).map(row => (
                        <tr key={row.rutid} className="border-b border-slate-900/70 align-top">
                          <td className="py-3 pr-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="font-medium text-white">{row.company_name}</div>
                              <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-semibold', getTemperatureStyles(row.lead_temperature))}>
                                {getTemperatureLabel(row.lead_temperature)}
                              </span>
                            </div>
                            <div className="mt-1 text-xs text-slate-500">{row.rutid}</div>
                            <div className="text-xs text-slate-500">{row.region ?? 'Sin región'} · {row.comuna ?? 'Sin comuna'}</div>
                          </td>
                          <td className="py-3 pr-4">
                            <div className="flex items-center gap-2 text-slate-200">
                              <Phone className="h-3.5 w-3.5 text-cyan-400" />
                              <span>{row.best_phone ?? 'Sin teléfono'}</span>
                            </div>
                            <div className="mt-1 flex items-center gap-2 text-slate-200">
                              <Mail className="h-3.5 w-3.5 text-amber-400" />
                              <span>{row.best_email ?? 'Sin email'}</span>
                            </div>
                            <div className="mt-1 text-xs text-slate-500">
                              {formatNumber(row.phone_count)} fono(s) · {formatNumber(row.email_count)} email(s)
                            </div>
                          </td>
                          <td className="py-3 pr-4">
                            <div className="font-semibold text-cyan-300">Lead {formatNumber(row.lead_score)}%</div>
                            <div className="mt-1 text-xs text-slate-400">
                              Contacto {formatNumber(row.contact_probability)}% · Interés {formatNumber(row.interest_probability)}%
                            </div>
                            <div className="text-xs text-slate-500">
                              Compra {formatNumber(row.purchase_probability)}% · Fit Equifax {formatNumber(row.equifax_fit_score)}
                            </div>
                            <div className="text-xs text-slate-500">
                              Canal {row.recommended_channel ?? 'sin canal'}{row.recommended_hour !== null ? ` · ${String(row.recommended_hour).padStart(2, '0')}:00` : ''}
                            </div>
                          </td>
                          <td className="py-3 pr-4">
                            <div className="flex flex-wrap gap-1.5">
                              {row.reason_tags.map(reason => (
                                <span key={`${row.rutid}-${reason}`} className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300">
                                  {reason}
                                </span>
                              ))}
                            </div>
                            {row.is_existing_customer && (
                              <div className="mt-2 text-xs text-emerald-300">
                                Cliente histórico · última venta {formatDate(row.last_equifax_sale_at)}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </>
  )
}
