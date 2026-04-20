import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import { getPersonaByRut, searchPersonas } from '@/lib/services/personas'
import type { PersonaSearchParams } from '@/types'
import { validateRut } from '@/lib/utils/rut'

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const { searchParams } = req.nextUrl
  const rut = searchParams.get('rut')

  // Búsqueda por RUT exacto; si viene texto en el parámetro rut, cae al buscador general.
  if (rut && validateRut(rut)) {
    const persona = await getPersonaByRut(rut)
    if (!persona) {
      return NextResponse.json({ error: 'RUT no encontrado' }, { status: 404 })
    }
    return NextResponse.json({ success: true, data: persona })
  }

  // Búsqueda con filtros
  const params: PersonaSearchParams = {
    q: searchParams.get('q') ?? rut ?? undefined,
    page: parseInt(searchParams.get('page') ?? '1'),
    page_size: Math.min(parseInt(searchParams.get('page_size') ?? '50'), 200),
    sort_by: searchParams.get('sort_by') ?? 'score_patrimonial',
    sort_order: (searchParams.get('sort_order') as 'asc' | 'desc') ?? 'desc',
    region: searchParams.get('region') ?? undefined,
    comuna: searchParams.get('comuna') ?? undefined,
    tiene_autos: searchParams.has('tiene_autos')
      ? searchParams.get('tiene_autos') === 'true'
      : undefined,
    tiene_empresa: searchParams.has('tiene_empresa')
      ? searchParams.get('tiene_empresa') === 'true'
      : undefined,
    tiene_bienes_raices: searchParams.has('tiene_bienes_raices')
      ? searchParams.get('tiene_bienes_raices') === 'true'
      : undefined,
    score_min: searchParams.has('score_min')
      ? parseInt(searchParams.get('score_min')!)
      : undefined,
    score_max: searchParams.has('score_max')
      ? parseInt(searchParams.get('score_max')!)
      : undefined,
  }

  const result = await searchPersonas(params)
  return NextResponse.json({ success: true, ...result })
}
