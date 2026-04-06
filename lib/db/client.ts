import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// ---------------------------------------------------------------
// Client-side (anon key, browser only)
// ---------------------------------------------------------------
export const supabaseBrowser = createClient<Database>(
  supabaseUrl,
  supabaseAnonKey
)
