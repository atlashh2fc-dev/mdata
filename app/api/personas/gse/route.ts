import { NextRequest, NextResponse } from 'next/server'
import { Client } from 'pg'
import { createSupabaseServerClient } from '@/lib/db/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

type GseGroup = 'ALL' | 'AB' | 'C1A' | 'C1B' | 'C2' | 'C3' | 'DE'

type GseCohortRow = {
  ranking: string
  region: string
  comuna: string
  grupo_socioeconomico_proxy: string
  tramo_score_patrimonial: string
  cantidad_personas: number
  indice_oportunidad_zona: string
  total_autos: number
  promedio_autos: string
  personas_con_autos: number
  total_bienes_raices: number
  promedio_bienes_raices: string
  personas_con_bienes_raices: number
  avaluo_total_clp: string
  avaluo_promedio_clp: string
  score_patrimonial_promedio: string
  cobertura_promedio_pct: string
  privacidad: string
}

const CSV_HEADERS: Array<keyof GseCohortRow> = [
  'ranking',
  'region',
  'comuna',
  'grupo_socioeconomico_proxy',
  'tramo_score_patrimonial',
  'cantidad_personas',
  'indice_oportunidad_zona',
  'total_autos',
  'promedio_autos',
  'personas_con_autos',
  'total_bienes_raices',
  'promedio_bienes_raices',
  'personas_con_bienes_raices',
  'avaluo_total_clp',
  'avaluo_promedio_clp',
  'score_patrimonial_promedio',
  'cobertura_promedio_pct',
  'privacidad',
]

const GROUP_LABELS: Record<GseGroup, string> = {
  ALL: 'Todos',
  AB: 'AB',
  C1A: 'C1a',
  C1B: 'C1b',
  C2: 'C2',
  C3: 'C3',
  DE: 'D/E',
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

function getPgConnectionString() {
  const raw = process.env.POSTGRES_URL
  if (!raw) return null
  const url = new URL(raw)
  url.searchParams.delete('sslmode')
  return url.toString()
}

function getGroupParam(value: string | null): GseGroup {
  const normalized = (value ?? 'ALL').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (normalized === 'C1A') return 'C1A'
  if (normalized === 'C1B') return 'C1B'
  if (normalized === 'DE' || normalized === 'D' || normalized === 'E') return 'DE'
  if (['ALL', 'AB', 'C2', 'C3'].includes(normalized)) return normalized as GseGroup
  return 'ALL'
}

function getPositiveInt(value: string | null, fallback: number, max: number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), max)
}

