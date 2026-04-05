import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import { getEstadisticas } from '@/lib/services/ingestion'
import { getPersonasByRegion, getScoreDistribution } from '@/lib/services/personas'

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { searchParams } = req.nextUrl
  const section = searchParams.get('section') ?? 'all'

  if (section === 'por_region') {
    const data = await getPersonasByRegion()
    return NextResponse.json({ success: true, data })
  }

  if (section === 'score_dist') {
    const data = await getScoreDistribution()
    return NextResponse.json({ success: true, data })
  }

  if (section === 'ingestion') {
    const data = await getEstadisticas()
    return NextResponse.json({ success: true, data })
  }

  const [porRegion, scoreDist, ingestion] = await Promise.all([
    getPersonasByRegion(),
    getScoreDistribution(),
    getEstadisticas(),
  ])

  return NextResponse.json({
    success: true,
    data: { por_region: porRegion, score_dist: scoreDist, ingestion },
  })
}
