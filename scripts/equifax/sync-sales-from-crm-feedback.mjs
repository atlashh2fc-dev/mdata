import { createClient } from '@supabase/supabase-js'

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.local')

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
const BATCH_SIZE = Number(process.env.EQUIFAX_CRM_SALES_BATCH_SIZE ?? 500)

if (!url || !serviceKey) {
  throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SECRET_KEY')
}

const db = createClient(url, serviceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

function cleanRut(value) {
  return String(value ?? '').replace(/[^\dKk]/g, '').toUpperCase() || null
}

function normalizeService(row) {
  const campaign = String(row.campaign_name ?? '').trim()
  const subtype = String(row.outcome_subtype ?? '').trim()
  const reason = String(row.outcome_reason ?? '').trim()

  if (/dicom/i.test(`${campaign} ${subtype} ${reason}`)) return 'DICOM'
  if (/portfolio/i.test(`${campaign} ${subtype} ${reason}`)) return 'PORTFOLIO MONITOR'
  if (/riesgo/i.test(`${campaign} ${subtype} ${reason}`)) return 'RIESGO COMERCIAL'
  if (/verificaci[oó]n/i.test(`${campaign} ${subtype} ${reason}`)) return 'VERIFICACION COMERCIAL'
  if (/informe/i.test(`${campaign} ${subtype} ${reason}`)) return 'INFORME COMERCIAL'
  return 'EQUIFAX CRM'
}

function normalizeServiceKey(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function detectSaleKind(row) {
  const text = `${row.campaign_name ?? ''} ${row.outcome_subtype ?? ''} ${row.outcome_reason ?? ''}`.toLowerCase()
  return /recurrente|recurr|mensual|renovaci/.test(text) ? 'recurrente' : 'one_time'
}

function toSaleRow(row, index) {
  const service = normalizeService(row)
  const saleDate = row.sold_at ?? row.managed_at ?? new Date().toISOString()

  return {
    source_file: `registro-intel-crm:${row.id}`,
    source_sheet: 'contact_center_feedback_sale',
    source_row_number: 1,
    sale_kind: detectSaleKind(row),
    mes: saleDate,
    rut_raw: row.matched_rutid ?? row.rutid ?? null,
    rutid: cleanRut(row.matched_rutid ?? row.rutid),
    cliente: row.company_name ?? row.razon_social ?? null,
    fecha_venta: saleDate,
    ejecutiva: row.agent_name ?? null,
    origen: row.campaign_name ?? 'CRM',
    servicio: service,
    servicio_normalized: normalizeServiceKey(service),
    valor: row.value_amount ?? null,
    periodo: saleDate ? Number(String(saleDate).slice(0, 4)) : null,
    metadata: {
      source: 'contact_center_feedback',
      feedback_id: row.id,
      managed_at: row.managed_at,
      sold_at: row.sold_at,
      outcome: row.outcome,
      outcome_subtype: row.outcome_subtype,
      outcome_reason: row.outcome_reason,
      campaign_name: row.campaign_name,
      synced_from_crm_at: new Date().toISOString(),
      batch_index: index,
    },
  }
}

function isEquifaxSale(row) {
  const text = `${row.campaign_name ?? ''} ${row.outcome_subtype ?? ''} ${row.outcome_reason ?? ''}`.toLowerCase()
  return (
    text.includes('equifax') ||
    text.includes('dicom') ||
    text.includes('riesgo comercial') ||
    text.includes('verificacion comercial') ||
    text.includes('verificación comercial') ||
    text.includes('informe comercial') ||
    text.includes('portfolio')
  )
}

async function fetchSales() {
  const rows = []

  for (let from = 0; ; from += BATCH_SIZE) {
    const { data, error } = await db
      .from('contact_center_feedback')
      .select('id,rutid,matched_rutid,campaign_name,outcome,outcome_subtype,outcome_reason,managed_at,sold_at,value_amount,agent_name,raw_payload')
      .or('sale.eq.true,outcome.eq.sale,sold_at.not.is.null')
      .order('managed_at', { ascending: true })
      .range(from, from + BATCH_SIZE - 1)

    if (error) throw new Error(`No se pudieron leer ventas CRM: ${error.message}`)

    const chunk = (data ?? []).filter(isEquifaxSale)
    rows.push(...chunk)
    if ((data ?? []).length < BATCH_SIZE) break
  }

  return rows
}

async function upsertSales(rows) {
  let upserted = 0

  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const payload = rows.slice(start, start + BATCH_SIZE).map(toSaleRow)
    if (!payload.length) continue

    const { error } = await db
      .from('equifax_sales_history')
      .upsert(payload, { onConflict: 'source_file,source_sheet,source_row_number' })

    if (error) throw new Error(`No se pudieron guardar ventas Equifax desde CRM: ${error.message}`)
    upserted += payload.length
  }

  return upserted
}

async function getSummary() {
  const { data, error } = await db
    .from('equifax_sales_company_summary')
    .select('rutid,sales_count,recurrent_sales_count,one_time_sales_count,last_sale_at')

  if (error) throw new Error(`No se pudo leer resumen Equifax: ${error.message}`)

  const rows = data ?? []
  return {
    customers: rows.length,
    total_sales: rows.reduce((sum, row) => sum + Number(row.sales_count ?? 0), 0),
    recurrent_sales: rows.reduce((sum, row) => sum + Number(row.recurrent_sales_count ?? 0), 0),
    one_time_sales: rows.reduce((sum, row) => sum + Number(row.one_time_sales_count ?? 0), 0),
    last_sale_at: rows.map(row => row.last_sale_at).filter(Boolean).sort().at(-1) ?? null,
  }
}

async function main() {
  const sales = await fetchSales()
  const upserted = await upsertSales(sales)
  const summary = await getSummary()

  process.stdout.write(JSON.stringify({
    ok: true,
    crm_sales_found: sales.length,
    upserted,
    summary,
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
