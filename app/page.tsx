import { redirect } from 'next/navigation'
import { createSupabaseServerClient, hasSupabaseEnv } from '@/lib/db/supabase'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  if (!hasSupabaseEnv) {
    redirect('/login')
  }

  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  redirect(user ? '/dashboard' : '/login')
}
