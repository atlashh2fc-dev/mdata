import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import { generateEquifaxLeads } from '@/lib/services/equifax-bdd'

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

  try {
    const body = await req.json()
    const result = await generateEquifaxLeads(
      {
        volume: Number(body?.volume ?? 1000),
        product_ids: Array.isArray(body?.product_ids) ? body.product_ids : [],
        transient_products: Array.isArray(body?.transient_products) ? body.transient_products : [],
        prompt: typeof body?.prompt === 'string' ? body.prompt : null,
        regions: Array.isArray(body?.regions) ? body.regions : [],
        include_existing_customers: body?.include_existing_customers !== false,
        min_phone_count: Number(body?.min_phone_count ?? 1),
        min_email_count: Number(body?.min_email_count ?? 0),
      },
      user.id
    )

    return NextResponse.json({ success: true, data: result })
  } catch (error) {
    console.error('[equifax/leads]', error)
    const message = error instanceof Error ? error.message : 'No se pudo generar la base Equifax.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
