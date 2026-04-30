import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const DEFAULT_SOURCE = '/Volumes/matheus/Base de datos/PUB_EMPRESAS_PJ_2020_A_2024.txt'
const DEFAULT_OUTPUT = path.resolve(
  process.cwd(),
  'exports/empresas/empresas_tendencia_ventas_2020_2024.csv'
)
const DEFAULT_SUMMARY = path.resolve(
  process.cwd(),
  'exports/empresas/empresas_tendencia_ventas_2020_2024.summary.json'
)

const sourcePath = process.argv[2] || DEFAULT_SOURCE
const outputPath = process.argv[3] || DEFAULT_OUTPUT
const summaryPath = process.argv[4] || DEFAULT_SUMMARY

const YEARS = [2020, 2021, 2022, 2023, 2024]

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function requiredIndex(headers, label) {
  const normalizedLabel = normalizeHeader(label)
  const index = headers.findIndex(header => normalizeHeader(header) === normalizedLabel)
  if (index === -1) {
    throw new Error(`No se encontro la columna requerida: ${label}`)
  }
  return index
}

function optionalIndex(headers, label) {
  const normalizedLabel = normalizeHeader(label)
  return headers.findIndex(header => normalizeHeader(header) === normalizedLabel)
}

function valueAt(row, index) {
  return index >= 0 ? String(row[index] || '').trim() : ''
}

