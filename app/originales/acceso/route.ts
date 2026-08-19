import { NextRequest, NextResponse } from 'next/server'
import {
  RAW_DATASET_SESSION_COOKIE,
  verifyRawDatasetShareToken,
} from '@/lib/raw-datasets'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  const payload = verifyRawDatasetShareToken(token)
  if (!token || !payload) return new NextResponse('Enlace inválido o vencido', { status: 404 })

  const response = NextResponse.redirect(new URL('/originales', request.url), 303)
  response.cookies.set(RAW_DATASET_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    expires: new Date(payload.exp * 1000),
  })
  response.headers.set('Cache-Control', 'private, no-store, max-age=0')
  response.headers.set('Referrer-Policy', 'no-referrer')
  return response
}
