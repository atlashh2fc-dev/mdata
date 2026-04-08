import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import {
  analyzeRowsForBaseBuilder,
  analyzeRutsForBaseBuilder,
} from '@/lib/services/base-builder'
import type { BaseBuilderMatchMode } from '@/types/base-builder'

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const body = await req.json()
  const ruts = Array.isArray(body?.ruts) ? body.ruts : []
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
  const enrichMissingContactsWithWeb = body?.enrich_missing_contacts_with_web === true
  const selectedFields = Array.isArray(body?.selected_fields) ? body.selected_fields : []

  if (rows.length === 0 && ruts.length === 0) {
    return NextResponse.json(
      { error: 'Debes enviar una base o al menos un RUT para analizar.' },
      { status: 400 }
    )
  }

  try {
    const analysis = rows.length > 0 && matchColumn
      ? await analyzeRowsForBaseBuilder(
          rows,
          matchColumn,
          companyColumn,
          selectedFields,
          matchMode,
          enrichMissingContactsWithWeb
        )
      : await analyzeRutsForBaseBuilder(ruts, selectedFields)
    return NextResponse.json({ success: true, data: analysis })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'No se pudo analizar la base cargada.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
