import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PDFParse } from 'pdf-parse'
import { persistWeekRun } from './supabase-hh-store.mjs'

const TELETRAK_CALENDAR_URL = 'https://teletrak.cl/calendario/'
const TELETRAK_AJAX_URL = 'https://teletrak.cl/wp-admin/admin-ajax.php'
const OUT_DIR = 'exports/hh'

const HIPODROMOS = [
  { id: 1, name: 'Club Hipico de Concepcion' },
  { id: 2, name: 'Valparaiso Sporting Club' },
  { id: 3, name: 'Club Hipico de Santiago' },
  { id: 4, name: 'Hipodromo Chile' },
  { id: 5, name: 'Simulcasting' },
]

function parseArgs() {
  const args = new Map()
  for (const raw of process.argv.slice(2)) {
    const [key, ...valueParts] = raw.replace(/^--/, '').split('=')
    args.set(key, valueParts.join('=') || 'true')
  }
  return {
    year: Number(args.get('year') ?? 2026),
    month: Number(args.get('month') ?? 5),
    from: args.get('from') ?? '2026-05-04',
    to: args.get('to') ?? '2026-05-10',
  }
}

function toDate(value) {
  return new Date(`${value}T00:00:00.000Z`)
}

function inRange(date, from, to) {
  const current = toDate(date).getTime()
  return current >= toDate(from).getTime() && current <= toDate(to).getTime()
}

