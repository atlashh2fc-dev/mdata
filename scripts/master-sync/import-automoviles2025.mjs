import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import mysql from 'mysql2'
import pg from 'pg'
import { from as copyFrom } from 'pg-copy-streams'

const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER ?? 'root',
  password: process.env.MYSQL_PASSWORD ?? '',
  database: process.env.MYSQL_DATABASE ?? 'master_test',
}

const PG_CONNECTION_STRING = process.env.POSTGRES_URL_NON_POOLING
  ?? process.env.POSTGRES_URL
  ?? process.env.DATABASE_URL
  ?? process.env.SUPABASE_DB_URL

function getPostgresConnectionString() {
  if (!PG_CONNECTION_STRING) return null
  const url = new URL(PG_CONNECTION_STRING)
  url.searchParams.set('sslmode', 'require')
  url.searchParams.set('uselibpqcompat', 'true')
  return url.toString()
}

const COPY_COLUMNS = [
  'ppu',
  'ppu_dv',
  'marca',
  'modelo',
  'tipo_vehiculo',
  'anio_fabricacion',
  'fecha_transferencia',
  'color',
  'resto_color',
  'codigo_chassis',
  'codigo_motor',
  'clasificacion',
  'avaluo_fiscal',
  'avaluo_comercial',
  'rutid',
  'nombre_razon_social',
  'paterno',
  'materno',
  'nombres',
  'tipo_rut',
]

function normalizeText(value) {
  const text = String(value ?? '').replace(/\r/g, '').trim()
  return text.length > 0 ? text : null
}

function normalizeRutid(value) {
  const rutid = normalizeText(value)?.replace(/[^0-9Kk]/g, '').toUpperCase() ?? null
  if (!rutid || rutid === 'RUTID') return null
  return rutid.length === 10 ? rutid : null
}

function validateRutid(rutid) {
  if (!rutid || !/^[0-9]{9}[0-9K]$/.test(rutid)) return false
  if (rutid >= '0000000000' && rutid < '0001000000') return false
  if (/^([0-9])\1{9}$/.test(rutid)) return false

  const body = rutid.slice(0, -1).replace(/^0+/, '') || '0'
  const dv = rutid.slice(-1)
  let sum = 0
  let multiplier = 2

  for (let i = body.length - 1; i >= 0; i -= 1) {
    sum += Number(body[i]) * multiplier
    multiplier = multiplier === 7 ? 2 : multiplier + 1
  }

  const rest = 11 - (sum % 11)
  const expected = rest === 11 ? '0' : rest === 10 ? 'K' : String(rest)
  return dv === expected
}

function parseInteger(value) {
  const text = normalizeText(value)
  if (!text || !/^\d+$/.test(text)) return null
  return Number(text)
}

function parseMoney(value) {
  const text = normalizeText(value)?.replace(/[^\d.-]/g, '') ?? null
  if (!text) return null
  const number = Number(text)
  return Number.isFinite(number) ? number : null
}

function parseDate(value) {
  const text = normalizeText(value)
  if (!text || !/^\d{8}$/.test(text)) return null
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
}

function csvCell(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function rowToCsv(row) {
  return COPY_COLUMNS.map((column) => csvCell(row[column])).join(',') + '\n'
}

function mapRow(row) {
  const rutid = normalizeRutid(row.RUTID)
  if (!validateRutid(rutid)) return null

  const ppu = normalizeText(row.PPU)
  if (!ppu || ppu === 'PPU') return null

  return {
    ppu,
    ppu_dv: normalizeText(row.PPU_DV),
    marca: normalizeText(row.MARCA),
    modelo: normalizeText(row.MODELO),
    tipo_vehiculo: normalizeText(row.TIPO_VEHICULO),
    anio_fabricacion: parseInteger(row.ANIO_FABRICACION),
    fecha_transferencia: parseDate(row.FECHA_TRANSFERENCIA),
    color: normalizeText(row.COLOR),
    resto_color: normalizeText(row.RESTO_COLOR),
    codigo_chassis: normalizeText(row.CODIGO_CHASSIS),
    codigo_motor: normalizeText(row.CODIGO_MOTOR),
    clasificacion: normalizeText(row.CLASIFICACION),
    avaluo_fiscal: parseMoney(row.AVALUO_FISCAL),
    avaluo_comercial: parseMoney(row.AVALUO_COMERCIAL),
    rutid,
    nombre_razon_social: normalizeText(row.NOMBRE_RAZON_SOCIAL),
    paterno: normalizeText(row.PATERNO),
    materno: normalizeText(row.MATERNO),
    nombres: normalizeText(row.NOMBRES),
    tipo_rut: normalizeText(row.TIPO_RUT),
  }
}

async function main() {
  const pgConnectionString = getPostgresConnectionString()
  if (!pgConnectionString) throw new Error('Falta POSTGRES_URL_NON_POOLING, POSTGRES_URL o DATABASE_URL.')

  const pgPool = new pg.Pool({
    connectionString: pgConnectionString,
    max: 1,
  })
  const pgClient = await pgPool.connect()
  const mysqlConnection = mysql.createConnection(MYSQL_CONFIG)

  let accepted = 0
  let skipped = 0

  try {
    await pgClient.query('set statement_timeout = 0')
    await pgClient.query('truncate table public.automoviles2025 restart identity')

    const mysqlStream = mysqlConnection
      .query('select * from automoviles2025')
      .stream({ highWaterMark: 10000 })

    const transform = new Transform({
      objectMode: true,
      transform(row, _encoding, callback) {
        const mapped = mapRow(row)
        if (!mapped) {
          skipped += 1
          callback()
          return
        }
        accepted += 1
        if (accepted % 250000 === 0) {
          console.log(`cargados=${accepted.toLocaleString()} omitidos=${skipped.toLocaleString()}`)
        }
        callback(null, rowToCsv(mapped))
      },
    })

    const copySql = `COPY public.automoviles2025 (${COPY_COLUMNS.join(', ')}) FROM STDIN WITH (FORMAT csv)`
    await pipeline(mysqlStream, transform, pgClient.query(copyFrom(copySql)))

    await pgClient.query('analyze public.automoviles2025')
    await pgClient.query(`
      update public.data_sources
      set record_count = (select count(*) from public.automoviles2025),
          last_loaded_at = now(),
          last_job_status = 'completed'
      where slug = 'automoviles2025'
    `)

    console.log(`OK automoviles2025 cargados=${accepted.toLocaleString()} omitidos=${skipped.toLocaleString()}`)
  } finally {
    mysqlConnection.end()
    pgClient.release()
    await pgPool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
