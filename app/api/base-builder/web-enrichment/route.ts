import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import { enrichRowsForBaseBuilderWeb } from '@/lib/services/base-builder'
import type { BaseBuilderMatchMode } from '@/types/base-builder'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const body = await req.json()
  const rows = Array.isArray(body?.rows) ? body.rows : []
  const matchMode: BaseBuilderMatchMode = body?.match_mode === 'razon_social'
    ? 'razon_social'
    : 'rut'
  const matchColumn = typeof body?.match_column === 'string'
    ? body.match_column
    : typeof body?.rut_column === 'string'
      ? body.rut_column
      : null
  const companyColumn = typeof body?.company_column === 'string'
    ? body.company_column
    : null
  const selectedFields = Array.isArray(body?.selected_fields) ? body.selected_fields : []

  if (rows.length === 0 || !matchColumn) {
    return NextResponse.json(
      { error: 'Debes enviar una base y la columna de cruce para enriquecer.' },
      { status: 400 }
    )
  }

  try {
    const enrichment = await enrichRowsForBaseBuilderWeb(
      rows,
      matchColumn,
      companyColumn,
      selectedFields,
      matchMode
    )

    return NextResponse.json({ success: true, data: enrichment ?? null })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'No se pudo ejecutar el enriquecimiento web.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
