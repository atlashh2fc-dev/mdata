'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Search,
  Database,
  Upload,
  Users,
  Download,
  Activity,
  ChevronRight,
  Zap,
  LogOut,
} from 'lucide-react'
import { cn } from '@/lib/utils/formatters'
import { supabaseBrowser } from '@/lib/db/client'
import { useRouter } from 'next/navigation'

const NAV_ITEMS = [
  {
    group: 'Principal',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/buscar', label: 'Buscador / Perfil 360', icon: Search },
    ],
  },
  {
    group: 'Datos',
    items: [
      { href: '/datasets', label: 'Datasets', icon: Database },
      { href: '/ingesta', label: 'Ingesta', icon: Upload },
    ],
  },
  {
    group: 'Inteligencia',
    items: [
      { href: '/segmentos', label: 'Segmentos', icon: Users },
      { href: '/exportar', label: 'Exportar', icon: Download },
    ],
  },
  {
    group: 'Sistema',
    items: [
      { href: '/logs', label: 'Logs de actividad', icon: Activity },
    ],
  },
]

export function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()

  async function handleLogout() {
    await supabaseBrowser.auth.signOut()
    router.push('/login')
  }

  return (
    <aside className="fixed left-0 top-0 h-screen w-64 flex flex-col bg-[#0f172a] border-r border-[#334155] z-30">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 h-16 border-b border-[#334155]">
        <div className="w-8 h-8 rounded-lg bg-[#06b6d4] flex items-center justify-center shadow-[0_0_15px_rgba(6,182,212,0.3)]">
          <Zap className="w-4 h-4 text-white" />
        </div>
        <div>
          <p className="text-sm font-bold text-white leading-none">RUT Intelligence</p>
          <p className="text-[10px] text-slate-400 mt-0.5 uppercase tracking-wider">Data Platform</p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-4 px-3">
        {NAV_ITEMS.map(group => (
          <div key={group.group} className="mb-6">
            <p className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-600">
              {group.group}
            </p>
            <div className="space-y-0.5">
              {group.items.map(item => {
                const Icon = item.icon
                const isActive = pathname.startsWith(item.href)
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      'sidebar-item',
                      isActive && 'active'
                    )}
                  >
                    <Icon className="w-4 h-4 flex-shrink-0" />
                    <span className="flex-1">{item.label}</span>
                    {isActive && <ChevronRight className="w-3 h-3 opacity-50" />}
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-3 py-4 border-t border-[#1e2d4a] space-y-1">
        <button
          onClick={handleLogout}
          className="sidebar-item w-full text-red-400 hover:text-red-300 hover:bg-red-500/10"
        >
          <LogOut className="w-4 h-4" />
          <span>Cerrar sesión</span>
        </button>
      </div>
    </aside>
  )
}
