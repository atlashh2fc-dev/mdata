import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

export const hasSupabasePublicEnv = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co'
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder'

// ---------------------------------------------------------------
// Client-side (anon key, browser only)
// ---------------------------------------------------------------
export const supabaseBrowser = createClient<Database>(
  supabaseUrl,
  supabaseAnonKey
)
