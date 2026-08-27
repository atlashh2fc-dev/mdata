'use client'

import { useEffect, useState } from 'react'
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
  BrainCircuit,
  Target,
  WandSparkles,
  Building2,
  LoaderCircle,
  Trophy,
} from 'lucide-react'
import { cn } from '@/lib/utils/formatters'

const HH_ALLOWED_EMAIL = 'hh2fc24@gmail.com'

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
      { href: '/hh', label: 'HH', icon: Trophy, allowedEmails: [HH_ALLOWED_EMAIL] },
      { href: '/inteligencia-comercial', label: 'Inteligencia Comercial', icon: Target },
      { href: '/ai', label: 'Cerebro de Negocios', icon: BrainCircuit },
      { href: '/universos', label: 'Explorador Universos', icon: Database },
      { href: '/segmentos', label: 'Segmentador Visual', icon: Users },
      { href: '/poblar', label: 'Poblar Base', icon: WandSparkles },
      { href: '/equifax-bdd', label: 'Armado BDD Equifax', icon: Building2 },
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

export function Sidebar({ userEmail }: { userEmail?: string | null }) {
  const pathname = usePathname()
  const [pendingHref, setPendingHref] = useState<string | null>(null)
  const normalizedUserEmail = userEmail?.toLowerCase() ?? null

  useEffect(() => {
    setPendingHref(null)
  }, [pathname])

  return (
      <nav aria-label="Módulos de Datos">
        {NAV_ITEMS.map(group => (
          <div key={group.group} className="mb-4">
            <p className="atlas-nav-group">
              {group.group}
            </p>
            <div className="space-y-0.5">
              {group.items.filter(item => {
                const allowedEmails = 'allowedEmails' in item ? item.allowedEmails : undefined
                return !allowedEmails || allowedEmails.includes(normalizedUserEmail ?? '')
              }).map(item => {
                const Icon = item.icon
                const isActive = item.href === '/poblar'
                  ? pathname.startsWith('/poblar') || pathname.startsWith('/exportar')
                  : item.href === '/equifax-bdd'
                    ? pathname.startsWith('/equifax-bdd')
                  : item.href === '/hh'
                    ? pathname.startsWith('/hh')
                  : item.href === '/inteligencia-comercial'
                    ? pathname.startsWith('/inteligencia-comercial') || pathname.startsWith('/inteligencia')
                    : pathname.startsWith(item.href)
                const isPending = pendingHref === item.href && !isActive
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => {
                      if (!isActive) setPendingHref(item.href)
                    }}
                    aria-current={isActive ? 'page' : undefined}
                    aria-busy={isPending || undefined}
                    className="atlas-nav-link"
                  >
                    {isPending ? (
                      <LoaderCircle className="w-4 h-4 flex-shrink-0 relative z-10 animate-spin text-primary-ink" />
                    ) : (
                      <Icon className={cn("w-4 h-4 flex-shrink-0 relative z-10", isActive ? "text-primary-ink" : "")} />
                    )}
                    <span className="flex-1 relative z-10">{item.label}</span>
                    {isPending ? (
                      <span className="text-[10px] font-medium text-primary-ink relative z-10">
                        abriendo
                      </span>
                    ) : isActive ? (
                      <ChevronRight className="w-3 h-3 opacity-80 text-primary-ink relative z-10" />
                    ) : null}
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

  )
}
