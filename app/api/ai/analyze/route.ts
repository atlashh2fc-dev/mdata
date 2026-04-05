import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import { analyzeWithAI } from '@/lib/services/ai'
import type { AIAnalysisRequest, AIAnalysisType } from '@/types'

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const body = await req.json()
  const { type, data, context } = body as AIAnalysisRequest & { type: AIAnalysisType }

  const validTypes = ['enrichment', 'classification', 'scoring', 'dataset']
  if (!type || !validTypes.includes(type)) {
    return NextResponse.json(
      { error: `Tipo inválido. Usar: ${validTypes.join(', ')}` },
      { status: 400 }
    )
  }

  if (!data || typeof data !== 'object') {
    return NextResponse.json({ error: 'data es requerido y debe ser un objeto' }, { status: 400 })
  }

  try {
    const result = await analyzeWithAI({ type, data, context }, user.id)
    return NextResponse.json({ success: true, data: result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Error en análisis IA'
    console.error('[AI analyze]', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
