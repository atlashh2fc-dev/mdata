'use client'
import { LogOut } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/db/client'

export function LogoutButton() {
  const router = useRouter()
  async function logout() {
    await supabaseBrowser.auth.signOut()
    router.push('/login')
  }
  return <button type="button" onClick={logout} className="atlas-icon-button" aria-label="Cerrar sesión" title="Cerrar sesión"><LogOut aria-hidden="true" /></button>
}
