import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

export async function middleware(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const { pathname } = request.nextUrl

  // Rutas protegidas
  const isProtectedRoute =
    pathname.startsWith('/dashboard') ||
    pathname.startsWith('/buscar') ||
    pathname.startsWith('/datasets') ||
    pathname.startsWith('/ingesta') ||
    pathname.startsWith('/inteligencia') ||
    pathname.startsWith('/inteligencia-comercial') ||
    pathname.startsWith('/poblar') ||
    pathname.startsWith('/segmentos') ||
    pathname.startsWith('/exportar') ||
    pathname.startsWith('/logs')

  if (!supabaseUrl || !supabaseAnonKey) {
    return isProtectedRoute
      ? NextResponse.redirect(new URL('/login', request.url))
      : NextResponse.next({ request })
  }

  let supabaseResponse = NextResponse.next({ request })

  try {
    const supabase = createServerClient(
      supabaseUrl,
      supabaseAnonKey,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll()
          },
          setAll(cookiesToSet) {
            // IMPORTANT: must set cookies on both request AND response
            // Do NOT recreate supabaseResponse here — that drops the cookies
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value)
            )
            supabaseResponse = NextResponse.next({ request })
            cookiesToSet.forEach(({ name, value, options }) =>
              supabaseResponse.cookies.set(name, value, options)
            )
          },
        },
      }
    )

    // IMPORTANT: use getUser() not getSession() — validates the token server-side
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (isProtectedRoute && !user) {
      const redirectUrl = new URL('/login', request.url)
      const redirectResponse = NextResponse.redirect(redirectUrl)
      // Copy over any session cookies Supabase may have set
      supabaseResponse.cookies.getAll().forEach((cookie) => {
        redirectResponse.cookies.set(cookie.name, cookie.value)
      })
      return redirectResponse
    }

    if (pathname === '/login' && user) {
      const redirectResponse = NextResponse.redirect(new URL('/dashboard', request.url))
      supabaseResponse.cookies.getAll().forEach((cookie) => {
        redirectResponse.cookies.set(cookie.name, cookie.value)
      })
      return redirectResponse
    }

    return supabaseResponse
  } catch (error) {
    console.error('[middleware] Supabase auth check failed', error)

    if (isProtectedRoute) {
      return NextResponse.redirect(new URL('/login', request.url))
    }

    return NextResponse.next({ request })
  }
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
