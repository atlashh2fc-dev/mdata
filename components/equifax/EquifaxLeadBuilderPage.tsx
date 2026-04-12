'use client'

import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import {
  BrainCircuit,
  Database,
  Download,
  Mail,
  Phone,
  RefreshCcw,
  Target,
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
  EquifaxLeadGenerationResult,
  EquifaxProductCatalogItem,
  EquifaxSalesImportResult,
} from '@/types/equifax'

type CatalogResponse = {
  summary: EquifaxCatalogSummary
  products: EquifaxProductCatalogItem[]
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
  link.download = 'equifax-leads.csv'
  link.click()
  URL.revokeObjectURL(url)
}

export function EquifaxLeadBuilderPage() {
  const [loading, setLoading] = useState(true)
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([])
  const [prompt, setPrompt] = useState('')
  const [regions, setRegions] = useState('')
  const [volume, setVolume] = useState(3000)
  const [minPhoneCount, setMinPhoneCount] = useState(1)
  const [minEmailCount, setMinEmailCount] = useState(0)
  const [includeExistingCustomers, setIncludeExistingCustomers] = useState(true)
  const [savingProducts, setSavingProducts] = useState(false)
  const [importingSales, setImportingSales] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState<EquifaxLeadGenerationResult | null>(null)
  const [salesImportResult, setSalesImportResult] = useState<EquifaxSalesImportResult | null>(null)
  const [productImportMessage, setProductImportMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function loadCatalog() {
    setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/equifax/catalog')
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'No se pudo cargar Equifax.')
      setCatalog(json.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando módulo Equifax.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadCatalog()
  }, [])

  const selectedProducts = useMemo(() => {
    const ids = new Set(selectedProductIds)
    return (catalog?.products ?? []).filter(item => ids.has(item.id))
  }, [catalog?.products, selectedProductIds])

  async function handleSalesImport(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setImportingSales(true)
    setError(null)

    try {
      const formData = new FormData()
      formData.append('file', file)

      const res = await fetch('/api/equifax/import-sales', {
        method: 'POST',
        body: formData,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'No se pudo importar el Excel.')

      setSalesImportResult(json.data)
      await loadCatalog()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo importar ventas.')
    } finally {
      setImportingSales(false)
      event.target.value = ''
    }
  }

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
        const formData = new FormData()
        formData.append('file', file)

        const res = await fetch('/api/equifax/catalog', {
          method: 'POST',
          body: formData,
        })
        const json = await res.json()
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
        const json = await res.json()
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

  async function handleGenerate() {
    setGenerating(true)
    setError(null)

    try {
      const res = await fetch('/api/equifax/leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          product_ids: selectedProductIds,
          prompt,
          volume,
          regions: regions.split(',').map(item => item.trim()).filter(Boolean),
          include_existing_customers: includeExistingCustomers,
          min_phone_count: minPhoneCount,
          min_email_count: minEmailCount,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'No se pudo generar la base.')
      setResult(json.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo generar leads.')
    } finally {
      setGenerating(false)
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
          <button
            onClick={() => downloadCsv(result.rows)}
            className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-500/15"
          >
            <Download className="h-4 w-4" />
            Exportar CSV
          </button>
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

        <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
          <section className="card p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-white">1. Cargar histórico de ventas</h2>
                <p className="mt-1 text-xs text-slate-400">
                  Sube el Excel con hojas `Recurrente` y `One Time` para dejar el histórico en Supabase.
                </p>
              </div>
              {importingSales && <Spinner size="sm" />}
            </div>

            <label className="mt-4 flex cursor-pointer items-center justify-center gap-3 rounded-2xl border border-dashed border-cyan-500/35 bg-cyan-500/5 px-4 py-6 text-sm text-cyan-200 transition hover:bg-cyan-500/10">
              <Upload className="h-4 w-4" />
              <span>Seleccionar Excel de ventas Equifax</span>
              <input
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={handleSalesImport}
              />
            </label>

            {salesImportResult && (
              <div className="mt-4 rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-4 text-sm text-emerald-100">
                Se importaron {formatNumber(salesImportResult.total_rows)} filas desde {salesImportResult.sheets.join(', ')}.
              </div>
            )}

            <div className="mt-5">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Servicios más vendidos</div>
              <div className="mt-3 space-y-2">
                {(catalog?.summary.top_services ?? []).map(service => (
                  <div key={service.service} className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm">
                    <div className="text-slate-200">{service.service}</div>
                    <div className="text-right">
                      <div className="font-semibold text-white">{formatNumber(service.count)}</div>
                      <div className="text-[11px] text-slate-500">{formatNumber(service.total_amount)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="card p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-white">2. Catálogo de productos Equifax</h2>
                <p className="mt-1 text-xs text-slate-400">
                  Sube un `CSV/XLSX` o un `PDF` comercial para extraer `nombre`, `categoria`, `descripcion`, `rubro` y `keywords`.
                </p>
              </div>
              {savingProducts && <Spinner size="sm" />}
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
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-white">3. Generar base priorizada</h2>
              <p className="mt-1 text-xs text-slate-400">
                El motor cruza catálogo, histórico Equifax, scores comerciales y disponibilidad de teléfonos/emails.
              </p>
            </div>
            {generating && <Spinner size="sm" />}
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="block">
              <span className="text-xs font-medium text-slate-400">Volumen objetivo</span>
              <input
                type="number"
                min={1}
                max={10000}
                value={volume}
                onChange={event => setVolume(Number(event.target.value))}
                className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500"
              />
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
              onClick={handleGenerate}
              disabled={generating || selectedProductIds.length === 0}
              className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <BrainCircuit className="h-4 w-4" />
              Generar base con IA
            </button>
            <div className="text-xs text-slate-500">
              {selectedProducts.length > 0
                ? `${formatNumber(selectedProducts.length)} producto(s) seleccionado(s)`
                : 'Selecciona al menos un producto'}
            </div>
          </div>
        </section>

        {result && (
          <section className="card p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-white">Resultado de priorización</h2>
                <p className="mt-1 text-xs text-slate-400">
                  Run {result.run_id} · {formatNumber(result.generated_count)} leads generados sobre {formatNumber(result.requested_volume)} solicitados
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
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
                        <th className="pb-2 pr-4">Scores</th>
                        <th className="pb-2 pr-4">Señales</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.slice(0, 120).map(row => (
                        <tr key={row.rutid} className="border-b border-slate-900/70 align-top">
                          <td className="py-3 pr-4">
                            <div className="font-medium text-white">{row.company_name}</div>
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
                            <div className="font-semibold text-cyan-300">{formatNumber(row.priority_score)}</div>
                            <div className="mt-1 text-xs text-slate-400">
                              Contacto {formatNumber(row.contactability_score)} · Compra {formatNumber(row.purchase_propensity_score)}
                            </div>
                            <div className="text-xs text-slate-500">
                              Fit Equifax {formatNumber(row.equifax_fit_score)}
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
