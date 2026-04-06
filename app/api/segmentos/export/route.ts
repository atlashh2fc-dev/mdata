import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import { getSegmentoById, getSegmentoBatch } from '@/lib/services/segmentos'
import type { PersonaView } from '@/types'

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
  'score_patrimonial',
  'cobertura_pct',
]

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const body = await req.json()
  const segmentId = body.segment_id as string | undefined

  if (!segmentId) {
    return NextResponse.json({ error: 'segment_id es requerido' }, { status: 400 })
  }

  const segmento = await getSegmentoById(segmentId)
  if (!segmento) {
    return NextResponse.json({ error: 'Segmento no encontrado' }, { status: 404 })
  }

  const encoder = new TextEncoder()
  const fileName = `${slugify(segmento.name || 'segmento')}.csv`

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(`${EXPORT_HEADERS.join(',')}\n`))

      const batchSize = 5000
      let from = 0

      while (true) {
        const rows = await getSegmentoBatch(segmentId, from, batchSize)
        if (rows.length === 0) break

        const csvChunk = rows.map(row => {
          return EXPORT_HEADERS.map(header => csvEscape(row[header])).join(',')
        }).join('\n')

        controller.enqueue(encoder.encode(`${csvChunk}\n`))

        if (rows.length < batchSize) break
        from += batchSize
      }

      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  })
}
