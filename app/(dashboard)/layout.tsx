import { redirect } from 'next/navigation'
import { createSupabaseServerClient, hasSupabasePublicEnv } from '@/lib/db/supabase'
import { Sidebar } from '@/components/layout/Sidebar'
import { AtlasShell } from '@/vendor/atlas-ui/shell'
import { LogoutButton } from '@/components/layout/LogoutButton'

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

    return (
      <AtlasShell product="Datos" subtitle="Inteligencia de datos"
        navigation={<Sidebar userEmail={user.email ?? null} />}
        actions={<LogoutButton />} footer={user.email}>
        {children}
      </AtlasShell>
    )
  } catch (error) {
    console.error('[dashboard/layout] Supabase auth check failed', error)
    redirect('/login')
  }
}
