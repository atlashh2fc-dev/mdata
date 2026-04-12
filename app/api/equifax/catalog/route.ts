import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import {
  getEquifaxCatalogSummary,
  getEquifaxProductCatalog,
  saveEquifaxProducts,
} from '@/lib/services/equifax-bdd'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  try {
    const [summary, products] = await Promise.all([
      getEquifaxCatalogSummary(),
      getEquifaxProductCatalog(),
    ])

    return NextResponse.json({
      success: true,
      data: {
        summary,
        products,
      },
    })
  } catch (error) {
    console.error('[equifax/catalog:get]', error)
    const message = error instanceof Error ? error.message : 'No se pudo cargar el módulo Equifax.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

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

  if (rows.length === 0) {
    return NextResponse.json({ error: 'Debes enviar al menos un producto.' }, { status: 400 })
  }

  try {
    const result = await saveEquifaxProducts(rows, user.id)
    return NextResponse.json({ success: true, data: result })
  } catch (error) {
    console.error('[equifax/catalog:post]', error)
    const message = error instanceof Error ? error.message : 'No se pudo guardar el catálogo.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
