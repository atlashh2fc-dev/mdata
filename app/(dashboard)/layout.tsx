import { redirect } from 'next/navigation'
import { createSupabaseServerClient, hasSupabasePublicEnv } from '@/lib/db/supabase'
import { Sidebar } from '@/components/layout/Sidebar'

export const dynamic = 'force-dynamic'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  if (!hasSupabasePublicEnv) {
    redirect('/login')
  }

  try {
    const supabase = await createSupabaseServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      redirect('/login')
    }
  } catch (error) {
    console.error('[dashboard/layout] Supabase auth check failed', error)
    redirect('/login')
  }

  return (
    <div className="flex h-screen bg-[#0a1024]">
      <Sidebar />
      <main className="flex-1 ml-64 overflow-y-auto">
        {children}
      </main>
    </div>
  )
}
