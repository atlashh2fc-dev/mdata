import type { NextRequest } from 'next/server'
import { handleAudienciaRequest } from '@/lib/services/atlas-audiencia'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

/** Audiencias de correo para las campañas de Atlas CRM (bigdata.audiencia.v1). */
export async function POST(req: NextRequest) {
  return handleAudienciaRequest(req)
}
