import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import Papa from 'papaparse'
import pg from 'pg'

const INPUT_CSV = process.argv[2] || path.join(process.cwd(), 'outputs', 'bdd_enriched_2026-05-07', 'BDD_enriquecida.csv')
const OUTPUT_DIR = process.argv[3] || path.join(process.cwd(), 'outputs', 'bdd_equifax_gestiones_2026-05-07')
const SUMMARY_CSV = path.join(OUTPUT_DIR, 'BDD_telefonos_cruce_gestiones_equifax_resumen.csv')
const DETAIL_CSV = path.join(OUTPUT_DIR, 'BDD_telefonos_cruce_gestiones_equifax_detalle.csv')
const BATCH_SIZE = 1000

function postgresConnectionString() {
  const raw = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL
  if (!raw) return raw
  const url = new URL(raw)
  url.searchParams.delete('sslmode')
  return url.toString()
}

function present(value) {
  return value !== null && value !== undefined && String(value).trim().length > 0
}

function csvEscape(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

async function writeCsv(filePath, rows, headers) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
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
      const offset = index * 9
      values.push(
        row.fila_origen,
        row.rutid,
        row.rut_formateado,
        row.razon_social_empresa,
        row.nombre_completo,
        row.mejor_telefono,
        row.telefono_maestro,
        row.telefonos_contactos,
        row.mejor_email
      )
      return `(${Array.from({ length: 9 }, (_, i) => `$${offset + i + 1}`).join(',')})`
    }).join(',')

    await client.query(`
      insert into temp_bdd_telefonos (
        fila_origen, rutid, rut_formateado, razon_social_empresa, nombre_completo,
        mejor_telefono, telefono_maestro, telefonos_contactos, mejor_email
      ) values ${placeholders}
    `, values)
  }
}

