import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import { getPersonaDetail360 } from '@/lib/services/personas'

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const rut = req.nextUrl.searchParams.get('rut')
  if (!rut) {
    return NextResponse.json({ error: 'rut es requerido' }, { status: 400 })
  }

  const detail = await getPersonaDetail360(rut)
  if (!detail) {
    return NextResponse.json({ error: 'RUT no encontrado' }, { status: 404 })
  }

  return NextResponse.json({ success: true, data: detail })
}
