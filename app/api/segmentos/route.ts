import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import {
  getSegmentos,
  createSegmento,
  executeSegmento,
  deleteSegmento,
  computeSegmentoCount,
} from '@/lib/services/segmentos'
import type { SegmentFilter } from '@/types'

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { searchParams } = req.nextUrl
  const page = parseInt(searchParams.get('page') ?? '1')
  const pageSize = parseInt(searchParams.get('page_size') ?? '20')
  const executeId = searchParams.get('execute')

  if (executeId) {
    const execPage = parseInt(searchParams.get('exec_page') ?? '1')
    const execPageSize = parseInt(searchParams.get('exec_page_size') ?? '100')
    const result = await executeSegmento(executeId, execPage, execPageSize)
    return NextResponse.json({ success: true, ...result })
  }

  const result = await getSegmentos(page, pageSize)
  return NextResponse.json({ success: true, ...result })
}

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const body = await req.json()
  const { name, description, filters } = body as {
    name: string
    description?: string
    filters: SegmentFilter
  }

  if (!name || !filters) {
    return NextResponse.json({ error: 'name y filters son requeridos' }, { status: 400 })
  }

  const segmento = await createSegmento(name, description ?? null, filters, user.id)
  if (!segmento) {
    return NextResponse.json({ error: 'Error al crear segmento' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: segmento }, { status: 201 })
}

export async function DELETE(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { searchParams } = req.nextUrl
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 })

  const success = await deleteSegmento(id)
  return NextResponse.json({ success })
}
