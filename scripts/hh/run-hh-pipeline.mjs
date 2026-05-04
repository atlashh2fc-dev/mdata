import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { persistHistoricalRun } from './supabase-hh-store.mjs'

const SPORTING_BASE = 'https://www.sporting.cl'
const DEFAULT_FROM = '2025-05-05'
const DEFAULT_TO = '2026-05-03'
const DEFAULT_TARGET_FROM = '2026-05-04'
const DEFAULT_TARGET_TO = '2026-05-10'

const SUPPORTED_SOURCES = [
  {
    id: 'sporting',
    name: 'Valparaiso Sporting',
    status: 'implemented',
    note: 'HTML oficial con programas, resultados, figuracion, dividendos y estadisticas por ejemplar.',
  },
  {
    id: 'clubhipico',
    name: 'Club Hipico de Santiago',
    status: 'registered',
    note: 'Fuente oficial registrada; requiere adapter contra API/JS de Club Hipico.',
  },
  {
    id: 'hipodromo-chile',
    name: 'Hipodromo Chile',
    status: 'registered',
    note: 'Fuente oficial registrada; requiere adapter contra app Vue/Elturf.',
  },
]

function parseArgs() {
  const args = new Map()
  for (const raw of process.argv.slice(2)) {
    const [key, ...valueParts] = raw.replace(/^--/, '').split('=')
    args.set(key, valueParts.join('=') || 'true')
  }

  return {
    from: args.get('from') ?? DEFAULT_FROM,
    to: args.get('to') ?? DEFAULT_TO,
    targetFrom: args.get('target-from') ?? DEFAULT_TARGET_FROM,
    targetTo: args.get('target-to') ?? DEFAULT_TARGET_TO,
    outDir: args.get('out-dir') ?? 'exports/hh',
    maxDays: Number(args.get('max-days') ?? 0),
    maxRaces: Number(args.get('max-races') ?? 0),
    requestDelayMs: Number(args.get('delay-ms') ?? 150),
  }
}

function toDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) throw new Error(`Fecha invalida: ${value}`)
  return date
}

function formatDate(date) {
  return date.toISOString().slice(0, 10)
}

function eachDate(from, to, maxDays = 0) {
  const dates = []
  const current = toDate(from)
  const end = toDate(to)
  while (current <= end) {
    dates.push(formatDate(current))
    current.setUTCDate(current.getUTCDate() + 1)
    if (maxDays > 0 && dates.length >= maxDays) break
  }
  return dates
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&aacute;/g, 'a')
    .replace(/&eacute;/g, 'e')
    .replace(/&iacute;/g, 'i')
    .replace(/&oacute;/g, 'o')
    .replace(/&uacute;/g, 'u')
    .replace(/&ntilde;/g, 'n')
    .replace(/&Aacute;/g, 'A')
    .replace(/&Eacute;/g, 'E')
    .replace(/&Iacute;/g, 'I')
    .replace(/&Oacute;/g, 'O')
    .replace(/&Uacute;/g, 'U')
    .replace(/&Ntilde;/g, 'N')
}

