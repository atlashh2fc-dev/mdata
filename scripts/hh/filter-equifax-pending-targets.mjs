import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import Papa from 'papaparse'
import pg from 'pg'

const INPUT_CSV = process.argv[2] || path.join(process.cwd(), 'outputs', 'bdd_equifax_gestiones_2026-05-07', 'BDD_telefonos_cruce_gestiones_equifax_resumen.csv')
const OUTPUT_DIR = process.argv[3] || path.join(process.cwd(), 'outputs', 'bdd_equifax_gestiones_2026-05-07')
const CLEAN_CSV = path.join(OUTPUT_DIR, 'BDD_pendientes_sin_gestion_target_limpio.csv')
const EXCLUDED_CSV = path.join(OUTPUT_DIR, 'BDD_pendientes_excluidos_no_target.csv')
const AUDIT_CSV = path.join(OUTPUT_DIR, 'BDD_pendientes_exclusion_resumen.csv')
const BATCH_SIZE = 1000

const RULES = [
  ['religion', ['iglesia', 'parroquia', 'diocesis', 'diosesis', 'obispado', 'capilla', 'congregacion', 'ministerio evangelico', 'corporacion religiosa', 'mision iglesia']],
  ['bomberos', ['bomberos', 'cuerpo de bomberos', 'compania de bomberos', 'compañia de bomberos', 'junta nacional de bomberos']],
  ['fundacion_corporacion', ['fundacion', 'corporacion']],
  ['sector_publico', ['municipalidad', 'gobierno', 'ministerio', 'subsecretaria', 'seremi', 'delegacion presidencial', 'intendencia', 'municipal', 'servicio de salud', 'departamento de salud', 'salud municipal', 'servicio nacional', 'servicio de vivienda', 'vivienda y urbanizacion', 'serviu', 'hospital', 'contraloria', 'tesoreria', 'registro civil', 'junta nacional', 'sii', 'corfo', 'fosis', 'sence', 'sag', 'conaf', 'administracion publica', 'seguridad social de afiliacion obligatoria']],
  ['educacion', ['universidad', 'colegio', 'escuela', 'liceo', 'instituto profesional', 'centro de formacion tecnica', 'jardin infantil', 'sala cuna', 'educacional']],
  ['ffaa_policial', ['carabineros', 'fuerzas armadas', 'ejercito', 'armada', 'fuerza aerea', 'fach', 'policia de investigaciones', 'pdi', 'gendarmeria', 'defensa nacional']],
  ['ong_asociacion_gremial', ['organizacion no gubernamental', 'ong', 'asociacion gremial', 'asociacion de funcionarios', 'sindicato', 'federacion gremial', 'confederacion']],
  ['diplomatico_internacional', ['embajada', 'consulado', 'mision diplomatica', 'organismos internacionales', 'organos extraterritoriales']],
  ['comunidad_copropiedad', ['condominio', 'comunidad edificio', 'comunidad de copropietarios', 'junta de vecinos', 'comunidad sucesion', 'sucesion']],
  ['extranjero_sucursal', ['sucursal chile', 'sucursal en chile', 'agencia en chile']],
]

function postgresConnectionString() {
  const raw = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL
  if (!raw) return raw
  const url = new URL(raw)
  url.searchParams.delete('sslmode')
  return url.toString()
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function matchesToken(text, token) {
  if (!text || !token) return false
  const normalizedToken = normalizeText(token)
  if (normalizedToken.length <= 4) return text.split(/\s+/g).includes(normalizedToken)
  return text.includes(normalizedToken)
}

function detectTextExclusion(row, attrs) {
  const haystack = normalizeText([
    row.razon_social_empresa,
    row.nombre_completo,
    attrs?.razon_social,
    attrs?.rubro_economico_ultimo,
    attrs?.subrubro_economico_ultimo,
    attrs?.actividad_economica_ultima,
    attrs?.tipo_contribuyente_ultimo,
    attrs?.subtipo_contribuyente_ultimo,
  ].filter(Boolean).join(' '))

  for (const [reason, tokens] of RULES) {
    for (const token of tokens) {
      if (matchesToken(haystack, token)) {
        return { reason, token: normalizeText(token) }
      }
    }
  }

  return null
}

function detectExclusion(row, attrs) {
  if (attrs?.es_corporacion === true || attrs?.es_corporacion === 'true') {
    return { reason: 'corporacion_enorme_tramo_ventas', token: `ultimo_tramo_ventas=${attrs.ultimo_tramo_ventas ?? ''}` }
  }

  return detectTextExclusion(row, attrs)
}

function csvEscape(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

async function writeCsv(filePath, rows, headers) {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(filePath)
    stream.on('finish', resolve)
    stream.on('error', reject)
    stream.write(`${headers.map(csvEscape).join(',')}\n`)
    for (const row of rows) {
      stream.write(`${headers.map(header => csvEscape(row[header])).join(',')}\n`)
    }
    stream.end()
  })
}

