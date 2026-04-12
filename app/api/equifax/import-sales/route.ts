import * as XLSX from 'xlsx'
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import { importEquifaxSalesRows, toImportedSaleRow } from '@/lib/services/equifax-bdd'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const SHEET_KIND_MAP: Record<string, 'recurrente' | 'one_time'> = {
  recurrente: 'recurrente',
  'one time': 'one_time',
}

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const formData = await req.formData()
  const file = formData.get('file')

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Debes adjuntar un archivo Excel.' }, { status: 400 })
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true })
    const rows = workbook.SheetNames.flatMap(sheetName => {
      const saleKind = SHEET_KIND_MAP[sheetName.trim().toLowerCase()]
      if (!saleKind) return []

      const sheet = workbook.Sheets[sheetName]
      if (!sheet) return []

      const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        raw: false,
        defval: null,
      })

      return data.map((row, index) => toImportedSaleRow({
        sourceFile: file.name,
        sourceSheet: sheetName,
        rowNumber: index + 2,
        saleKind,
        row,
      }))
    })

    const result = await importEquifaxSalesRows(rows)
    return NextResponse.json({ success: true, data: result })
  } catch (error) {
    console.error('[equifax/import-sales]', error)
    const message = error instanceof Error ? error.message : 'No se pudo importar el Excel.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
