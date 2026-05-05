import { NextResponse } from 'next/server'
import { createSupabaseServerClient, db } from '@/lib/db/supabase'

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const [{ data: usos, error: usosError }, { data: destinos, error: destinosError }] = await Promise.all([
    db.rpc('get_bbrr_uso_counts'),
    db.rpc('get_bbrr_destino_counts'),
  ])

  if (usosError) {
    return NextResponse.json({ success: false, error: usosError.message }, { status: 500 })
  }

  if (destinosError) {
    return NextResponse.json({ success: false, error: destinosError.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    usos: usos ?? [],
    destinos: destinos ?? [],
  })
}
