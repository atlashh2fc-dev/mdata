import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import { getFuentes, createFuente, getColumnMappings, saveColumnMappings } from '@/lib/services/ingestion'
import type { ColumnMappingDraft } from '@/types'

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { searchParams } = req.nextUrl
  const sourceId = searchParams.get('source_id')

  if (sourceId) {
    const mappings = await getColumnMappings(sourceId)
    return NextResponse.json({ success: true, data: mappings })
  }

  const fuentes = await getFuentes()
  return NextResponse.json({ success: true, data: fuentes })
}

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const body = await req.json()

  if (body.action === 'save_mappings') {
    const { source_id, mappings } = body as {
      source_id: string
      mappings: ColumnMappingDraft[]
    }
    await saveColumnMappings(source_id, mappings)
    return NextResponse.json({ success: true })
  }

  const { name, source_type, description } = body
  if (!name) return NextResponse.json({ error: 'name requerido' }, { status: 400 })

  const fuente = await createFuente(name, source_type ?? 'csv', description ?? null, user.id)
  if (!fuente) {
    return NextResponse.json({ error: 'Error al crear fuente' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: fuente }, { status: 201 })
}
