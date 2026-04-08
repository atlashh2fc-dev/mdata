import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import { analyzeRutsForBaseBuilder } from '@/lib/services/base-builder'

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
  const selectedFields = Array.isArray(body?.selected_fields) ? body.selected_fields : []

  if (ruts.length === 0) {
    return NextResponse.json(
      { error: 'Debes enviar al menos un RUT para analizar.' },
      { status: 400 }
    )
  }

  try {
    const analysis = await analyzeRutsForBaseBuilder(ruts, selectedFields)
    return NextResponse.json({ success: true, data: analysis })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'No se pudo analizar la base cargada.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