function stripTags(value) {
  return decodeEntities(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(li|tr|td|th|div|p|h1|h2|h3|strong|small)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function normalizeName(value) {
  return stripTags(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

function textMatch(html, regex, fallback = null) {
  const match = html.match(regex)
  return match ? stripTags(match[1]) : fallback
}

function numberFrom(value) {
  if (value == null) return null
  const clean = String(value).replace(/\./g, '').replace(',', '.').match(/-?\d+(\.\d+)?/)
  return clean ? Number(clean[0]) : null
}

function parseCells(rowHtml) {
  return [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(match => stripTags(match[1]))
}

function parseSportingMeeting(html, date) {
  if (!html.includes('Programa de Carreras')) return null

  const resultLinks = [...html.matchAll(/href="(\/hipica\/front\/es\/resultado\/[0-9-]+\/[0-9]+\.html)"/g)]
    .map(match => `${SPORTING_BASE}${match[1]}`)
  const programLinks = [...html.matchAll(/href="(\/hipica\/front\/es\/programa\/[0-9-]+\/[0-9]+\.html)"/g)]
    .map(match => `${SPORTING_BASE}${match[1]}`)

  return {
    date,
    source: 'sporting',
    meeting: textMatch(html, /<h1>([\s\S]*?)<\/h1>/i),
    resultLinks: [...new Set(resultLinks)],
    programLinks: [...new Set(programLinks)],
  }
}

function parseSportingResult(html, url, date) {
  if (!html.includes('<strong>Resultado:</strong>')) return null

  const raceNumber = numberFrom(url.match(/\/([0-9]+)\.html$/)?.[1])
  const distanceSurface = textMatch(html, /Distancia \/ Tipo Pista:\s*<strong>([\s\S]*?)<\/strong>/i, '')
  const distance = numberFrom(distanceSurface)
  const surface = distanceSurface.includes('/') ? distanceSurface.split('/').pop().trim() : null
  const rows = [...html.matchAll(/<tr>\s*<td>([\s\S]*?)<\/tr>/gi)]
    .map(match => parseCells(`<tr><td>${match[1]}</tr>`))
    .filter(cells => cells.length >= 11 && /^\d+$/.test(cells[0]))

  const participants = rows.map(cells => {
    const horseRaw = cells[2]
    const horse = horseRaw.replace(/\([^)]*\)/g, '').trim()
    return {
      source: 'sporting',
      source_url: url,
      date,
      hippodrome: 'Valparaiso Sporting',
      race_number: raceNumber,
      distance_meters: distance,
      surface,
      track_condition: textMatch(html, /Estado Pista:\s*<strong>([\s\S]*?)<\/strong>/i),
      race_type: textMatch(html, /Tipo:\s*<strong>([\s\S]*?)<\/strong>/i),
      horse,
      horse_key: normalizeName(horse),
      final_position: numberFrom(cells[0]),
      saddle_number: numberFrom(cells[1]),
      age: numberFrom(cells[3]),
      beaten_margin: cells[4] || null,
      horse_weight_kg: numberFrom(cells[5]),
      jockey_weight_kg: numberFrom(cells[6]),
      jockey: cells[7] || null,
      jockey_key: normalizeName(cells[7] || ''),
      trainer: cells[8] || null,
      trainer_key: normalizeName(cells[8] || ''),
      stud: cells[9] || null,
      dividend: numberFrom(cells[10]),
    }
  })

  if (!participants.length) return null

  return {
    source: 'sporting',
    source_url: url,
    date,
    hippodrome: 'Valparaiso Sporting',
    race_number: raceNumber,
    title: textMatch(html, /<h1><strong>Resultado:<\/strong>([\s\S]*?)<\/h1>/i),
    distance_meters: distance,
    surface,
    track_condition: textMatch(html, /Estado Pista:\s*<strong>([\s\S]*?)<\/strong>/i),
    race_type: textMatch(html, /Tipo:\s*<strong>([\s\S]*?)<\/strong>/i),
    winner: textMatch(html, /<strong>Ganador:<\/strong>\s*([\s\S]*?)<div/i),
    final_time: textMatch(html, /<strong>Tiempo:<\/strong>\s*([\s\S]*?)<\/div>/i),
    favorite: textMatch(html, /Favorito:\s*<strong>([\s\S]*?)<\/strong>/i),
    retirements: textMatch(html, /Retiros:\s*([\s\S]*?)<\/li>/i),
    participants_count: participants.length,
    participants,
  }
}

function parseSportingProgram(html, url, date) {
  if (!html.includes('Ejemplares:')) return null

  const raceNumber = numberFrom(url.match(/\/([0-9]+)\.html$/)?.[1])
  const distanceSurface = textMatch(html, /Distancia \/ Tipo Pista:\s*<strong>([\s\S]*?)<\/strong>/i, '')
  const distance = numberFrom(distanceSurface)
  const surface = distanceSurface.includes('/') ? distanceSurface.split('/').pop().trim() : null
  const blocks = [...html.matchAll(/(<div id="([0-9]+)" class="box-ejemplar[\s\S]*?)(?=<div id="[0-9]+" class="box-ejemplar|<\/section>)/gi)]

  const participants = blocks.map(([, block, horseId]) => {
    const number = numberFrom(textMatch(block, /<span class="number">([\s\S]*?)<\/span>/i))
    const horse = textMatch(block, /<h2><a[^>]*>([\s\S]*?)<\/a><\/h2>/i)
    const totalStats = textMatch(block, /<td class="text-left">Total<\/td>\s*<td>([\s\S]*?)<\/tr>/i, '')
    const totalCells = totalStats ? parseCells(`<tr><td>${totalStats}</tr>`) : []

    return {
      source: 'sporting',
      source_url: url,
      date,
      hippodrome: 'Valparaiso Sporting',
      race_number: raceNumber,
      horse_id: horseId,
      saddle_number: number,
      horse,
      horse_key: normalizeName(horse ?? ''),
      distance_meters: distance,
      surface,
      track_condition: textMatch(html, /Estado Pista:\s*<strong>([\s\S]*?)<\/strong>/i),
      race_type: textMatch(html, /Tipo:\s*<strong>([\s\S]*?)<\/strong>/i),
      age_sex: textMatch(block, /Edad:\s*<strong>([\s\S]*?)<\/strong>/i),
      stud: textMatch(block, /Stud:\s*<strong>([\s\S]*?)<\/strong>/i),
      trainer: textMatch(block, /Preparador:\s*<strong>([\s\S]*?)<\/strong>/i)?.replace(/\s+\d+v\b/i, '').trim() ?? null,
      trainer_key: normalizeName(textMatch(block, /Preparador:\s*<strong>([\s\S]*?)<\/strong>/i) ?? ''),
      jockey: textMatch(block, /Jinete:\s*<strong>([\s\S]*?)<\/strong>/i)?.replace(/\s+\d+v\b/i, '').trim() ?? null,
      jockey_key: normalizeName(textMatch(block, /Jinete:\s*<strong>([\s\S]*?)<\/strong>/i) ?? ''),
      assigned_weight_kg: numberFrom(textMatch(block, /Peso:\s*<strong>([\s\S]*?)<\/strong>/i)),
      total_starts_program: numberFrom(totalCells[0]),
      total_wins_program: numberFrom(totalCells[1]),
      total_seconds_program: numberFrom(totalCells[2]),
      total_thirds_program: numberFrom(totalCells[3]),
    }
  }).filter(item => item.horse)

  if (!participants.length) return null

  return {
    source: 'sporting',
    source_url: url,
    date,
    hippodrome: 'Valparaiso Sporting',
    race_number: raceNumber,
    title: textMatch(html, /<h1><strong>Programa:<\/strong>([\s\S]*?)<\/h1>/i),
    distance_meters: distance,
    surface,
    track_condition: textMatch(html, /Estado Pista:\s*<strong>([\s\S]*?)<\/strong>/i),
    race_type: textMatch(html, /Tipo:\s*<strong>([\s\S]*?)<\/strong>/i),
    participants,
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'rut-intelligence-hh-research/1.0',
      accept: 'text/html,application/xhtml+xml',
    },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`)
  return response.text()
}

async function collectSportingResults(options) {
  const meetings = []
  const races = []
  const errors = []

  for (const date of eachDate(options.from, options.to, options.maxDays)) {
    const meetingUrl = `${SPORTING_BASE}/hipica/front/es/reunion/${date}.html`
    try {
      const html = await fetchText(meetingUrl)
      const meeting = parseSportingMeeting(html, date)
      if (!meeting) continue
      meetings.push(meeting)

      const links = options.maxRaces > 0 ? meeting.resultLinks.slice(0, options.maxRaces) : meeting.resultLinks
      for (const url of links) {
        await sleep(options.requestDelayMs)
        const resultHtml = await fetchText(url)
        const race = parseSportingResult(resultHtml, url, date)
        if (race) races.push(race)
      }
    } catch (error) {
      errors.push({ source: 'sporting', date, url: meetingUrl, error: error.message })
    }
    await sleep(options.requestDelayMs)
  }

  return { meetings, races, errors }
}

async function collectSportingPrograms(options) {
  const programs = []
  const errors = []

  for (const date of eachDate(options.targetFrom, options.targetTo, options.maxDays)) {
    const meetingUrl = `${SPORTING_BASE}/hipica/front/es/reunion/${date}.html`
    try {
      const html = await fetchText(meetingUrl)
      const meeting = parseSportingMeeting(html, date)
      if (!meeting) continue

      const links = options.maxRaces > 0 ? meeting.programLinks.slice(0, options.maxRaces) : meeting.programLinks
      for (const url of links) {
        await sleep(options.requestDelayMs)
        const programHtml = await fetchText(url)
        const program = parseSportingProgram(programHtml, url, date)
        if (program) programs.push(program)
      }
    } catch (error) {
      errors.push({ source: 'sporting', date, url: meetingUrl, error: error.message })
    }
    await sleep(options.requestDelayMs)
  }

  return { programs, errors }
}

function emptyMetric() {
  return { starts: 0, wins: 0, podiums: 0, positionSum: 0 }
}

function addMetric(map, key, result) {
  if (!key) return
  const metric = map.get(key) ?? emptyMetric()
  metric.starts += 1
  metric.wins += result.final_position === 1 ? 1 : 0
  metric.podiums += result.final_position && result.final_position <= 3 ? 1 : 0
  metric.positionSum += result.final_position ?? 0
  map.set(key, metric)
}

function buildMetrics(races) {
  const horse = new Map()
  const jockey = new Map()
  const trainer = new Map()
  const pair = new Map()
  const distanceHorse = new Map()

  for (const race of races) {
    for (const result of race.participants) {
      addMetric(horse, result.horse_key, result)
      addMetric(jockey, result.jockey_key, result)
      addMetric(trainer, result.trainer_key, result)
      addMetric(pair, `${result.horse_key}::${result.jockey_key}`, result)
      addMetric(distanceHorse, `${result.horse_key}::${race.distance_meters ?? 'NA'}::${race.surface ?? 'NA'}`, result)
    }
  }

  return { horse, jockey, trainer, pair, distanceHorse }
}

function rate(metric, kind) {
  if (!metric) return kind === 'win' ? 0.08 : 0.28
  if (kind === 'win') return (metric.wins + 1) / (metric.starts + 8)
  if (kind === 'podium') return (metric.podiums + 3) / (metric.starts + 10)
  return metric.starts ? metric.positionSum / metric.starts : null
}

function programWinRate(participant) {
  const starts = participant.total_starts_program ?? 0
  const wins = participant.total_wins_program ?? 0
  return (wins + 1) / (starts + 8)
}

function softmax(scores) {
  const max = Math.max(...scores)
  const exps = scores.map(score => Math.exp(score - max))
  const sum = exps.reduce((acc, value) => acc + value, 0)
  return exps.map(value => value / sum)
}

function scoreProgram(program, metrics) {
  const scored = program.participants.map(participant => {
    const horseMetric = metrics.horse.get(participant.horse_key)
    const jockeyMetric = metrics.jockey.get(participant.jockey_key)
    const trainerMetric = metrics.trainer.get(participant.trainer_key)
    const pairMetric = metrics.pair.get(`${participant.horse_key}::${participant.jockey_key}`)
    const distanceMetric = metrics.distanceHorse.get(`${participant.horse_key}::${program.distance_meters ?? 'NA'}::${program.surface ?? 'NA'}`)

    const horseWin = rate(horseMetric, 'win')
    const horsePodium = rate(horseMetric, 'podium')
    const jockeyWin = rate(jockeyMetric, 'win')
    const trainerWin = rate(trainerMetric, 'win')
    const pairPodium = rate(pairMetric, 'podium')
    const distancePodium = rate(distanceMetric, 'podium')
    const programRate = programWinRate(participant)
    const dataStarts = (horseMetric?.starts ?? 0) + (jockeyMetric?.starts ?? 0) + (trainerMetric?.starts ?? 0)
    const dataQuality = Math.min(1, dataStarts / 25)

    const rawScore =
      horseWin * 2.4 +
      horsePodium * 1.5 +
      jockeyWin * 1.1 +
      trainerWin * 0.8 +
      pairPodium * 0.7 +
      distancePodium * 0.8 +
      programRate * 1.0 +
      dataQuality * 0.4

    return {
      ...participant,
      historical_starts: horseMetric?.starts ?? 0,
      jockey_starts: jockeyMetric?.starts ?? 0,
      trainer_starts: trainerMetric?.starts ?? 0,
      horse_win_rate: horseWin,
      horse_podium_rate: horsePodium,
      raw_score: rawScore,
      data_quality: dataQuality,
    }
  })

  const probabilities = softmax(scored.map(item => item.raw_score))
  const rows = scored.map((item, index) => {
    const winProbability = probabilities[index]
    const podiumProbability = Math.min(0.92, winProbability * 2.2 + item.horse_podium_rate * 0.28 + item.data_quality * 0.08)
    const risk = item.data_quality < 0.25
      ? 'alto'
      : item.data_quality < 0.55
        ? 'medio'
        : 'controlado'

    return {
      ...item,
      win_probability: winProbability,
      podium_probability: podiumProbability,
      risk,
      technical_comment: [
        `hist=${item.historical_starts}`,
        `jockey=${item.jockey_starts}`,
        `trainer=${item.trainer_starts}`,
        `calidad=${Math.round(item.data_quality * 100)}%`,
      ].join(' | '),
    }
  })

  return {
    ...program,
    predictions: rows.sort((a, b) => b.win_probability - a.win_probability),
  }
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`
}

function renderReport({ options, historical, target, predictions, audit }) {
  const allPredictions = predictions.flatMap(program => program.predictions.map(row => ({
    ...row,
    title: program.title,
  })))
  const topWin = [...allPredictions].sort((a, b) => b.win_probability - a.win_probability).slice(0, 5)
  const topPodium = [...allPredictions].sort((a, b) => b.podium_probability - a.podium_probability).slice(0, 5)

  const lines = [
    '# Informe HH - Proyeccion hipica',
    '',
    `Generado: ${new Date().toISOString()}`,
    `Historico solicitado: ${options.from} a ${options.to}`,
    `Semana objetivo: ${options.targetFrom} a ${options.targetTo}`,
    '',
    '## Estado de fuentes',
    ...audit.sources.map(source => `- ${source.name}: ${source.status}. ${source.note}`),
    '',
    '## Cobertura recolectada',
    `- Reuniones historicas Sporting: ${historical.meetings.length}`,
    `- Carreras historicas Sporting: ${historical.races.length}`,
    `- Registros de participantes historicos: ${historical.races.reduce((acc, race) => acc + race.participants.length, 0)}`,
    `- Programas objetivo Sporting: ${target.programs.length}`,
    `- Errores de captura: ${historical.errors.length + target.errors.length}`,
    '',
    '## Limitaciones',
    '- Este reporte no inventa carreras ni participantes no encontrados en fuente oficial.',
    '- Club Hipico e Hipodromo Chile estan registrados, pero sus adapters aun no estan implementados en este script.',
    '- Las probabilidades son un baseline de ranking calibrable; no representan certeza de apuesta.',
    '- Para exigir alta confianza se requiere backtest por recinto y comparacion contra cuotas historicas.',
    '',
    '## Top 5 probabilidad de ganar',
    topWin.length
      ? topWin.map((row, idx) => `${idx + 1}. ${row.horse} - ${row.hippodrome} C${row.race_number}: P(gana) ${pct(row.win_probability)}, P(podio) ${pct(row.podium_probability)}, riesgo ${row.risk}`).join('\n')
      : 'Sin programas objetivo disponibles en las fuentes implementadas.',
    '',
    '## Top 5 probabilidad de podio',
    topPodium.length
      ? topPodium.map((row, idx) => `${idx + 1}. ${row.horse} - ${row.hippodrome} C${row.race_number}: P(podio) ${pct(row.podium_probability)}, P(gana) ${pct(row.win_probability)}, riesgo ${row.risk}`).join('\n')
      : 'Sin programas objetivo disponibles en las fuentes implementadas.',
    '',
    '## Tabla por carrera',
  ]

  if (!predictions.length) {
    lines.push('', 'No hay carreras objetivo parseadas para proyectar.')
  }

  for (const program of predictions) {
    lines.push('', `### ${program.date} - ${program.hippodrome} - Carrera ${program.race_number}`)
    lines.push('')
    lines.push('| Caballo | Jockey | Entrenador | P(gana) | P(podio) | Riesgo | Comentario tecnico |')
    lines.push('|---|---|---|---:|---:|---|---|')
    for (const row of program.predictions) {
      lines.push(`| ${row.horse} | ${row.jockey ?? ''} | ${row.trainer ?? ''} | ${pct(row.win_probability)} | ${pct(row.podium_probability)} | ${row.risk} | ${row.technical_comment} |`)
    }
  }

  if (historical.errors.length || target.errors.length) {
    lines.push('', '## Errores / faltantes')
    for (const error of [...historical.errors, ...target.errors].slice(0, 30)) {
      lines.push(`- ${error.date} ${error.url}: ${error.error}`)
    }
  }

  return lines.join('\n')
}

async function main() {
  const options = parseArgs()
  const started = Date.now()
  console.log('[HH] Iniciando pipeline', options)

  const historical = await collectSportingResults(options)
  console.log(`[HH] Historico Sporting: ${historical.meetings.length} reuniones, ${historical.races.length} carreras`)

  const target = await collectSportingPrograms(options)
  console.log(`[HH] Programas objetivo Sporting: ${target.programs.length}`)

  const metrics = buildMetrics(historical.races)
  const predictions = target.programs.map(program => scoreProgram(program, metrics))

  const payload = {
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    options,
    audit: { sources: SUPPORTED_SOURCES },
    historical,
    target,
    predictions,
  }

  await mkdir(options.outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonPath = path.join(options.outDir, `hh_projection_${stamp}.json`)
  const reportPath = path.join(options.outDir, `hh_projection_${stamp}.md`)
  await writeFile(jsonPath, JSON.stringify(payload, null, 2))
  await writeFile(reportPath, renderReport(payload))

  console.log(`[HH] JSON: ${jsonPath}`)
  console.log(`[HH] Reporte: ${reportPath}`)

  const persisted = await persistHistoricalRun(payload, { jsonPath, reportPath })
  if (persisted.skipped) {
    console.log(`[HH] Supabase: omitido (${persisted.reason})`)
  } else {
    console.log(`[HH] Supabase: ${persisted.meetings} reuniones, ${persisted.races} carreras, ${persisted.results} resultados`)
  }
}

main().catch(error => {
  console.error('[HH] Pipeline fallido:', error)
  process.exitCode = 1
})
