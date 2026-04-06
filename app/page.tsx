import { redirect } from 'next/navigation'
import { createSupabaseServerClient, hasSupabasePublicEnv } from '@/lib/db/supabase'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  if (!hasSupabasePublicEnv) {
    redirect('/login')
  }

  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    redirect(user ? '/dashboard' : '/login')
  } catch (error) {
    console.error('[app/page] Supabase auth check failed', error)
    redirect('/login')
  }
}