function stripAccents(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'rut-intelligence-hh/1.0' },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`)
  return response.text()
}

async function fetchBuffer(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'rut-intelligence-hh/1.0' },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

async function getTeletrakNonce() {
  const html = await fetchText(TELETRAK_CALENDAR_URL)
  const nonce = html.match(/var hipodromo_ajax = .*?"nonce":"([^"]+)"/)?.[1]
  if (!nonce) throw new Error('No pude leer nonce de Teletrak.')
  return nonce
}

async function getTeletrakRaces({ year, month, from, to }) {
  const nonce = await getTeletrakNonce()
  const all = []
  for (const hipodromo of HIPODROMOS) {
    const body = new URLSearchParams({
      action: 'get_hipodromo_races_detailed',
      nonce,
      hipodromo_id: String(hipodromo.id),
      year: String(year),
      month: String(month),
    })
    const response = await fetch(TELETRAK_AJAX_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body,
    })
    const json = await response.json()
    const races = json?.success ? json.data?.races ?? [] : []
    for (const race of races) {
      if (!inRange(race.fecha_carrera, from, to)) continue
      all.push({
        hipodromo_id: hipodromo.id,
        hipodromo: hipodromo.name,
        fecha: race.fecha_carrera,
        hora: race.hora_inicio,
        descripcion: race.descripcion,
        programa_pdf: race.programa_pdf || '',
        link_hipodromo: race.link_hipodromo || '',
      })
    }
  }
  return all.sort((a, b) => `${a.fecha} ${a.hora}`.localeCompare(`${b.fecha} ${b.hora}`))
}

async function resolveProgramPdf(race) {
  if (!race.programa_pdf) return null
  if (race.programa_pdf.toLowerCase().endsWith('.pdf')) return race.programa_pdf

  const html = await fetchText(race.programa_pdf)
  const pdf = html.match(/https:\/\/static\.clubhipico\.cl\/archivos\/volantes\/[^"]+\.pdf/i)?.[0]
  return pdf ?? null
}

async function pdfToText(url) {
  const data = await fetchBuffer(url)
  const parser = new PDFParse({ data })
  const result = await parser.getText()
  await parser.destroy()
  return result.text
}

function parseOpciones(section) {
  const opc = section.match(/OPC(?:IONES)?:\s*([0-9\-\s]+)/i)?.[1]
  if (!opc) return []
  return opc.split('-').map(item => Number(item.trim())).filter(Number.isFinite)
}

function parseRaceSections(text) {
  const normalized = text.replace(/\r/g, '\n')
  const matches = [...normalized.matchAll(/(^|\n)(\d{1,2}:\d{2})\s*(?:APROX\.|aprox\.)?[\s\S]*?(?=\n\d{1,2}:\d{2}\s*(?:APROX\.|aprox\.)?|$)/g)]
  return matches.map((match, index) => ({
    race_number: index + 1,
    time: match[2],
    text: match[0],
  }))
}

function extractHorseName(line) {
  const withoutNumber = line.replace(/^\s*\d+\s+/, '')
  const beforeDash = withoutNumber.split(/\s+-\s+| -/)[0]
  return clean(beforeDash.replace(/\([^)]*\)/g, ''))
}

function parseRecentPositions(line) {
  const positions = []
  const tokens = line.match(/\b(?:RD|rodo|\d{1,2})(?:cA|cP|vP|c|v|h|P|A)?\b/gi) ?? []
  for (const token of tokens.slice(0, 8)) {
    const n = Number(token.match(/\d+/)?.[0])
    if (Number.isFinite(n) && n > 0 && n <= 20) positions.push(n)
  }
  return positions.slice(0, 3)
}

function parseDividend(line) {
  const values = [...line.matchAll(/\b\d{1,3}[,.]\d{1,2}\b/g)].map(match => Number(match[0].replace(',', '.')))
  return values.length ? values.at(-1) ?? null : null
}

function parseProgramConnections(line) {
  const people = [...line.matchAll(/\b(?:[A-Z]\.\s*){1,3}[A-ZÁÉÍÓÚÑ][a-záéíóúñ.'-]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ.'-]+)?/g)]
    .map(match => clean(match[0]))
    .filter(value => !/\d/.test(value))

  return {
    jockey: people[0] ?? null,
    trainer: people[1] ?? null,
  }
}

function parseParticipants(section) {
  const lines = section.text.split('\n').map(clean).filter(Boolean)
  const participants = []
  for (const line of lines) {
    if (!/^\d{1,2}\s+[A-ZÁÉÍÓÚÑ0-9' ]{3,}/.test(line)) continue
    if (/^\d{1,2}\s+\d/.test(line)) continue
    const number = Number(line.match(/^\d{1,2}/)?.[0])
    const horse = extractHorseName(line)
    if (!horse || horse.length < 2) continue
    const recent = parseRecentPositions(line)
    const connections = parseProgramConnections(line)
    participants.push({
      number,
      horse,
      horse_key: stripAccents(horse).toUpperCase(),
      jockey: connections.jockey,
      trainer: connections.trainer,
      recent_positions: recent,
      last_dividend: parseDividend(line),
      raw_line: line,
    })
  }
  return participants
}

function scoreRace(section) {
  const options = parseOpciones(section.text)
  const participants = parseParticipants(section)
  const optionScore = new Map(options.map((number, index) => [number, Math.max(0.1, 1 - index * 0.18)]))
  const scored = participants.map(participant => {
    const recent = participant.recent_positions.length
      ? participant.recent_positions.reduce((acc, pos) => acc + Math.max(0, 12 - pos) / 12, 0) / participant.recent_positions.length
      : 0.35
    const market = participant.last_dividend ? Math.min(1, 1 / Math.max(1.2, participant.last_dividend) * 2.5) : 0.35
    const option = optionScore.get(participant.number) ?? 0.25
    const rawScore = option * 1.4 + recent * 1.1 + market * 0.6
    return { ...participant, raw_score: rawScore, signal: { option, recent, market } }
  })
  if (!scored.length) return { ...section, options, predictions: [] }
  const max = Math.max(...scored.map(item => item.raw_score))
  const exps = scored.map(item => Math.exp(item.raw_score - max))
  const sum = exps.reduce((acc, value) => acc + value, 0)
  const predictions = scored.map((item, index) => {
    const win = exps[index] / sum
    const podium = Math.min(0.9, win * 2.4 + item.signal.recent * 0.2 + item.signal.option * 0.12)
    return {
      ...item,
      win_probability: win,
      podium_probability: podium,
      risk: item.recent_positions.length ? 'medio' : 'alto',
    }
  }).sort((a, b) => b.win_probability - a.win_probability)
  return { ...section, options, predictions }
}

async function buildProgramProjection(race) {
  const pdfUrl = await resolveProgramPdf(race)
  if (!pdfUrl) return { ...race, pdf_url: null, status: 'sin_programa_pdf', races: [] }
  const text = await pdfToText(pdfUrl)
  const sections = parseRaceSections(text).map(scoreRace).filter(section => section.predictions.length)
  return { ...race, pdf_url: pdfUrl, status: sections.length ? 'proyectado' : 'sin_parse', races: sections }
}

function renderReport({ generatedAt, races, projections }) {
  const lines = [
    '# HH - Calendario y proyeccion semana hipica',
    '',
    `Generado: ${generatedAt}`,
    '',
    '## Donde hay carreras',
    '',
    '| Fecha | Hora | Hipodromo | Descripcion | Programa |',
    '|---|---:|---|---|---|',
    ...races.map(race => `| ${race.fecha} | ${race.hora ?? ''} | ${race.hipodromo} | ${race.descripcion} | ${race.programa_pdf ? 'Disponible' : 'Pendiente'} |`),
    '',
    '## Programas disponibles usados',
    '',
    ...projections.map(item => `- ${item.fecha} ${item.hipodromo}: ${item.status}${item.pdf_url ? ` (${item.pdf_url})` : ''}`),
    '',
    '## Top por carrera',
  ]

  for (const item of projections) {
    if (!item.races.length) continue
    lines.push('', `### ${item.fecha} - ${item.hipodromo}`)
    for (const race of item.races) {
      lines.push('', `#### Carrera ${race.race_number} - ${race.time}`)
      lines.push('| Rank | Caballo | P(gana) | P(podio) | Riesgo | Senal |')
      lines.push('|---:|---|---:|---:|---|---|')
      for (const [idx, row] of race.predictions.slice(0, 8).entries()) {
        const signal = `opc=${row.signal.option.toFixed(2)} forma=${row.signal.recent.toFixed(2)} mercado=${row.signal.market.toFixed(2)}`
        lines.push(`| ${idx + 1} | ${row.horse} | ${pct(row.win_probability)} | ${pct(row.podium_probability)} | ${row.risk} | ${signal} |`)
      }
    }
  }

  lines.push(
    '',
    '## Nota tecnica',
    '',
    'Esta proyeccion usa el programa oficial disponible por Teletrak/hipodromos y una senal base de opciones del programa, forma reciente extraida del volante y dividendo historico visible en el PDF. No es todavia el modelo anual completo por todos los hipodromos; para eso faltan adapters historicos de Club Hipico, Hipodromo Chile y Concepcion.'
  )

  return lines.join('\n')
}