async function queryCohorts({
  group,
  geolocatedOnly,
  minCount,
  limit,
}: {
  group: GseGroup
  geolocatedOnly: boolean
  minCount: number
  limit: number
}) {
  const connectionString = getPgConnectionString()
  if (!connectionString) {
    throw new Error('Falta POSTGRES_URL para generar el subconjunto.')
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  })

  const groupLabel = GROUP_LABELS[group]
  const groupFilter = group === 'ALL' ? null : groupLabel
  const missingRegion = geolocatedOnly ? null : 'SIN_REGION'
  const missingComuna = geolocatedOnly ? null : 'SIN_COMUNA'

  await client.connect()
  try {
    await client.query(`set statement_timeout = '240s'`)
    const { rows } = await client.query<GseCohortRow>(
      `
      with naturales as (
        select
          coalesce(
            nullif(region_canonica, ''),
            nullif(region_part, ''),
            nullif(domicilio_region, ''),
            $4::text
          ) as region,
          coalesce(
            nullif(comuna_canonica, ''),
            nullif(comuna_part, ''),
            nullif(domicilio_comuna, ''),
            $5::text
          ) as comuna,
          coalesce(n_autos, 0) as n_autos,
          coalesce(n_bienes_raices, 0) as n_bienes_raices,
          coalesce(totalavaluos, 0)::numeric as totalavaluos,
          coalesce(score_patrimonial, 0) as score_patrimonial,
          coalesce(cobertura_pct, 0) as cobertura_pct,
          case
            when coalesce(totalavaluos, 0) >= 500000000
              or coalesce(n_bienes_raices, 0) >= 3
              or coalesce(n_autos, 0) >= 4
              or coalesce(score_patrimonial, 0) >= 120 then 'AB'
            when coalesce(totalavaluos, 0) >= 180000000
              or coalesce(n_bienes_raices, 0) >= 2
              or coalesce(n_autos, 0) >= 2
              or coalesce(score_patrimonial, 0) >= 70 then 'C1a'
            when coalesce(totalavaluos, 0) >= 80000000
              or coalesce(n_bienes_raices, 0) >= 1
              or coalesce(n_autos, 0) >= 1
              or coalesce(score_patrimonial, 0) >= 40 then 'C1b'
            when coalesce(totalavaluos, 0) >= 30000000
              or coalesce(score_patrimonial, 0) >= 20 then 'C2'
            when coalesce(score_patrimonial, 0) >= 10 then 'C3'
            else 'D/E'
          end as grupo_socioeconomico_proxy,
          case
            when coalesce(score_patrimonial, 0) >= 150 then 'score_150_mas'
            when coalesce(score_patrimonial, 0) >= 100 then 'score_100_149'
            when coalesce(score_patrimonial, 0) >= 70 then 'score_70_99'
            when coalesce(score_patrimonial, 0) >= 40 then 'score_40_69'
            when coalesce(score_patrimonial, 0) >= 20 then 'score_20_39'
            when coalesce(score_patrimonial, 0) >= 10 then 'score_10_19'
            else 'score_0_9'
          end as tramo_score_patrimonial
        from public.master_personas_view
        where nullif(btrim(coalesce(razon_social_empresa, '')), '') is null
          and (
            $3::boolean = false
            or (
              coalesce(nullif(region_canonica, ''), nullif(region_part, ''), nullif(domicilio_region, '')) is not null
              and coalesce(nullif(comuna_canonica, ''), nullif(comuna_part, ''), nullif(domicilio_comuna, '')) is not null
            )
          )
      ),
      cohortes as (
        select
          region,
          comuna,
          grupo_socioeconomico_proxy,
          tramo_score_patrimonial,
          count(*)::int as cantidad_personas,
          sum(n_autos)::int as total_autos,
          round(avg(n_autos)::numeric, 2) as promedio_autos,
          count(*) filter (where n_autos > 0)::int as personas_con_autos,
          sum(n_bienes_raices)::int as total_bienes_raices,
          round(avg(n_bienes_raices)::numeric, 2) as promedio_bienes_raices,
          count(*) filter (where n_bienes_raices > 0)::int as personas_con_bienes_raices,
          round(sum(totalavaluos))::bigint as avaluo_total_clp,
          round(avg(totalavaluos))::bigint as avaluo_promedio_clp,
          round(avg(score_patrimonial)::numeric, 2) as score_patrimonial_promedio,
          round(avg(cobertura_pct)::numeric, 2) as cobertura_promedio_pct,
          (
            least(55, ln(1 + sum(totalavaluos)) / ln(1 + 1000000000000::numeric) * 55)
            + least(25, ln(1 + sum(n_bienes_raices)) / ln(1 + 100000) * 25)
            + least(15, ln(1 + sum(n_autos)) / ln(1 + 100000) * 15)
            + least(5, count(*)::numeric / 10000 * 5)
          )::numeric(10,2) as indice_oportunidad_zona
        from naturales
        where ($1::text is null or grupo_socioeconomico_proxy = $1::text)
        group by 1, 2, 3, 4
        having count(*) >= $2::int
      )
      select
        row_number() over (
          order by indice_oportunidad_zona desc, cantidad_personas desc, avaluo_total_clp desc
        )::text as ranking,
        region,
        comuna,
        grupo_socioeconomico_proxy,
        tramo_score_patrimonial,
        cantidad_personas,
        indice_oportunidad_zona::text,
        total_autos,
        promedio_autos::text,
        personas_con_autos,
        total_bienes_raices,
        promedio_bienes_raices::text,
        personas_con_bienes_raices,
        avaluo_total_clp::text,
        avaluo_promedio_clp::text,
        score_patrimonial_promedio::text,
        cobertura_promedio_pct::text,
        'cohorte_anonima_k_min_' || $2::text || '_sin_rut_nombre_contacto_direccion' as privacidad
      from cohortes
      order by indice_oportunidad_zona desc, cantidad_personas desc, avaluo_total_clp desc
      limit $6::int
      `,
      [groupFilter, minCount, geolocatedOnly, missingRegion, missingComuna, limit]
    )

    return rows
  } finally {
    await client.end()
  }
}

function toCsv(rows: GseCohortRow[]) {
  return [
    CSV_HEADERS.join(','),
    ...rows.map(row => CSV_HEADERS.map(header => csvEscape(row[header])).join(',')),
  ].join('\n') + '\n'
}

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const { searchParams } = req.nextUrl
  const group = getGroupParam(searchParams.get('group'))
  const geolocatedOnly = searchParams.get('geo') !== 'all'
  const minCount = getPositiveInt(searchParams.get('min_count'), 50, 1000)
  const limit = getPositiveInt(searchParams.get('limit'), 1000, 10000)
  const format = searchParams.get('format') === 'json' ? 'json' : 'csv'

  try {
    const rows = await queryCohorts({ group, geolocatedOnly, minCount, limit })

    if (format === 'json') {
      return NextResponse.json({
        success: true,
        data: rows,
        meta: {
          group: GROUP_LABELS[group],
          geolocated_only: geolocatedOnly,
          min_count: minCount,
          limit,
          row_count: rows.length,
        },
      })
    }

    const suffix = group === 'ALL' ? 'todos' : GROUP_LABELS[group].toLowerCase().replace('/', '-')
    const geoSuffix = geolocatedOnly ? 'geolocalizadas' : 'todas'

    return new Response(toCsv(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="personas-gse-${suffix}-${geoSuffix}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    console.error('[personas/gse]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'No se pudo generar el subconjunto.' },
      { status: 500 }
    )
  }
}
