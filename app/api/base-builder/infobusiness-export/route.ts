import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import { buildInfobusinessExport } from '@/lib/services/infobusiness-export'

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

  const body = await req.json()
  const rutids = Array.isArray(body?.rutids)
    ? body.rutids.map((rutid: unknown) => String(rutid ?? '')).filter(Boolean)
    : []

  if (rutids.length === 0) {
    return NextResponse.json(
      { error: 'Debes enviar RUTs cruzados para exportar la plantilla Infobusiness.' },
      { status: 400 }
    )
  }

  try {
    const workbook = await buildInfobusinessExport(rutids)
    return new NextResponse(workbook, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="plantilla-infobusiness.xlsx"',
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'No se pudo exportar la plantilla Infobusiness.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
