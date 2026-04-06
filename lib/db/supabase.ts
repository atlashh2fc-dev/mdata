import { createClient } from '@supabase/supabase-js'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from './database.types'

export const hasSupabasePublicEnv = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

export const hasSupabaseAdminEnv = Boolean(
  hasSupabasePublicEnv &&
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co'
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder'
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder'


// ---------------------------------------------------------------
// Server-side with cookie session (respects RLS)
// ---------------------------------------------------------------
export async function createSupabaseServerClient() {
  const cookieStore = await cookies()
  return createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        } catch {
          // Server Components can't set cookies
        }
      },
    },
  })
}

// ---------------------------------------------------------------
// Server-side service role (bypasses RLS — usar solo en server)
// ---------------------------------------------------------------
export const supabaseAdmin = createClient<Database>(
  supabaseUrl,
  supabaseServiceKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
)

// Alias sin tipado estricto para operaciones de escritura complejas
// que el compilador de TS no puede resolver correctamente con supabase-js v2.101+
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const db = supabaseAdmin as any
