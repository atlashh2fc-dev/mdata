#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { createClient } from '@supabase/supabase-js'
import XLSX from 'xlsx'

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.production')

const DEFAULT_INPUT = '/Users/hh/Downloads/Resultado_FOLIO_MKT-7245_GEIMSER.xlsx'
const INPUT_XLSX = process.argv.find(arg => arg.startsWith('--input='))?.split('=').slice(1).join('=')
  || DEFAULT_INPUT
const DRY_RUN = process.argv.includes('--dry-run')
const BATCH_SIZE = Number(process.argv.find(arg => arg.startsWith('--batch-size='))?.split('=')[1] ?? 500)
const SOURCE_NAME = 'geimser_mkt_7245_resultado'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.REGISTRO_INTEL_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.REGISTRO_INTEL_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Faltan SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY para cargar datos.')
}

if (!fs.existsSync(INPUT_XLSX)) {
  throw new Error(`No existe el archivo: ${INPUT_XLSX}`)
}

if (!Number.isFinite(BATCH_SIZE) || BATCH_SIZE < 1 || BATCH_SIZE > 1000) {
  throw new Error(`batch-size invalido: ${BATCH_SIZE}`)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function cleanText(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function normalizeRut(value) {
  const clean = String(value ?? '').replace(/[.\-\s]/g, '').trim().toUpperCase()
  if (clean.length < 2) return null
  const body = clean.slice(0, -1).replace(/\D/g, '')
  const dv = clean.slice(-1).replace(/[^0-9K]/g, '')
  if (!body || !dv) return null
  return `${body.padStart(9, '0')}${dv}`
}

function rutNumber(rutid) {
  const body = String(rutid ?? '').slice(0, -1).replace(/\D/g, '')
  const parsed = Number(body)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function normalizeEmail(value) {
  const email = cleanText(value)?.toLowerCase() ?? null
  if (!email) return null
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

function normalizeFlag(value) {
  const text = cleanText(value)?.toUpperCase()
  if (text === 'SI' || text === 'SÍ') return true
  if (text === 'NO') return false
  return null
}

function dateText(value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const yyyy = value.getFullYear()
    const mm = String(value.getMonth() + 1).padStart(2, '0')
    const dd = String(value.getDate()).padStart(2, '0')
    return `${yyyy}${mm}${dd}`
  }
  const text = String(value).trim()
  if (!text) return null
  if (/^\d+(\.0+)?$/.test(text)) return String(Math.trunc(Number(text)))
  return text
}

function rowKey(row) {
  return [
    row.rutid ?? '',
    row.rutid_ejecutivo ?? '',
    row.nombre_ejecutivo ?? '',
    row.cargo ?? '',
    row.email ?? '',
  ].join('\u001f')
}

function chunk(items, size) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

function readSheet(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) throw new Error(`No existe hoja requerida: ${sheetName}`)
  return XLSX.utils.sheet_to_json(sheet, {
    defval: null,
    raw: false,
    blankrows: false,
  })
}

async function fetchExistingPersonas(rutids) {
  const existing = new Map()
  for (const slice of chunk(rutids, 1000)) {
    const { data, error } = await supabase
      .from('personas_master')
      .select('rutid,razon_social_empresa,email,fono_cel,domicilio_comuna,domicilio_region,comuna_part,region_part')
      .in('rutid', slice)
    if (error) throw new Error(`No pude leer personas_master: ${error.message}`)
    for (const row of data ?? []) existing.set(row.rutid, row)
  }
  return existing
}

async function fetchExistingEjecutivos(rutids) {
  const keys = new Set()
  for (const slice of chunk(rutids, 500)) {
    let from = 0
    while (true) {
      const to = from + 999
      const { data, error } = await supabase
        .from('ejecutivos')
        .select('rutid,rutid_ejecutivo,nombre_ejecutivo,cargo,email')
        .in('rutid', slice)
        .range(from, to)
      if (error) throw new Error(`No pude leer ejecutivos: ${error.message}`)
      for (const row of data ?? []) keys.add(rowKey(row))
      if (!data || data.length < 1000) break
      from += 1000
    }
  }
  return keys
}

async function upsertPersonas(rows) {
  let processed = 0
  for (const slice of chunk(rows, BATCH_SIZE)) {
    const { error } = await supabase
      .from('personas_master')
      .upsert(slice, { onConflict: 'rutid' })
    if (error) throw new Error(`No pude upsert personas_master: ${error.message}`)
    processed += slice.length
  }
  return processed
}

async function upsertCommercialRows(rows) {
  let processed = 0
  for (const slice of chunk(rows, BATCH_SIZE)) {
    const { error } = await supabase
      .from('geimser_mkt_7245_empresas')
      .upsert(slice, { onConflict: 'rutid' })
    if (error) throw new Error(`No pude upsert geimser_mkt_7245_empresas: ${error.message}`)
    processed += slice.length
  }
  return processed
}

async function insertEjecutivos(rows) {
  let processed = 0
  for (const slice of chunk(rows, BATCH_SIZE)) {
    const { error } = await supabase
      .from('ejecutivos')
      .insert(slice)
    if (error) throw new Error(`No pude insertar ejecutivos: ${error.message}`)
    processed += slice.length
  }
  return processed
}

async function refreshContactPoints() {
  const { data, error } = await supabase.rpc('sync_ejecutivos_contact_points')
  if (error) throw new Error(`No pude refrescar puntos de contacto: ${error.message}`)
  return data
}

async function main() {
  const workbook = XLSX.readFile(INPUT_XLSX, { cellDates: false })
  const datosRows = readSheet(workbook, 'Datos')
  const ejecutivosRows = readSheet(workbook, 'Ejecutivos_de_contacto')

  const datosByRut = new Map()
  const invalidDatos = []

  for (const row of datosRows) {
    const rutid = normalizeRut(row.RUT)
    if (!rutid) {
      invalidDatos.push(row)
      continue
    }

    datosByRut.set(rutid, {
      rutid,
      razon_social: cleanText(row.RAZON_SOCIAL),
      tipovia_comer: cleanText(row.TIPOVIA_COMER),
      calle_comer: cleanText(row.CALLE_COMER),
      numero_comer: cleanText(row.NUMERO_COMER),
      resto_direccion_comer: cleanText(row.RESTO_DIRECCION_COMER),
      comuna_comer: cleanText(row.COMUNA_COMER),
      ciudad_comer: cleanText(row.CIUDAD_COMER),
      region_comer: cleanText(row.REGION_COMER),
      fecha_direccion_comer: dateText(row.FECHA_DIRECCION_COMER),
      rubro: cleanText(row.RUBRO),
      facturacion_sub_rango: cleanText(row.FACTURACION_SUB_RANGO),
      tamano_empresas: cleanText(row.TAMANO_EMPRESAS),
      con_cargo_ejecutivo: normalizeFlag(row.CON_CARGO_EJECUTIVO),
      con_email_ejecutivo: normalizeFlag(row.CON_EMAIL_EJECUTIVO),
      con_fono_celular_ejecutivo: normalizeFlag(row.CON_FONO_CELULAR_EJECUTIVO),
      con_fono_comercial_ejecutivo: normalizeFlag(row.CON_FONO_COMERCIAL_EJECUTIVO),
    })
  }

  const targetRutids = [...datosByRut.keys()]
  const existingPersonas = await fetchExistingPersonas(targetRutids)
  const personasPayload = []
  const commercialPayload = []
  let personasInserted = 0
  let companyBackfilled = 0
  let comunaBackfilled = 0
  let regionBackfilled = 0

  for (const [rutid, source] of datosByRut) {
    const existing = existingPersonas.get(rutid)
    const payload = {
      rutid,
      razon_social_empresa: existing?.razon_social_empresa || source.razon_social,
      domicilio_comuna: existing?.domicilio_comuna || source.comuna_comer,
      domicilio_region: existing?.domicilio_region || source.region_comer,
      comuna_part: existing?.comuna_part || source.comuna_comer,
      region_part: existing?.region_part || source.region_comer,
      n_autos: 0,
      n_bienes_raices: 0,
      totalavaluos: 0,
      loaded_at: new Date().toISOString(),
    }

    if (!existing) personasInserted += 1
    if (!existing?.razon_social_empresa && source.razon_social) companyBackfilled += 1
    if (!existing?.domicilio_comuna && source.comuna_comer) comunaBackfilled += 1
    if (!existing?.domicilio_region && source.region_comer) regionBackfilled += 1
    personasPayload.push(payload)

    commercialPayload.push({
      ...source,
      source_name: SOURCE_NAME,
      source_loaded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
  }

  const existingEjecutivoKeys = await fetchExistingEjecutivos(targetRutids)
  const newEjecutivoKeys = new Set()
  const ejecutivosPayload = []
  let invalidEjecutivos = 0
  let ejecutivoEmailRows = 0
  let ejecutivoPhoneRows = 0

  for (const row of ejecutivosRows) {
    const rutid = normalizeRut(row.RUT)
    if (!rutid) {
      invalidEjecutivos += 1
      continue
    }

    const sourceCompany = datosByRut.get(rutid)
    const email = normalizeEmail(row.EMAIL)
    const payload = {
      rutid,
      razon_social: sourceCompany?.razon_social ?? null,
      rutid_ejecutivo: normalizeRut(row.RUTID_EJECUTIVO),
      nombre_ejecutivo: cleanText(row.NOMBRE_EJECUTIVO),
      area: cleanText(row.AREA),
      cargo: cleanText(row.CARGO),
      fono_area_cel: cleanText(row.FONO_AREA_CEL),
      fono_numero_cel: cleanText(row.FONO_NUMERO_CEL),
      fecha_fono_cel: dateText(row.FECHA_FONO_CEL),
      fono_area_comer: cleanText(row.FONO_AREA_COMER),
      fono_numero_comer: cleanText(row.FONO_NUMERO_COMER),
      fecha_fono_comer: dateText(row.FECHA_FONO_COMER),
      email,
      fecha_email: dateText(row.FECHA_EMAIL),
      rut_num1: rutNumber(rutid),
      source_loaded_at: new Date().toISOString(),
    }

    if (!payload.nombre_ejecutivo) {
      invalidEjecutivos += 1
      continue
    }

    const key = rowKey(payload)
    if (existingEjecutivoKeys.has(key) || newEjecutivoKeys.has(key)) continue
    newEjecutivoKeys.add(key)

    if (payload.email) ejecutivoEmailRows += 1
    if (payload.fono_numero_cel || payload.fono_numero_comer) ejecutivoPhoneRows += 1
    ejecutivosPayload.push(payload)
  }

  const summary = {
    input: INPUT_XLSX,
    source_name: SOURCE_NAME,
    dry_run: DRY_RUN,
    datos: {
      source_rows: datosRows.length,
      valid_unique_rutids: targetRutids.length,
      invalid_rows: invalidDatos.length,
    },
    personas_master: {
      rows_to_upsert: personasPayload.length,
      inserted_estimate: personasInserted,
      company_backfilled: companyBackfilled,
      comuna_backfilled: comunaBackfilled,
      region_backfilled: regionBackfilled,
    },
    geimser_mkt_7245_empresas: {
      rows_to_upsert: commercialPayload.length,
      with_rubro: commercialPayload.filter(row => row.rubro).length,
      with_facturacion_sub_rango: commercialPayload.filter(row => row.facturacion_sub_rango).length,
      with_tamano_empresas: commercialPayload.filter(row => row.tamano_empresas).length,
    },
    ejecutivos: {
      source_rows: ejecutivosRows.length,
      invalid_rows: invalidEjecutivos,
      rows_to_insert: ejecutivosPayload.length,
      rows_with_email: ejecutivoEmailRows,
      rows_with_phone: ejecutivoPhoneRows,
    },
    contact_points_refresh: null,
  }

  if (!DRY_RUN) {
    summary.personas_master.rows_upserted = await upsertPersonas(personasPayload)
    summary.geimser_mkt_7245_empresas.rows_upserted = await upsertCommercialRows(commercialPayload)
    summary.ejecutivos.rows_inserted = await insertEjecutivos(ejecutivosPayload)
    if (summary.ejecutivos.rows_inserted > 0) {
      try {
        summary.contact_points_refresh = await refreshContactPoints()
      } catch (error) {
        summary.contact_points_refresh = {
          error: error instanceof Error ? error.message : String(error),
          recovery_sql: 'set statement_timeout = 0; select public.sync_ejecutivos_contact_points();',
        }
      }
    } else {
      summary.contact_points_refresh = { skipped: 'sin_ejecutivos_nuevos' }
    }
  }

  const outputDir = path.join(process.cwd(), 'outputs', 'geimser_mkt_7245_import')
  fs.mkdirSync(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-summary.json`)
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify({ ...summary, output_path: outputPath }, null, 2))
}

main().catch(error => {
  console.error(`Fallo import-geimser-result-xlsx: ${error.message}`)
  process.exitCode = 1
})
