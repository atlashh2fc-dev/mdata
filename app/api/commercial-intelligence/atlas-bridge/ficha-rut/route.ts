import type { NextRequest } from 'next/server'
import { handleFichaRutRequest } from '@/lib/services/atlas-ficha-rut'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 15

/** Ficha por RUT para el ingreso fuera de base de Atlas 2.0 (bigdata.ficha_rut.v1). */
export async function POST(req: NextRequest) {
  return handleFichaRutRequest(req)
}
