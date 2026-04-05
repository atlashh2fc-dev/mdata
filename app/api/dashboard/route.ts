import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import { getDashboardKPIs, getCoberturaData, getRecentActivity, refreshStats } from '@/lib/services/dashboard'

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { searchParams } = req.nextUrl
  const section = searchParams.get('section') ?? 'all'

  if (section === 'kpis') {
    const kpis = await getDashboardKPIs()
    return NextResponse.json({ success: true, data: kpis })
  }

  if (section === 'cobertura') {
    const cobertura = await getCoberturaData()
    return NextResponse.json({ success: true, data: cobertura })
  }

  if (section === 'activity') {
    const limit = parseInt(searchParams.get('limit') ?? '10')
    const activity = await getRecentActivity(limit)
    return NextResponse.json({ success: true, data: activity })
  }

  // All
  const [kpis, cobertura, activity] = await Promise.all([
    getDashboardKPIs(),
    getCoberturaData(),
    getRecentActivity(10),
  ])

  return NextResponse.json({ success: true, data: { kpis, cobertura, activity } })
}

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const body = await req.json()
  if (body.action === 'refresh_stats') {
    await refreshStats()
    return NextResponse.json({ success: true, message: 'Stats actualizadas' })
  }

  return NextResponse.json({ error: 'Acción no reconocida' }, { status: 400 })
}