async function main() {
  const options = parseArgs()
  const generatedAt = new Date().toISOString()
  console.log('[HH] Buscando calendario Teletrak', options)
  const races = await getTeletrakRaces(options)
  console.log(`[HH] Carreras encontradas: ${races.length}`)

  const projections = []
  for (const race of races.filter(race => race.programa_pdf)) {
    console.log(`[HH] Procesando programa ${race.fecha} ${race.hipodromo}`)
    try {
      projections.push(await buildProgramProjection(race))
    } catch (error) {
      projections.push({ ...race, status: `error: ${error.message}`, races: [] })
    }
  }

  await mkdir(OUT_DIR, { recursive: true })
  const stamp = generatedAt.replace(/[:.]/g, '-')
  const jsonPath = path.join(OUT_DIR, `hh_week_${stamp}.json`)
  const reportPath = path.join(OUT_DIR, `hh_week_${stamp}.md`)
  await writeFile(jsonPath, JSON.stringify({ generatedAt, options, races, projections }, null, 2))
  await writeFile(reportPath, renderReport({ generatedAt, races, projections }))
  console.log(`[HH] JSON: ${jsonPath}`)
  console.log(`[HH] Reporte: ${reportPath}`)

  const persisted = await persistWeekRun({ generatedAt, options, races, projections }, { jsonPath, reportPath })
  if (persisted.skipped) {
    console.log(`[HH] Supabase: omitido (${persisted.reason})`)
  } else {
    console.log(`[HH] Supabase: run=${persisted.runId}, meetings=${persisted.meetings}, entries=${persisted.programEntries}, predictions=${persisted.predictions}`)
  }
}

main().catch(error => {
  console.error('[HH] Fallo semanal:', error)
  process.exitCode = 1
})
