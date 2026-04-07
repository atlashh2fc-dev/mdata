import { createBrowserClient } from '@supabase/ssr'
import type { Database } from './database.types'

export const hasSupabasePublicEnv = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co'
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder'

// ---------------------------------------------------------------
// Client-side (anon key, browser only)
// IMPORTANT: must use createBrowserClient from @supabase/ssr,
// NOT createClient from @supabase/supabase-js.
// createBrowserClient stores the session in cookies (not localStorage)
// so the SSR middleware can read it via createServerClient.
// Using createClient breaks auth: client logs in but middleware never
// sees the session and keeps redirecting to /login.
// ---------------------------------------------------------------
export const supabaseBrowser = createBrowserClient<Database>(
  supabaseUrl,
  supabaseAnonKey
)
