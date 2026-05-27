import { NextRequest, NextResponse } from 'next/server'
import { Client } from 'pg'
import { createSupabaseServerClient } from '@/lib/db/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

type GseGroup = 'ALL' | 'AB' | 'C1A' | 'C1B' | 'C2' | 'C3' | 'DE'

type GsePersonRow = {
  ranking: string
  rut: string
  rutid: string
  nombre_completo: string | null
  nombres: string | null
  paterno: string | null
  materno: string | null
  email: string | null
  email_propiedad: string | null
  fono_cel: string | null
  telefono_propiedad_celular: string | null
  telefono_propiedad_particular: string | null
  telefono_propiedad_comercial: string | null
  direccion: string | null
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
  n_autos: number
  n_bienes_raices: number
  totalavaluos: string
  score_patrimonial: number
  cobertura_pct: number
  score_patrimonial_promedio: string
  cobertura_promedio_pct: string
  tipo_descarga: string
}

const CSV_HEADERS: Array<keyof GsePersonRow> = [
  'ranking',
  'rut',
  'rutid',
  'nombre_completo',
  'nombres',
  'paterno',
  'materno',
  'email',
  'email_propiedad',
  'fono_cel',
  'telefono_propiedad_celular',
  'telefono_propiedad_particular',
  'telefono_propiedad_comercial',
  'direccion',
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
  'n_autos',
  'n_bienes_raices',
  'totalavaluos',
  'score_patrimonial',
  'cobertura_pct',
  'score_patrimonial_promedio',
  'cobertura_promedio_pct',
  'tipo_descarga',
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

function getGroupToken(value: string): GseGroup | null {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (normalized === 'C1A') return 'C1A'
  if (normalized === 'C1B') return 'C1B'
  if (normalized === 'DE' || normalized === 'D' || normalized === 'E') return 'DE'
  if (['ALL', 'AB', 'C2', 'C3'].includes(normalized)) return normalized as GseGroup
  return null
}

function getGroupParams(values: string[]): GseGroup[] {
  const parsed = values
    .flatMap(value => value.split(','))
    .map(getGroupToken)
    .filter((group): group is GseGroup => Boolean(group))

  if (parsed.length === 0 || parsed.includes('ALL')) return ['ALL']

  const order: GseGroup[] = ['AB', 'C1A', 'C1B', 'C2', 'C3', 'DE']
  return order.filter(group => parsed.includes(group))
}

function getPositiveInt(value: string | null, fallback: number, max: number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), max)
}

