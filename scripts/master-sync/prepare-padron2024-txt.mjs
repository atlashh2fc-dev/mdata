#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Papa from 'papaparse'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEFAULT_INPUT = '/Users/hh/Downloads/padron2024_final.TXT'
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '../../tmp/master-sync/padron2024')
const SOURCE_DATASET = 'padron2024_final'

const OUTPUTS = {
  master: {
    file: 'master_personas.csv',
    headers: ['rutid'],
  },
  pernat: {
    file: 'pernat_resumen.csv',
    headers: ['rutid', 'nombres', 'paterno', 'materno', 'comuna_part', 'region_part'],
  },
  domicilio: {
    file: 'domicilio_resumen.csv',
    headers: ['rutid', 'comuna', 'region'],
  },
  raw: {
    file: 'padron_personas_raw.csv',
    headers: [
      'rutid',
      'dv',
      'nombre',
      'sexo',
      'direccion',
      'circunscripcion',
      'comuna',
      'region',
      'source_file',
      'source_dataset',
    ],
  },
  invalid: {
    file: 'padron_invalid_rows.csv',
    headers: ['rut', 'dv', 'nombre', 'sexo', 'direccion', 'circunscripcion', 'comuna', 'region', 'reason'],
  },
}

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    outDir: DEFAULT_OUTPUT_DIR,
    limitRows: 0,
    encoding: 'latin1',
  }

  for (const rawArg of argv) {
    if (rawArg.startsWith('--input=')) {
      args.input = path.resolve(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--out-dir=')) {
      args.outDir = path.resolve(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--limit-rows=')) {
      args.limitRows = Number(rawArg.split('=')[1])
    } else if (rawArg.startsWith('--encoding=')) {
      args.encoding = rawArg.split('=')[1]
    }
  }

  if (!Number.isFinite(args.limitRows) || args.limitRows < 0) {
    throw new Error(`limit-rows invalido: ${args.limitRows}`)
  }

  return args
}

function collapseWhitespace(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/\uFEFF/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanLeadingNoise(value) {
  return collapseWhitespace(value)
    .replace(/^[\s.\-_,;:/'"`]+/g, '')
    .trim()
}

function cleanRawHeader(value) {
  return collapseWhitespace(value).toLowerCase()
}

function csvEscape(value) {
  const str = String(value ?? '')
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function calcDv(digits) {
  const str = String(digits).replace(/\D/g, '')
  let sum = 0
  let mult = 2

  for (let i = str.length - 1; i >= 0; i -= 1) {
    sum += Number(str[i]) * mult
    mult = mult === 7 ? 2 : mult + 1
  }

  const remainder = 11 - (sum % 11)
  if (remainder === 11) return '0'
  if (remainder === 10) return 'K'
  return String(remainder)
}

function normalizeRut(rutValue, dvValue) {
  const digits = String(rutValue ?? '').replace(/\D/g, '')
  const dv = collapseWhitespace(dvValue).replace(/[^0-9kK]/g, '').toUpperCase()

  if (!digits) {
    return { rutid: null, dv: null, reason: 'rut_vacio' }
  }

  if (!dv) {
    return { rutid: null, dv: null, reason: 'dv_vacio' }
  }

  const expectedDv = calcDv(digits)
  if (expectedDv !== dv) {
    return { rutid: null, dv, reason: `dv_invalido:${expectedDv}` }
  }

  return {
    rutid: `${digits}${dv}`.padStart(10, '0'),
    dv,
    reason: null,
  }
}

function splitFullName(fullName) {
  const normalized = cleanLeadingNoise(fullName)
  if (!normalized) {
    return {
      nombre: '',
      nombres: '',
      paterno: '',
      materno: '',
    }
  }

  const tokens = normalized.split(' ').filter(Boolean)
  if (tokens.length === 1) {
    return { nombre: normalized, nombres: tokens[0], paterno: '', materno: '' }
  }

  if (tokens.length === 2) {
    return {
      nombre: normalized,
      nombres: tokens[0],
      paterno: tokens[1],
      materno: '',
    }
  }

  return {
    nombre: normalized,
    nombres: tokens.slice(0, -2).join(' '),
    paterno: tokens[tokens.length - 2],
    materno: tokens[tokens.length - 1],
  }
}

function buildCsvLine(columns, row) {
  return `${columns.map(column => csvEscape(row[column] ?? '')).join(',')}\n`
}

function openWriter(filePath, headers) {
  const writer = fs.createWriteStream(filePath, { encoding: 'utf8' })
  writer.write(`${headers.join(',')}\n`)
  return writer
}

async function closeWriter(writer) {
  writer.end()
  await new Promise(resolve => writer.once('finish', resolve))
}

async function writeLine(writer, line) {
  if (!writer.write(line)) {
    await new Promise(resolve => writer.once('drain', resolve))
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!fs.existsSync(args.input)) {
    throw new Error(`TXT no encontrado: ${args.input}`)
  }

  fs.mkdirSync(args.outDir, { recursive: true })

  const sourceFile = path.basename(args.input)
  const masterWriter = openWriter(path.join(args.outDir, OUTPUTS.master.file), OUTPUTS.master.headers)
  const pernatWriter = openWriter(path.join(args.outDir, OUTPUTS.pernat.file), OUTPUTS.pernat.headers)
  const domicilioWriter = openWriter(path.join(args.outDir, OUTPUTS.domicilio.file), OUTPUTS.domicilio.headers)
  const rawWriter = openWriter(path.join(args.outDir, OUTPUTS.raw.file), OUTPUTS.raw.headers)
  const invalidWriter = openWriter(path.join(args.outDir, OUTPUTS.invalid.file), OUTPUTS.invalid.headers)

  const parser = fs.createReadStream(args.input, { encoding: args.encoding }).pipe(Papa.parse(Papa.NODE_STREAM_INPUT, {
    header: false,
    delimiter: ';',
    quoteChar: '"',
    escapeChar: '"',
    skipEmptyLines: 'greedy',
  }))

  const stats = {
    source_file: args.input,
    output_dir: args.outDir,
    source_dataset: SOURCE_DATASET,
    processed_rows: 0,
    valid_rows: 0,
    invalid_rows: 0,
    started_at: new Date().toISOString(),
    finished_at: null,
  }

  try {
    let headers = null

    for await (const parsedRow of parser) {
      if (!headers) {
        headers = parsedRow.map(cleanRawHeader)
        continue
      }

      stats.processed_rows += 1
      const rawRow = Object.fromEntries(headers.map((header, index) => [header, parsedRow[index] ?? '']))

      const rutInfo = normalizeRut(rawRow.rut, rawRow.dv)
      const names = splitFullName(rawRow.nombre)
      const normalizedRow = {
        rut: collapseWhitespace(rawRow.rut),
        dv: rutInfo.dv ?? collapseWhitespace(rawRow.dv).toUpperCase(),
        nombre: names.nombre,
        sexo: collapseWhitespace(rawRow.sexo).toUpperCase(),
        direccion: collapseWhitespace(rawRow.direccion),
        circunscripcion: collapseWhitespace(rawRow.circunscripcion),
        comuna: collapseWhitespace(rawRow.comuna).toUpperCase(),
        region: collapseWhitespace(rawRow.region).toUpperCase(),
      }

      if (!rutInfo.rutid) {
        stats.invalid_rows += 1
        await writeLine(invalidWriter, buildCsvLine(OUTPUTS.invalid.headers, {
          ...normalizedRow,
          reason: rutInfo.reason ?? 'rut_invalido',
        }))
      } else {
        stats.valid_rows += 1

        await writeLine(masterWriter, buildCsvLine(OUTPUTS.master.headers, {
          rutid: rutInfo.rutid,
        }))

        await writeLine(pernatWriter, buildCsvLine(OUTPUTS.pernat.headers, {
          rutid: rutInfo.rutid,
          nombres: names.nombres,
          paterno: names.paterno,
          materno: names.materno,
          comuna_part: normalizedRow.comuna,
          region_part: normalizedRow.region,
        }))

        await writeLine(domicilioWriter, buildCsvLine(OUTPUTS.domicilio.headers, {
          rutid: rutInfo.rutid,
          comuna: normalizedRow.comuna,
          region: normalizedRow.region,
        }))

        await writeLine(rawWriter, buildCsvLine(OUTPUTS.raw.headers, {
          rutid: rutInfo.rutid,
          dv: normalizedRow.dv,
          nombre: normalizedRow.nombre,
          sexo: normalizedRow.sexo,
          direccion: normalizedRow.direccion,
          circunscripcion: normalizedRow.circunscripcion,
          comuna: normalizedRow.comuna,
          region: normalizedRow.region,
          source_file: sourceFile,
          source_dataset: SOURCE_DATASET,
        }))
      }

      if (stats.processed_rows % 100000 === 0) {
        console.log(
          `[padron2024:prepare] processed=${stats.processed_rows} valid=${stats.valid_rows} invalid=${stats.invalid_rows}`
        )
      }

      if (args.limitRows > 0 && stats.processed_rows >= args.limitRows) {
        break
      }
    }
  } finally {
    stats.finished_at = new Date().toISOString()
    await closeWriter(masterWriter)
    await closeWriter(pernatWriter)
    await closeWriter(domicilioWriter)
    await closeWriter(rawWriter)
    await closeWriter(invalidWriter)
  }

  fs.writeFileSync(
    path.join(args.outDir, 'prepare-stats.json'),
    JSON.stringify(stats, null, 2)
  )

  console.log(
    `[padron2024:prepare] listo. processed=${stats.processed_rows} valid=${stats.valid_rows} invalid=${stats.invalid_rows}`
  )
}

main().catch(error => {
  console.error(`\nFallo en prepare-padron2024-txt: ${error.message}`)
  process.exitCode = 1
})
