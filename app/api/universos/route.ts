import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'

export async function GET(req: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    // if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    // Read full matrix
    const { data, error } = await supabase
      .from('stats_universos')
      .select('*')

    if (error) {
      console.error('[API/Universos]', error)
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, data })
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Internal Server Error' }, { status: 500 })
  }
}