function parseInteger(value) {
  const cleaned = String(value || '').trim()
  if (!cleaned) return null
  const parsed = Number.parseInt(cleaned, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function average(values) {
  const valid = values.filter(value => typeof value === 'number' && Number.isFinite(value))
  if (!valid.length) return null
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

function linearSlope(points) {
  if (points.length < 2) return null
  const meanX = average(points.map(point => point.year))
  const meanY = average(points.map(point => point.value))
  const numerator = points.reduce(
    (sum, point) => sum + (point.year - meanX) * (point.value - meanY),
    0
  )
  const denominator = points.reduce((sum, point) => sum + (point.year - meanX) ** 2, 0)
  return denominator === 0 ? null : numerator / denominator
}

function buildTrend(record) {
  const points = YEARS
    .map(year => ({ year, value: record.tramos[year] }))
    .filter(point => typeof point.value === 'number' && Number.isFinite(point.value))

  const tramoValues = points.map(point => point.value)
  const tramoPromedio = average(tramoValues)

  const transitions = []
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]
    const current = points[i]
    transitions.push({
      from: prev.year,
      to: current.year,
      delta: current.value - prev.value,
      annualDelta: (current.value - prev.value) / (current.year - prev.year),
    })
  }

  const avgDelta = average(transitions.map(item => item.annualDelta))
  const slope = linearSlope(points)
  const positiveMoves = transitions.filter(item => item.delta > 0).length
  const negativeMoves = transitions.filter(item => item.delta < 0).length

  let resultado = 'sin_datos'
  if (points.length >= 2) {
    if (slope > 0) resultado = 'sube'
    else if (slope < 0) resultado = 'baja'
    else resultado = 'estable'
  }

  return {
    validYears: points.length,
    firstYear: points[0]?.year || null,
    lastYear: points.at(-1)?.year || null,
    firstTramo: points[0]?.value ?? null,
    lastTramo: points.at(-1)?.value ?? null,
    tramoPromedio,
    avgDelta,
    slope,
    positiveMoves,
    negativeMoves,
    resultado,
  }
}

async function main() {
  await fs.promises.access(sourcePath, fs.constants.R_OK)
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })

  const records = new Map()
  const input = fs.createReadStream(sourcePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input, crlfDelay: Infinity })

  let lineNumber = 0
  let idx = null
  let rowsRead = 0
  let rowsWithValidTramo = 0
  let duplicateRutYearRows = 0

  for await (const line of rl) {
    lineNumber += 1

    if (lineNumber === 1) {
      const headers = line.split('\t')
      idx = {
        year: requiredIndex(headers, 'Año comercial'),
        rut: requiredIndex(headers, 'RUT'),
        dv: requiredIndex(headers, 'DV'),
        razonSocial: requiredIndex(headers, 'Razón social'),
        tramoVentas: requiredIndex(headers, 'Tramo según ventas'),
        trabajadores: requiredIndex(headers, 'Número de trabajadores dependie'),
        tipoContribuyente: requiredIndex(headers, 'Tipo de contribuyente'),
        subtipoContribuyente: requiredIndex(headers, 'Subtipo de contribuyente'),
        rubro: requiredIndex(headers, 'Rubro económico'),
        subrubro: requiredIndex(headers, 'Subrubro económico'),
        actividad: requiredIndex(headers, 'Actividad económica'),
        region: requiredIndex(headers, 'Región'),
        provincia: requiredIndex(headers, 'Provincia'),
        comuna: requiredIndex(headers, 'Comuna'),
        terminoGiro: optionalIndex(headers, 'Fecha término de giro'),
      }
      continue
    }

    if (!line.trim()) continue
    rowsRead += 1

    const row = line.split('\t')
    const year = parseInteger(valueAt(row, idx.year))
    if (!YEARS.includes(year)) continue

    const rut = valueAt(row, idx.rut)
    if (!rut) continue

    const tramoVentas = parseInteger(valueAt(row, idx.tramoVentas))
    if (tramoVentas !== null) rowsWithValidTramo += 1

    let record = records.get(rut)
    if (!record) {
      record = {
        rut,
        dv: '',
        latestYear: 0,
        latest: {},
        tramos: {},
        trabajadores: {},
      }
      records.set(rut, record)
    }

    if (Object.hasOwn(record.tramos, year)) duplicateRutYearRows += 1

    record.dv = valueAt(row, idx.dv) || record.dv
    record.tramos[year] = tramoVentas
    record.trabajadores[year] = parseInteger(valueAt(row, idx.trabajadores))

    if (year >= record.latestYear) {
      record.latestYear = year
      record.latest = {
        razonSocial: valueAt(row, idx.razonSocial),
        tipoContribuyente: valueAt(row, idx.tipoContribuyente),
        subtipoContribuyente: valueAt(row, idx.subtipoContribuyente),
        rubro: valueAt(row, idx.rubro),
        subrubro: valueAt(row, idx.subrubro),
        actividad: valueAt(row, idx.actividad),
        region: valueAt(row, idx.region),
        provincia: valueAt(row, idx.provincia),
        comuna: valueAt(row, idx.comuna),
        terminoGiro: valueAt(row, idx.terminoGiro),
      }
    }
  }

  const output = fs.createWriteStream(outputPath, { encoding: 'utf8' })
  const headers = [
    'rut',
    'dv',
    'razon_social_ultima',
    'anio_ultimo',
    'tipo_contribuyente_ultimo',
    'subtipo_contribuyente_ultimo',
    'rubro_economico_ultimo',
    'subrubro_economico_ultimo',
    'actividad_economica_ultima',
    'region_ultima',
    'provincia_ultima',
    'comuna_ultima',
    'fecha_termino_giro_ultima',
    ...YEARS.map(year => `tramo_ventas_${year}`),
    ...YEARS.map(year => `trabajadores_${year}`),
    'anios_con_tramo',
    'primer_anio_con_tramo',
    'ultimo_anio_con_tramo',
    'primer_tramo_ventas',
    'ultimo_tramo_ventas',
    'tramo_ventas_promedio_2020_2024',
    'cambio_promedio_anual_tramo',
    'pendiente_tendencia_tramo',
    'movimientos_alza',
    'movimientos_baja',
    'resultado_tendencia',
  ]
  output.write(`${headers.join(',')}\n`)

  const summary = {
    sourcePath,
    outputPath,
    summaryPath,
    years: YEARS,
    rowsRead,
    rowsWithValidTramo,
    uniqueRuts: records.size,
    duplicateRutYearRows,
    resultados: {},
  }

  for (const record of records.values()) {
    const trend = buildTrend(record)
    summary.resultados[trend.resultado] = (summary.resultados[trend.resultado] || 0) + 1

    const row = [
      record.rut,
      record.dv,
      record.latest.razonSocial,
      record.latestYear || '',
      record.latest.tipoContribuyente,
      record.latest.subtipoContribuyente,
      record.latest.rubro,
      record.latest.subrubro,
      record.latest.actividad,
      record.latest.region,
      record.latest.provincia,
      record.latest.comuna,
      record.latest.terminoGiro,
      ...YEARS.map(year => record.tramos[year] ?? ''),
      ...YEARS.map(year => record.trabajadores[year] ?? ''),
      trend.validYears,
      trend.firstYear,
      trend.lastYear,
      trend.firstTramo,
      trend.lastTramo,
      trend.tramoPromedio === null ? '' : trend.tramoPromedio.toFixed(2),
      trend.avgDelta === null ? '' : trend.avgDelta.toFixed(4),
      trend.slope === null ? '' : trend.slope.toFixed(4),
      trend.positiveMoves,
      trend.negativeMoves,
      trend.resultado,
    ]

    output.write(`${row.map(csvEscape).join(',')}\n`)
  }

  await new Promise((resolve, reject) => {
    output.end(resolve)
    output.on('error', reject)
  })

  await fs.promises.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

  console.log(JSON.stringify(summary, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
