import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import Papa from 'papaparse'
import pg from 'pg'

const INPUT_CSV = process.argv[2] || path.join(process.cwd(), 'outputs', 'bdd_equifax_gestiones_2026-05-07', 'BDD_pendientes_sin_gestion_target_limpio.csv')
const OUTPUT_DIR = process.argv[3] || path.dirname(INPUT_CSV)
const OUTPUT_CSV = path.join(OUTPUT_DIR, 'BDD_pendientes_sin_gestion_target_limpio_con_colores.csv')
const SUMMARY_CSV = path.join(OUTPUT_DIR, 'BDD_pendientes_target_limpio_colores_resumen.csv')
const BATCH_SIZE = 1000

function postgresConnectionString() {
  const raw = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL
  if (!raw) return raw
  const url = new URL(raw)
  url.searchParams.delete('sslmode')
  return url.toString()
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
      const offset = index * 2
      values.push(row.rutid, row.fila_origen)
      return `($${offset + 1}, $${offset + 2})`
    }).join(',')
    await client.query(`insert into temp_clean_base (rutid, fila_origen) values ${placeholders}`, values)
  }
}

async function fetchScores(rows) {
  const scores = new Map()
  const client = new pg.Client({
    connectionString: postgresConnectionString(),
    ssl: { rejectUnauthorized: false },
  })
  await client.connect()
  await client.query('set statement_timeout = 0')
  await client.query('begin')
  await client.query('create temp table temp_clean_base (rutid text primary key, fila_origen integer) on commit drop')
  await insertTempRows(client, rows)

  const { rows: scoreRows } = await client.query(`
    select
      t.rutid,
      s.company_name as score_company_name,
      s.model_version,
      s.model_type,
      s.contact_probability,
      s.interest_probability,
      s.purchase_probability,
      s.fit_score,
      s.lead_score,
      s.lead_temperature,
      s.recommended_channel,
      s.recommended_hour,
      s.reason_tags,
      s.scored_at
    from temp_clean_base t
    left join public.equifax_lead_scores s on s.rutid = t.rutid
  `)

  await client.query('commit')
  await client.end()

  for (const row of scoreRows) {
    scores.set(row.rutid, row)
  }

  return scores
}

async function main() {
  const parsed = Papa.parse(fs.readFileSync(INPUT_CSV, 'utf8'), {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  })
  if (parsed.errors.length > 0) throw new Error(parsed.errors[0].message)

  const rows = parsed.data
  console.log(`base limpia: ${rows.length}`)
  const scoresByRut = await fetchScores(rows)

  const outRows = rows.map(row => {
    const score = scoresByRut.get(row.rutid)
    return {
      ...row,
      color_equifax: score?.lead_temperature ?? 'sin_score',
      lead_score: score?.lead_score ?? '',
      contact_probability: score?.contact_probability ?? '',
      interest_probability: score?.interest_probability ?? '',
      purchase_probability: score?.purchase_probability ?? '',
      fit_score: score?.fit_score ?? '',
      recommended_channel: score?.recommended_channel ?? '',
      recommended_hour: score?.recommended_hour ?? '',
      score_model_version: score?.model_version ?? '',
      score_model_type: score?.model_type ?? '',
      scored_at: score?.scored_at ?? '',
      score_reason_tags: score?.reason_tags ? JSON.stringify(score.reason_tags) : '',
    }
  })

  const counts = new Map()
  for (const row of outRows) {
    counts.set(row.color_equifax, (counts.get(row.color_equifax) ?? 0) + 1)
  }

  const order = ['green', 'yellow', 'red', 'sin_score']
  const summaryRows = order
    .filter(color => counts.has(color))
    .map(color => ({
      color_equifax: color,
      cantidad: counts.get(color),
      pct: ((counts.get(color) / outRows.length) * 100).toFixed(2),
    }))

  await writeCsv(OUTPUT_CSV, outRows, Object.keys(outRows[0] ?? {}))
  await writeCsv(SUMMARY_CSV, summaryRows, ['color_equifax', 'cantidad', 'pct'])

  console.log(JSON.stringify({
    input: INPUT_CSV,
    outputCsv: OUTPUT_CSV,
    summaryCsv: SUMMARY_CSV,
    total: outRows.length,
    colors: summaryRows,
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
