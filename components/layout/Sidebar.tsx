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
  ChevronRight,
  Activity,
  Zap,
  LogOut,
  BrainCircuit,
  Target,
  WandSparkles,
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
    group: 'AI & Análisis',
    items: [
      { href: '/inteligencia', label: 'Inteligencia Comercial', icon: Target },
      { href: '/ai', label: 'Cerebro de Negocios', icon: BrainCircuit },
      { href: '/universos', label: 'Explorador Universos', icon: Database },
      { href: '/segmentos', label: 'Segmentador Visual', icon: Users },
      { href: '/poblar', label: 'Poblar Base', icon: WandSparkles },
      { href: '/exportar', label: 'Exportar Base', icon: Download },
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
                const isActive = item.href === '/poblar'
                  ? pathname.startsWith('/poblar') || pathname.startsWith('/exportar')
                  : pathname.startsWith(item.href)
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      'sidebar-item relative overflow-hidden transition-all duration-300',
                      isActive ? 'active shadow-[0_0_10px_rgba(6,182,212,0.15)] bg-[#1e293b]/50 border border-slate-700/50' : 'hover:bg-slate-800/40'
                    )}
                  >
                    {isActive && (
                      <div className="absolute inset-0 bg-gradient-to-r from-cyan-500/10 to-transparent pointer-events-none" />
                    )}
                    <Icon className={cn("w-4 h-4 flex-shrink-0 relative z-10", isActive ? "text-cyan-400" : "")} />
                    <span className="flex-1 relative z-10">{item.label}</span>
                    {isActive && <ChevronRight className="w-3 h-3 opacity-80 text-cyan-500 relative z-10 animate-pulse" />}
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