async function insertTempRows(client, rows) {
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE)
    const values = []
    const placeholders = batch.map((row, index) => {
      const offset = index * 3
      values.push(row.rutid, String(row.rutid ?? '').replace(/^0+/, ''), row.fila_origen)
      return `($${offset + 1}, $${offset + 2}, $${offset + 3})`
    }).join(',')
    await client.query(`insert into temp_pending_ruts (rutid, rutid_key, fila_origen) values ${placeholders}`, values)
  }
}

async function fetchCompanyAttrs(pendingRows) {
  const attrs = new Map()
  const client = new pg.Client({
    connectionString: postgresConnectionString(),
    ssl: { rejectUnauthorized: false },
  })
  await client.connect()
  await client.query('set statement_timeout = 0')
  await client.query('begin')
  await client.query('create temp table temp_pending_ruts (rutid text primary key, rutid_key text, fila_origen integer) on commit drop')
  await insertTempRows(client, pendingRows)
  await client.query('create index on temp_pending_ruts (rutid_key)')

  const { rows } = await client.query(`
    select
      t.rutid as input_rutid,
      ecu.rutid,
      ecu.razon_social,
      ecu.segmento_tamano_empresa,
      ecu.es_pyme,
      ecu.es_gran_empresa,
      ecu.es_corporacion,
      ecu.ultimo_tramo_ventas,
      ecu.tramo_ventas_2024,
      ecu.trabajadores_2024,
      ecu.tipo_contribuyente_ultimo,
      ecu.subtipo_contribuyente_ultimo,
      ecu.rubro_economico_ultimo,
      ecu.subrubro_economico_ultimo,
      ecu.actividad_economica_ultima
    from temp_pending_ruts t
    left join public.empresas_comercial_unificada ecu
      on ecu.rutid = t.rutid_key
  `)

  await client.query('commit')
  await client.end()

  for (const row of rows) {
    attrs.set(row.input_rutid, row)
  }

  return attrs
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  const parsed = Papa.parse(fs.readFileSync(INPUT_CSV, 'utf8'), {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  })
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors[0].message)
  }

  const pendingRows = parsed.data.filter(row => String(row.gestionado_equifax_dicom).toLowerCase() !== 'true')
  console.log(`pendientes sin gestion: ${pendingRows.length}`)

  const attrsByRut = await fetchCompanyAttrs(pendingRows)
  const cleanRows = []
  const excludedRows = []

  for (const row of pendingRows) {
    const attrs = attrsByRut.get(row.rutid)
    const exclusion = detectExclusion(row, attrs)
    const enriched = {
      ...row,
      segmento_tamano_empresa: attrs?.segmento_tamano_empresa ?? '',
      ultimo_tramo_ventas: attrs?.ultimo_tramo_ventas ?? '',
      trabajadores_2024: attrs?.trabajadores_2024 ?? '',
      rubro_economico_ultimo: attrs?.rubro_economico_ultimo ?? '',
      actividad_economica_ultima: attrs?.actividad_economica_ultima ?? '',
      exclusion_no_target: exclusion?.reason ?? '',
      exclusion_token: exclusion?.token ?? '',
    }

    if (exclusion) excludedRows.push(enriched)
    else cleanRows.push(enriched)
  }

  const cleanHeaders = Object.keys(cleanRows[0] ?? excludedRows[0] ?? {})
  const excludedHeaders = cleanHeaders
  await writeCsv(CLEAN_CSV, cleanRows, cleanHeaders)
  await writeCsv(EXCLUDED_CSV, excludedRows, excludedHeaders)

  const byReason = new Map()
  for (const row of excludedRows) {
    const reason = row.exclusion_no_target || 'sin_motivo'
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
  }
  const auditRows = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([motivo, cantidad]) => ({ motivo, cantidad }))
  await writeCsv(AUDIT_CSV, auditRows, ['motivo', 'cantidad'])

  console.log(JSON.stringify({
    input: INPUT_CSV,
    pendientesOriginales: pendingRows.length,
    targetLimpio: cleanRows.length,
    excluidosNoTarget: excludedRows.length,
    cleanCsv: CLEAN_CSV,
    excludedCsv: EXCLUDED_CSV,
    auditCsv: AUDIT_CSV,
    motivos: auditRows,
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
