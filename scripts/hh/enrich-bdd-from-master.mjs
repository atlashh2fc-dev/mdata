import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import XLSX from 'xlsx'
import pg from 'pg'

const { Client } = pg

const INPUT_PATH = process.argv[2] || '/Users/hh/Downloads/BDD.xlsx'
const OUTPUT_DIR = process.argv[3] || path.join(process.cwd(), 'outputs', 'bdd_enriched_2026-05-07')
const OUTPUT_XLSX = path.join(OUTPUT_DIR, 'BDD_enriquecida.xlsx')
const OUTPUT_CSV = path.join(OUTPUT_DIR, 'BDD_enriquecida.csv')
const BATCH_SIZE = 1000
const MAX_ROWS = Number.parseInt(process.env.MAX_ROWS || '0', 10)
const WRITE_XLSX = process.env.WRITE_XLSX === '1' || (MAX_ROWS > 0 && MAX_ROWS <= 50000)
const MAX_SHARED_PHONE_RUTS = Number.parseInt(process.env.MAX_SHARED_PHONE_RUTS || '3', 10)

function postgresConnectionString() {
  const raw = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL
  if (!raw) return raw
  const url = new URL(raw)
  url.searchParams.delete('sslmode')
  return url.toString()
}

function cleanRut(value) {
  return String(value ?? '').replace(/[.\-\s]/g, '').toUpperCase().trim()
}

function calcDv(digits) {
  const str = String(digits ?? '').replace(/\D/g, '')
  let sum = 0
  let mult = 2
  for (let i = str.length - 1; i >= 0; i -= 1) {
    sum += Number.parseInt(str[i], 10) * mult
    mult = mult === 7 ? 2 : mult + 1
  }
  const remainder = 11 - (sum % 11)
  if (remainder === 11) return '0'
  if (remainder === 10) return 'K'
  return String(remainder)
}

function validateRut(value) {
  const clean = cleanRut(value)
  if (clean.length < 2) return false
  const dv = clean.slice(-1)
  const digits = clean.slice(0, -1)
  if (!/^\d+$/.test(digits)) return false
  return calcDv(digits) === dv
}

function displayRut(value) {
  const clean = cleanRut(value)
  if (clean.length < 2) return String(value ?? '')
  const digits = clean.slice(0, -1).replace(/^0+/, '') || '0'
  return `${digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${clean.slice(-1)}`
}

function normalizeRutFromRow(row) {
  const rutBase = cleanRut(row.RUT)
  const dv = cleanRut(row.DV)
  const rutCompleto = cleanRut(row['RUT COMPLETO'])
  const candidate = validateRut(rutCompleto)
    ? rutCompleto
    : validateRut(`${rutBase}${dv}`)
      ? `${rutBase}${dv}`
      : rutCompleto || `${rutBase}${dv}`

  const isValid = validateRut(candidate)
  const rutidKey = isValid ? cleanRut(candidate).replace(/^0+/, '') : null
  const rutidPadded = isValid ? cleanRut(candidate).padStart(10, '0') : null

  return {
    rutidKey,
    rutidPadded,
    rutFormateado: isValid ? displayRut(candidate) : candidate,
    isValid,
  }
}

function csvEscape(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function writeCsv(rows, headers) {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(OUTPUT_CSV)
    stream.on('finish', resolve)
    stream.on('error', reject)
    stream.write(`${headers.map(csvEscape).join(',')}\n`)
    for (const row of rows) {
      stream.write(`${headers.map(header => csvEscape(row[header])).join(',')}\n`)
    }
    stream.end()
  })
}

function compact(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

function normalizePhone(value) {
  let digits = String(value ?? '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (!digits.startsWith('56')) {
    if (digits.length === 9) digits = `56${digits}`
    else if (digits.length === 8) digits = `562${digits}`
  }
  return digits.length >= 10 ? `+${digits}` : null
}

function hasLowInformationPhonePattern(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '')
  const local = digits.startsWith('56') ? digits.slice(2) : digits
  if (!local) return false
  if (/^(\d)\1{7,}$/.test(local)) return true
  if (/^(2|9)(0{7,}|1{7,}|2{7,}|5{7,}|9{7,})$/.test(local)) return true
  return false
}

function scrubSharedPhones(rows) {
  const rutidsByPhone = new Map()
  for (const row of rows) {
    const phone = normalizePhone(row.mejor_telefono)
    if (!phone || !row.rutid) continue
    if (!rutidsByPhone.has(phone)) rutidsByPhone.set(phone, new Set())
    rutidsByPhone.get(phone).add(row.rutid)
  }

  const sharedPhones = new Set(
    [...rutidsByPhone.entries()]
      .filter(([phone, rutids]) => rutids.size > MAX_SHARED_PHONE_RUTS || hasLowInformationPhonePattern(phone))
      .map(([phone]) => phone)
  )

  if (sharedPhones.size === 0) {
    return { rows, sharedPhones, scrubbedRows: 0 }
  }

  let scrubbedRows = 0
  const cleanedRows = rows.map(row => {
    const phone = normalizePhone(row.mejor_telefono)
    if (!phone || !sharedPhones.has(phone)) {
      return {
        ...row,
        telefono_descartado_masivo: null,
        telefono_descartado_motivo: null,
      }
    }
    scrubbedRows += 1
    return {
      ...row,
      mejor_telefono: null,
      telefono_descartado_masivo: phone,
      telefono_descartado_motivo: hasLowInformationPhonePattern(phone)
        ? 'patron_generico'
        : `telefono_compartido_${rutidsByPhone.get(phone)?.size ?? 0}_ruts`,
    }
  })

  return { rows: cleanedRows, sharedPhones, scrubbedRows }
}