async function queryPeople({
  groups,
  geolocatedOnly,
  limit,
}: {
  groups: GseGroup[]
  geolocatedOnly: boolean
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

  const groupFilter = groups.includes('ALL') ? null : groups.map(group => GROUP_LABELS[group])
  const missingRegion = geolocatedOnly ? null : 'SIN_REGION'
  const missingComuna = geolocatedOnly ? null : 'SIN_COMUNA'

  await client.connect()
  try {
    await client.query(`set statement_timeout = '240s'`)
    const { rows } = await client.query<GsePersonRow>(
      `
      with base as (
        select
          pm.rutid,
          nullif(trim(pm.nombres), '') as nombres,
          nullif(trim(pm.paterno), '') as paterno,
          nullif(trim(pm.materno), '') as materno,
          nullif(trim(
            coalesce(nullif(trim(pm.nombres), ''), '') || ' ' ||
            coalesce(nullif(trim(pm.paterno), ''), '') || ' ' ||
            coalesce(nullif(trim(pm.materno), ''), '')
          ), '') as nombre_completo,
          nullif(trim(pm.email), '') as email,
          nullif(trim(pm.fono_cel), '') as fono_cel,
          coalesce(
            nullif(trim(pm.region_part), ''),
            nullif(trim(pm.domicilio_region), ''),
            $3::text
          ) as region,
          coalesce(
            nullif(trim(pm.comuna_part), ''),
            nullif(trim(pm.domicilio_comuna), ''),
            $4::text
          ) as comuna,
          pm.n_autos,
          pm.n_bienes_raices,
          pm.totalavaluos,
          (
            coalesce(pm.n_autos, 0) * 10 +
            coalesce(pm.n_bienes_raices, 0) * 20 +
            case when nullif(btrim(coalesce(pm.razon_social_empresa, '')), '') is not null then 15 else 0 end +
            case when nullif(trim(pm.email), '') is not null then 5 else 0 end +
            case when nullif(trim(pm.fono_cel), '') is not null then 5 else 0 end
          )::int as score_patrimonial,
          (
            (
              case when nullif(trim(pm.nombres), '') is not null then 1 else 0 end +
              case when nullif(trim(pm.email), '') is not null then 1 else 0 end +
              case when nullif(trim(pm.fono_cel), '') is not null then 1 else 0 end +
              case when nullif(trim(pm.region_part), '') is not null then 1 else 0 end +
              case when coalesce(pm.n_autos, 0) > 0 then 1 else 0 end +
              case when nullif(btrim(coalesce(pm.razon_social_empresa, '')), '') is not null then 1 else 0 end +
              case when nullif(trim(pm.domicilio_region), '') is not null then 1 else 0 end +
              case when coalesce(pm.n_bienes_raices, 0) > 0 then 1 else 0 end
            )::float / 8.0 * 100
          )::int as cobertura_pct
        from public.personas_master pm
        where nullif(btrim(coalesce(pm.razon_social_empresa, '')), '') is null
          and (
            $2::boolean = false
            or (
              coalesce(nullif(trim(pm.region_part), ''), nullif(trim(pm.domicilio_region), '')) is not null
              and coalesce(nullif(trim(pm.comuna_part), ''), nullif(trim(pm.domicilio_comuna), '')) is not null
            )
          )
      ),
      naturales as (
        select
          rutid,
          nullif(ltrim(regexp_replace(upper(rutid::text), '[^0-9K]', '', 'g'), '0'), '') as rut_key,
          case
            when length(nullif(ltrim(regexp_replace(upper(rutid::text), '[^0-9K]', '', 'g'), '0'), '')) >= 2
              then left(
                nullif(ltrim(regexp_replace(upper(rutid::text), '[^0-9K]', '', 'g'), '0'), ''),
                length(nullif(ltrim(regexp_replace(upper(rutid::text), '[^0-9K]', '', 'g'), '0'), '')) - 1
              ) || '-' || right(nullif(ltrim(regexp_replace(upper(rutid::text), '[^0-9K]', '', 'g'), '0'), ''), 1)
            else rutid::text
          end as rut,
          nombre_completo,
          nombres,
          paterno,
          materno,
          email,
          fono_cel,
          region,
          comuna,
          n_autos,
          n_bienes_raices,
          totalavaluos,
          score_patrimonial,
          cobertura_pct,
          case
            when coalesce(totalavaluos, 0) >= 500000000
              or coalesce(n_bienes_raices, 0) >= 3
              or coalesce(n_autos, 0) >= 4
              or score_patrimonial >= 120 then 'AB'
            when coalesce(totalavaluos, 0) >= 180000000
              or coalesce(n_bienes_raices, 0) >= 2
              or coalesce(n_autos, 0) >= 2
              or score_patrimonial >= 70 then 'C1a'
            when coalesce(totalavaluos, 0) >= 80000000
              or coalesce(n_bienes_raices, 0) >= 1
              or coalesce(n_autos, 0) >= 1
              or score_patrimonial >= 40 then 'C1b'
            when coalesce(totalavaluos, 0) >= 30000000
              or score_patrimonial >= 20 then 'C2'
            when score_patrimonial >= 10 then 'C3'
            else 'D/E'
          end as grupo_socioeconomico_proxy,
          case
            when score_patrimonial >= 150 then 'score_150_mas'
            when score_patrimonial >= 100 then 'score_100_149'
            when score_patrimonial >= 70 then 'score_70_99'
            when score_patrimonial >= 40 then 'score_40_69'
            when score_patrimonial >= 20 then 'score_20_39'
            when score_patrimonial >= 10 then 'score_10_19'
            else 'score_0_9'
          end as tramo_score_patrimonial
        from base
      ),
      seleccion as (
        select
          f.*,
          1::int as cantidad_personas,
          coalesce(f.n_autos, 0)::int as total_autos,
          coalesce(f.n_autos, 0)::numeric(10,2) as promedio_autos,
          case when coalesce(f.n_autos, 0) > 0 then 1 else 0 end::int as personas_con_autos,
          coalesce(f.n_bienes_raices, 0)::int as total_bienes_raices,
          coalesce(f.n_bienes_raices, 0)::numeric(10,2) as promedio_bienes_raices,
          case when coalesce(f.n_bienes_raices, 0) > 0 then 1 else 0 end::int as personas_con_bienes_raices,
          round(coalesce(f.totalavaluos, 0))::bigint as avaluo_total_clp,
          round(coalesce(f.totalavaluos, 0))::bigint as avaluo_promedio_clp,
          f.score_patrimonial::numeric(10,2) as score_patrimonial_promedio,
          f.cobertura_pct::numeric(10,2) as cobertura_promedio_pct,
          (
            least(55, ln(1 + coalesce(f.totalavaluos, 0)) / ln(1 + 1000000000000::numeric) * 55)
            + least(25, ln(1 + coalesce(f.n_bienes_raices, 0)) / ln(1 + 100000) * 25)
            + least(15, ln(1 + coalesce(f.n_autos, 0)) / ln(1 + 100000) * 15)
            + 0.01
          )::numeric(10,2) as indice_oportunidad_zona
        from naturales f
        where ($1::text[] is null or f.grupo_socioeconomico_proxy = any($1::text[]))
        order by
          f.totalavaluos desc,
          score_patrimonial desc,
          f.n_bienes_raices desc,
          f.n_autos desc,
          f.rutid asc
        limit $5::int
      )
      select
        row_number() over (
          order by s.indice_oportunidad_zona desc, s.cantidad_personas desc, s.avaluo_total_clp desc, s.score_patrimonial desc, s.totalavaluos desc, s.rutid asc
        )::text as ranking,
        s.rut,
        s.rutid,
        s.nombre_completo,
        s.nombres,
        s.paterno,
        s.materno,
        coalesce(s.email, ec.best_email, bc.email_propiedad) as email,
        bc.email_propiedad,
        coalesce(s.fono_cel, pc.best_phone, bc.telefono_propiedad_celular, bc.telefono_propiedad_particular, bc.telefono_propiedad_comercial) as fono_cel,
        bc.telefono_propiedad_celular,
        bc.telefono_propiedad_particular,
        bc.telefono_propiedad_comercial,
        bc.direccion,
        s.region,
        s.comuna,
        s.grupo_socioeconomico_proxy,
        s.tramo_score_patrimonial,
        s.cantidad_personas,
        s.indice_oportunidad_zona::text,
        s.total_autos,
        s.promedio_autos::text,
        s.personas_con_autos,
        s.total_bienes_raices,
        s.promedio_bienes_raices::text,
        s.personas_con_bienes_raices,
        s.avaluo_total_clp::text,
        s.avaluo_promedio_clp::text,
        coalesce(s.n_autos, 0) as n_autos,
        coalesce(s.n_bienes_raices, 0) as n_bienes_raices,
        coalesce(s.totalavaluos, 0)::text as totalavaluos,
        s.score_patrimonial,
        s.cobertura_pct,
        s.score_patrimonial_promedio::text,
        s.cobertura_promedio_pct::text,
        'personas_identificadas_con_contacto_y_segmentacion' as tipo_descarga
      from seleccion s
      left join lateral (
        select pcp.contact_value as best_phone
        from public.persona_contact_points pcp
        where pcp.rutid = s.rutid
          and pcp.contact_type = 'phone'
        order by pcp.is_verified desc, pcp.is_primary desc, pcp.quality_score desc, pcp.last_seen_at desc
        limit 1
      ) pc on true
      left join lateral (
        select pcp.contact_value as best_email
        from public.persona_contact_points pcp
        where pcp.rutid = s.rutid
          and pcp.contact_type = 'email'
        order by pcp.is_verified desc, pcp.is_primary desc, pcp.quality_score desc, pcp.last_seen_at desc
        limit 1
      ) ec on true
      left join lateral (
        select
          nullif(btrim(bp.direccion), '') as direccion,
          nullif(btrim(bp.email), '') as email_propiedad,
          nullif(btrim(concat(coalesce(bp.fono_area_cel, ''), coalesce(bp.fono_numero_cel, ''))), '') as telefono_propiedad_celular,
          nullif(btrim(concat(coalesce(bp.fono_area_part, ''), coalesce(bp.fono_numero_part, ''))), '') as telefono_propiedad_particular,
          nullif(btrim(concat(coalesce(bp.fono_area_comer, ''), coalesce(bp.fono_numero_comer, ''))), '') as telefono_propiedad_comercial
        from public.bbrr_propiedades bp
        where bp.rutid = s.rutid
          and (
            nullif(btrim(bp.direccion), '') is not null
            or nullif(btrim(bp.email), '') is not null
            or nullif(btrim(concat(coalesce(bp.fono_area_cel, ''), coalesce(bp.fono_numero_cel, ''))), '') is not null
            or nullif(btrim(concat(coalesce(bp.fono_area_part, ''), coalesce(bp.fono_numero_part, ''))), '') is not null
            or nullif(btrim(concat(coalesce(bp.fono_area_comer, ''), coalesce(bp.fono_numero_comer, ''))), '') is not null
          )
        order by
          (nullif(btrim(bp.direccion), '') is not null) desc,
          bp.avaluo_fiscal desc nulls last,
          bp.updated_at desc nulls last,
          bp.id asc
        limit 1
      ) bc on true
      order by s.indice_oportunidad_zona desc, s.cantidad_personas desc, s.avaluo_total_clp desc, s.score_patrimonial desc, s.totalavaluos desc, s.rutid asc
      `,
      [groupFilter, geolocatedOnly, missingRegion, missingComuna, limit]
    )

    return rows
  } finally {
    await client.end()
  }
}

function toCsv(rows: GsePersonRow[]) {
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
  const groups = getGroupParams(searchParams.getAll('group'))
  const geolocatedOnly = searchParams.get('geo') !== 'all'
  const limit = getPositiveInt(searchParams.get('limit'), 1000, 10000)
  const format = searchParams.get('format') === 'json' ? 'json' : 'csv'

  try {
    const rows = await queryPeople({ groups, geolocatedOnly, limit })
    const groupLabels = groups.map(group => GROUP_LABELS[group])

    if (format === 'json') {
      return NextResponse.json({
        success: true,
        data: rows,
        meta: {
          group: groupLabels.join(', '),
          geolocated_only: geolocatedOnly,
          limit,
          row_count: rows.length,
        },
      })
    }

    const suffix = groups.includes('ALL')
      ? 'todos'
      : groupLabels.join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
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
