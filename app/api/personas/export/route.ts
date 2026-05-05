import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import { searchPersonas } from '@/lib/services/personas'
import type { PersonaSearchParams, PersonaView } from '@/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const EXPORT_HEADERS: Array<keyof PersonaView> = [
  'rutid',
  'nombre_completo',
  'nombres',
  'paterno',
  'materno',
  'email',
  'fono_cel',
  'region_part',
  'comuna_part',
  'domicilio_region',
  'domicilio_comuna',
  'n_autos',
  'razon_social_empresa',
  'n_bienes_raices',
  'totalavaluos',
  'uso_propiedad_inferido',
  'bbrr_destinos',
  'n_propiedades_residenciales',
  'n_propiedades_comerciales',
  'n_propiedades_rurales',
  'n_propiedades_indeterminadas',
  'avaluo_residencial',
  'avaluo_comercial',
  'avaluo_rural',
  'avaluo_indeterminado',
  'score_patrimonial',
  'cobertura_pct',
]

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = Array.isArray(value) ? value.join('|') : String(value)
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

function getBoolParam(searchParams: URLSearchParams, key: string) {
  return searchParams.has(key) ? searchParams.get(key) === 'true' : undefined
}

function getNumberParam(searchParams: URLSearchParams, key: string) {
  if (!searchParams.has(key)) return undefined
  const parsed = Number(searchParams.get(key))
  return Number.isFinite(parsed) ? parsed : undefined
}

function buildParams(searchParams: URLSearchParams): PersonaSearchParams {
  return {
    q: searchParams.get('q') ?? undefined,
    sort_by: searchParams.get('sort_by') ?? 'score_patrimonial',
    sort_order: (searchParams.get('sort_order') as 'asc' | 'desc') ?? 'desc',
    region: searchParams.get('region') ?? undefined,
    comuna: searchParams.get('comuna') ?? undefined,
    tiene_autos: getBoolParam(searchParams, 'tiene_autos'),
    tiene_empresa: getBoolParam(searchParams, 'tiene_empresa'),
    tiene_bienes_raices: getBoolParam(searchParams, 'tiene_bienes_raices'),
    uso_propiedad: searchParams.get('uso_propiedad') ?? undefined,
    destino_propiedad: searchParams.get('destino_propiedad') ?? undefined,
    score_min: getNumberParam(searchParams, 'score_min'),
    score_max: getNumberParam(searchParams, 'score_max'),
  }
}

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const baseParams = buildParams(req.nextUrl.searchParams)
  const encoder = new TextEncoder()
  const batchSize = 5000

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(`${EXPORT_HEADERS.join(',')}\n`))

      let currentPage = 1
      while (true) {
        const result = await searchPersonas({
          ...baseParams,
          page: currentPage,
          page_size: batchSize,
        })

        if (result.data.length === 0) break

        const csvChunk = result.data.map(row => (
          EXPORT_HEADERS.map(header => csvEscape(row[header])).join(',')
        )).join('\n')

        controller.enqueue(encoder.encode(`${csvChunk}\n`))

        if (result.data.length < batchSize || currentPage >= result.total_pages) break
        currentPage += 1
      }

      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="personas-filtradas-bbrr.csv"',
      'Cache-Control': 'no-store',
    },
  })
}