async function insertTempRows(client, rows) {
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE)
    const values = []
    const placeholders = batch.map((row, index) => {
      const offset = index * 10
      values.push(
        row.row_num,
        row.RUT,
        row.DV,
        row.TRAMO,
        row['RUT COMPLETO'],
        row.CRUCE,
        row.rutid_padded,
        row.rutid_key,
        row.rut_formateado,
        row.is_valid
      )
      return `(${Array.from({ length: 10 }, (_, i) => `$${offset + i + 1}`).join(',')})`
    }).join(',')

    await client.query(`
      insert into temp_bdd_input (
        row_num, rut, dv, tramo, rut_completo, cruce,
        rutid_padded, rutid_key, rut_formateado, is_valid
      ) values ${placeholders}
    `, values)
  }
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  const workbook = XLSX.readFile(INPUT_PATH, { cellDates: false })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const sourceRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false })
    .slice(0, MAX_ROWS > 0 ? MAX_ROWS : undefined)
  console.log(`source rows: ${sourceRows.length}`)

  const rows = sourceRows.map((row, index) => {
    const normalized = normalizeRutFromRow(row)
    return {
      row_num: index + 1,
      RUT: compact(row.RUT),
      DV: compact(row.DV),
      TRAMO: compact(row.TRAMO),
      'RUT COMPLETO': compact(row['RUT COMPLETO']),
      CRUCE: compact(row.CRUCE),
      rutid_padded: normalized.rutidPadded,
      rutid_key: normalized.rutidKey,
      rut_formateado: normalized.rutFormateado,
      is_valid: normalized.isValid,
    }
  })

  const client = new Client({
    connectionString: postgresConnectionString(),
    ssl: { rejectUnauthorized: false },
  })

  await client.connect()
  console.log('connected to postgres')
  await client.query('set statement_timeout = 0')
  await client.query('begin')
  await client.query(`
    create temp table temp_bdd_input (
      row_num integer primary key,
      rut text,
      dv text,
      tramo text,
      rut_completo text,
      cruce text,
      rutid_padded text,
      rutid_key text,
      rut_formateado text,
      is_valid boolean
    ) on commit drop
  `)
  await insertTempRows(client, rows)
  console.log('loaded temp rows')
  await client.query('create index on temp_bdd_input (rutid_padded)')
  await client.query('create index on temp_bdd_input (rutid_key)')
  console.log('querying enrichment')

  const { rows: enriched } = await client.query(`
    with contact_points as (
      select
        rutid as rutid_padded,
        string_agg(distinct contact_value, ' | ') filter (
          where lower(contact_type) in ('email', 'mail', 'correo')
             or contact_value ~* '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
        ) as emails_contactos,
        string_agg(distinct contact_value, ' | ') filter (
          where lower(contact_type) in ('phone', 'telefono', 'teléfono', 'fono', 'celular', 'mobile')
             or regexp_replace(contact_value, '[^0-9]', '', 'g') ~ '^[0-9]{8,}$'
        ) as telefonos_contactos,
        count(*) as total_contact_points,
        max(last_seen_at) as contacto_ultimo_seen
      from public.persona_contact_points
      where rutid in (
        select rutid_padded from temp_bdd_input where rutid_padded is not null
      )
      group by 1
    ),
    bbrr_contacts as (
      select
        rutid as rutid_padded,
        string_agg(distinct nullif(btrim(email), ''), ' | ') as emails_bbrr,
        string_agg(distinct nullif(btrim(concat_ws('', fono_area_cel, fono_numero_cel)), ''), ' | ') as celulares_bbrr,
        string_agg(distinct nullif(btrim(concat_ws('', fono_area_comer, fono_numero_comer)), ''), ' | ') as telefonos_comerciales_bbrr,
        string_agg(distinct nullif(btrim(concat_ws('', fono_area_part, fono_numero_part)), ''), ' | ') as telefonos_particulares_bbrr,
        string_agg(distinct nullif(btrim(direccion), ''), ' | ') as direcciones_bbrr
      from public.bbrr_propiedades
      where rutid in (
        select rutid_padded from temp_bdd_input where rutid_padded is not null
      )
      group by 1
    ),
    master as (
      select
        pm.*,
        coalesce(nullif(btrim(pm.region_canonica), ''), nullif(btrim(pm.region_part), ''), nullif(btrim(pm.domicilio_region), '')) as region_mejor,
        coalesce(nullif(btrim(pm.comuna_canonica), ''), nullif(btrim(pm.comuna_part), ''), nullif(btrim(pm.domicilio_comuna), '')) as comuna_mejor
      from public.master_personas_view pm
      join temp_bdd_input t on t.rutid_padded = pm.rutid
    )
    select
      t.row_num as fila_origen,
      t.rut as rut,
      t.dv as dv,
      t.tramo as tramo,
      t.rut_completo as rut_completo_original,
      t.cruce as cruce,
      t.rut_formateado,
      t.rutid_padded as rutid,
      case
        when not t.is_valid then 'invalid'
        when m.rutid is null then 'not_found'
        else 'matched'
      end as match_status,
      m.nombre_completo,
      m.nombres,
      m.paterno,
      m.materno,
      m.razon_social_empresa,
      m.email as email_maestro,
      cp.emails_contactos,
      bc.emails_bbrr,
      coalesce(nullif(m.email, ''), cp.emails_contactos, bc.emails_bbrr) as mejor_email,
      m.fono_cel as telefono_maestro,
      cp.telefonos_contactos,
      bc.celulares_bbrr,
      bc.telefonos_comerciales_bbrr,
      bc.telefonos_particulares_bbrr,
      coalesce(nullif(m.fono_cel, ''), cp.telefonos_contactos, bc.celulares_bbrr, bc.telefonos_comerciales_bbrr, bc.telefonos_particulares_bbrr) as mejor_telefono,
      addr.direccion as direccion_preferida,
      addr.comuna as direccion_preferida_comuna,
      addr.region as direccion_preferida_region,
      addr.fuente as direccion_fuente,
      bc.direcciones_bbrr,
      m.comuna_part,
      m.region_part,
      m.domicilio_comuna,
      m.domicilio_region,
      m.comuna_mejor,
      m.region_mejor,
      m.n_autos,
      m.tiene_autos,
      m.n_bienes_raices,
      m.totalavaluos,
      m.tiene_bienes_raices,
      m.tiene_empresa,
      m.score_patrimonial,
      m.cobertura_pct,
      exec.nombre_ejecutivo,
      exec.rutid_ejecutivo,
      exec.area as ejecutivo_area,
      exec.cargo as ejecutivo_cargo,
      exec.email as ejecutivo_email,
      exec.celular as ejecutivo_celular,
      exec.telefono_comercial as ejecutivo_telefono_comercial,
      exec.mejor_telefono as ejecutivo_mejor_telefono,
      exec.contact_priority as ejecutivo_prioridad,
      cp.total_contact_points,
      cp.contacto_ultimo_seen
    from temp_bdd_input t
    left join master m on m.rutid = t.rutid_padded
    left join public.empresas_direccion_preferida addr on addr.rutid = t.rutid_key
    left join contact_points cp on cp.rutid_padded = t.rutid_padded
    left join bbrr_contacts bc on bc.rutid_padded = t.rutid_padded
    left join public.company_best_executive_contact exec
      on exec.rutid = t.rutid_padded
    order by t.row_num
  `)

  await client.query('commit')
  await client.end()
  console.log(`enriched rows: ${enriched.length}`)
  const phoneScrub = scrubSharedPhones(enriched)
  const cleanEnriched = phoneScrub.rows
  console.log(`telefonos descartados por uso masivo: ${phoneScrub.scrubbedRows}`)

  const headers = Object.keys(cleanEnriched[0] ?? {})
  await writeCsv(cleanEnriched, headers)
  console.log(`saved csv: ${OUTPUT_CSV}`)

  if (WRITE_XLSX) {
    const outBook = XLSX.utils.book_new()
    const outSheet = XLSX.utils.json_to_sheet(cleanEnriched, { header: headers })
    XLSX.utils.book_append_sheet(outBook, outSheet, 'BDD enriquecida')
    XLSX.writeFile(outBook, OUTPUT_XLSX, { compression: true })
    console.log(`saved xlsx: ${OUTPUT_XLSX}`)
  }

  const matched = cleanEnriched.filter(row => row.match_status === 'matched').length
  const invalid = cleanEnriched.filter(row => row.match_status === 'invalid').length
  const notFound = cleanEnriched.filter(row => row.match_status === 'not_found').length
  const withEmail = cleanEnriched.filter(row => compact(row.mejor_email)).length
  const withPhone = cleanEnriched.filter(row => compact(row.mejor_telefono)).length
  const withAddress = cleanEnriched.filter(row => compact(row.direccion_preferida) || compact(row.direcciones_bbrr)).length

  console.log(JSON.stringify({
    input: INPUT_PATH,
    outputXlsx: WRITE_XLSX ? OUTPUT_XLSX : null,
    outputCsv: OUTPUT_CSV,
    total: enriched.length,
    matched,
    invalid,
    notFound,
    withEmail,
    withPhone,
    withAddress,
    sharedPhonesDiscarded: phoneScrub.scrubbedRows,
    sharedPhoneThreshold: MAX_SHARED_PHONE_RUTS,
  }, null, 2))
}

main().catch(async error => {
  console.error(error)
  process.exitCode = 1
})
