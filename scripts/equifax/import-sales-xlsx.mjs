import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { createClient } from '@supabase/supabase-js'

const inputPath = process.argv[2]

if (!inputPath) {
  console.error('Uso: node --env-file=.env.local scripts/equifax/import-sales-xlsx.mjs /ruta/archivo.xlsx')
  process.exit(1)
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

if (!fs.existsSync(inputPath)) {
  console.error(`Archivo no encontrado: ${inputPath}`)
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const SHEET_KIND_MAP = new Map([
  ['recurrente', 'recurrente'],
  ['one time', 'one_time'],
])

function cleanRut(value) {
  return String(value ?? '').replace(/[.\-\s]/g, '').toUpperCase().trim()
}

function normalizeRutForDb(value) {
  const cleaned = cleanRut(value)
  if (cleaned.length < 2) return null
  return cleaned.padStart(10, '0')
}

function normalizeText(value) {
  const out = String(value ?? '').trim()
  return out.length ? out : null
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const out = Number(String(value).replace(',', '.'))
  return Number.isFinite(out) ? out : null
}

function normalizeDate(value, asMonth = false) {
  if (!value) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()

  const raw = String(value).trim()
  if (!raw) return null
  if (asMonth && /^\d{4}-\d{2}$/.test(raw)) return `${raw}-01T00:00:00.000Z`

  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function normalizeService(value) {
  const normalized = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return normalized || null
}

function buildRow({ sourceFile, sourceSheet, rowNumber, saleKind, row }) {
  return {
    source_file: sourceFile,
    source_sheet: sourceSheet,
    source_row_number: rowNumber,
    sale_kind: saleKind,
    mes: normalizeDate(row.MES, true),
    rut_raw: normalizeText(row.RUT),
    rutid: normalizeRutForDb(row.RUT),
    cliente: normalizeText(row.CLIENTE),
    fecha_venta: normalizeDate(row.FECHA),
    ejecutiva: normalizeText(row.EJECUTIVA),
    origen: normalizeText(row.ORIGEN),
    servicio: normalizeText(row.SERVICIO),
    servicio_normalized: normalizeService(row.SERVICIO),
    valor: normalizeNumber(row.VALOR),
    periodo: normalizeNumber(row.PERIODO),
    metadata: {
      mes_raw: row.MES ?? null,
    },
  }
}

const workbook = XLSX.read(fs.readFileSync(inputPath), { type: 'buffer', cellDates: true })
const sourceFile = path.basename(inputPath)

const rows = workbook.SheetNames.flatMap(sheetName => {
  const saleKind = SHEET_KIND_MAP.get(sheetName.trim().toLowerCase())
  if (!saleKind) return []

  const sheet = workbook.Sheets[sheetName]
  if (!sheet) return []

  const data = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: null })
  return data.map((row, index) => buildRow({
    sourceFile,
    sourceSheet: sheetName,
    rowNumber: index + 2,
    saleKind,
    row,
  }))
})

if (!rows.length) {
  console.error('No se encontraron filas válidas en las hojas esperadas.')
  process.exit(1)
}

const { error } = await supabase
  .from('equifax_sales_history')
  .upsert(rows, { onConflict: 'source_file,source_sheet,source_row_number' })

if (error) {
  console.error('Error importando ventas Equifax:', error.message)
  process.exit(1)
}

console.log(`Importación OK: ${rows.length} filas cargadas desde ${sourceFile}`)