function loadPhoneRows() {
  const csv = fs.readFileSync(INPUT_CSV, 'utf8')
  const parsed = Papa.parse(csv, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  })
  if (parsed.errors.length > 0) {
    const first = parsed.errors[0]
    throw new Error(`No se pudo leer CSV: ${first.message}`)
  }

  return parsed.data
    .filter(row => present(row.rutid) && present(row.mejor_telefono))
    .map(row => ({
      fila_origen: Number.parseInt(row.fila_origen, 10),
      rutid: row.rutid,
      rut_formateado: row.rut_formateado,
      razon_social_empresa: row.razon_social_empresa,
      nombre_completo: row.nombre_completo,
      mejor_telefono: row.mejor_telefono,
      telefono_maestro: row.telefono_maestro,
      telefonos_contactos: row.telefonos_contactos,
      mejor_email: row.mejor_email,
    }))
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  const phoneRows = loadPhoneRows()
  console.log(`ruts con telefono: ${phoneRows.length}`)

  const client = new pg.Client({
    connectionString: postgresConnectionString(),
    ssl: { rejectUnauthorized: false },
  })
  await client.connect()
  await client.query('set statement_timeout = 0')
  await client.query('begin')
  await client.query(`
    create temp table temp_bdd_telefonos (
      fila_origen integer,
      rutid text primary key,
      rut_formateado text,
      razon_social_empresa text,
      nombre_completo text,
      mejor_telefono text,
      telefono_maestro text,
      telefonos_contactos text,
      mejor_email text
    ) on commit drop
  `)
  await insertTempRows(client, phoneRows)
  await client.query('create index on temp_bdd_telefonos (rutid)')
  console.log('consultando gestiones equifax/dicom')

  const equifaxFeedbackCte = `
    with equifax_feedback as (
      select
        f.*,
        coalesce(nullif(f.matched_rutid, ''), nullif(f.rutid, '')) as match_rutid
      from public.contact_center_feedback f
      where
        coalesce(f.campaign_name, '') ilike '%equifax%'
        or coalesce(f.campaign_name, '') ilike '%dicom%'
        or coalesce(f.raw_payload::text, '') ilike '%dicom_equifax%'
        or coalesce(f.raw_payload::text, '') ilike '%equifax%'
        or coalesce(f.raw_payload::text, '') ilike '%dicom%'
    )
  `

  const { rows: summaryRows } = await client.query(`
    ${equifaxFeedbackCte},
    agg as (
      select
        match_rutid as rutid,
        count(*)::int as total_gestiones_equifax,
        count(*) filter (where channel = 'phone')::int as gestiones_phone,
        count(*) filter (where channel = 'email')::int as gestiones_email,
        count(*) filter (where contacted)::int as contactos,
        count(*) filter (where effective_contact)::int as contactos_efectivos,
        count(*) filter (where interested)::int as interesados,
        count(*) filter (where callback_requested or outcome = 'callback')::int as callbacks,
        count(*) filter (where sale)::int as ventas,
        count(*) filter (where outcome = 'no_contact')::int as no_contacto,
        min(managed_at) as primera_gestion,
        max(managed_at) as ultima_gestion,
        string_agg(distinct campaign_name, ' | ') as campanas,
        string_agg(distinct external_source, ' | ') as fuentes,
        string_agg(distinct agent_name, ' | ') filter (where agent_name is not null) as agentes,
        string_agg(distinct outcome::text, ' | ') as resultados,
        string_agg(distinct outcome_subtype, ' | ') filter (where outcome_subtype is not null) as subresultados
      from equifax_feedback
      where match_rutid in (select rutid from temp_bdd_telefonos)
      group by 1
    ),
    latest as (
      select distinct on (match_rutid)
        match_rutid as rutid,
        managed_at as ultima_gestion_fecha,
        outcome as ultimo_resultado,
        outcome_subtype as ultimo_subresultado,
        channel as ultimo_canal,
        campaign_name as ultima_campana,
        agent_name as ultimo_agente,
        contact_phone as telefono_gestionado,
        contact_email as email_gestionado,
        external_source as ultima_fuente
      from equifax_feedback
      where match_rutid in (select rutid from temp_bdd_telefonos)
      order by match_rutid, managed_at desc nulls last, created_at desc
    )
    select
      t.fila_origen,
      t.rut_formateado,
      t.rutid,
      t.razon_social_empresa,
      t.nombre_completo,
      t.mejor_telefono,
      t.telefono_maestro,
      t.telefonos_contactos,
      t.mejor_email,
      (coalesce(a.total_gestiones_equifax, 0) > 0) as gestionado_equifax_dicom,
      coalesce(a.total_gestiones_equifax, 0) as total_gestiones_equifax,
      coalesce(a.gestiones_phone, 0) as gestiones_phone,
      coalesce(a.gestiones_email, 0) as gestiones_email,
      coalesce(a.contactos, 0) as contactos,
      coalesce(a.contactos_efectivos, 0) as contactos_efectivos,
      coalesce(a.interesados, 0) as interesados,
      coalesce(a.callbacks, 0) as callbacks,
      coalesce(a.ventas, 0) as ventas,
      coalesce(a.no_contacto, 0) as no_contacto,
      a.primera_gestion,
      a.ultima_gestion,
      l.ultimo_resultado,
      l.ultimo_subresultado,
      l.ultimo_canal,
      l.ultima_campana,
      l.ultimo_agente,
      l.telefono_gestionado,
      l.email_gestionado,
      l.ultima_fuente,
      a.campanas,
      a.fuentes,
      a.agentes,
      a.resultados,
      a.subresultados
    from temp_bdd_telefonos t
    left join agg a on a.rutid = t.rutid
    left join latest l on l.rutid = t.rutid
    order by gestionado_equifax_dicom desc, total_gestiones_equifax desc, t.fila_origen
  `)

  const { rows: detailRows } = await client.query(`
    ${equifaxFeedbackCte}
    select
      t.fila_origen,
      t.rut_formateado,
      t.rutid,
      t.razon_social_empresa,
      t.nombre_completo,
      t.mejor_telefono,
      t.mejor_email,
      f.managed_at as fecha_gestion,
      f.channel as canal,
      f.outcome as resultado,
      f.outcome_subtype as subresultado,
      f.outcome_reason as motivo,
      f.campaign_name as campana,
      f.external_source as fuente,
      f.external_event_id,
      f.agent_name as agente,
      f.contact_phone as telefono_gestionado,
      f.contact_email as email_gestionado,
      f.duration_seconds,
      f.talk_seconds,
      f.callback_requested,
      f.interested,
      f.contacted,
      f.effective_contact,
      f.sale,
      f.value_amount
    from temp_bdd_telefonos t
    join equifax_feedback f
      on f.match_rutid = t.rutid
    order by t.fila_origen, f.managed_at desc nulls last
  `)

  await client.query('commit')
  await client.end()

  await writeCsv(SUMMARY_CSV, summaryRows, Object.keys(summaryRows[0] ?? {}))
  await writeCsv(DETAIL_CSV, detailRows, Object.keys(detailRows[0] ?? {}))

  const managedRows = summaryRows.filter(row => row.gestionado_equifax_dicom === true || row.gestionado_equifax_dicom === 'true')
  const managedPhone = summaryRows.filter(row => Number(row.gestiones_phone ?? 0) > 0)
  const managedEmail = summaryRows.filter(row => Number(row.gestiones_email ?? 0) > 0)
  const effective = summaryRows.filter(row => Number(row.contactos_efectivos ?? 0) > 0)

  console.log(JSON.stringify({
    input: INPUT_CSV,
    summaryCsv: SUMMARY_CSV,
    detailCsv: DETAIL_CSV,
    rutsConTelefono: phoneRows.length,
    rutsGestionadosEquifaxDicom: managedRows.length,
    rutsGestionadosPhone: managedPhone.length,
    rutsGestionadosEmail: managedEmail.length,
    rutsConContactoEfectivo: effective.length,
    gestionesDetalle: detailRows.length,
    pendientesSinGestion: phoneRows.length - managedRows.length,
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
