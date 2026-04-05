'use client'

import { Bell, RefreshCw } from 'lucide-react'

interface HeaderProps {
  title: string
  subtitle?: string
  actions?: React.ReactNode
}

export function Header({ title, subtitle, actions }: HeaderProps) {
  return (
    <header className="h-16 flex items-center justify-between px-6 border-b border-[#1e2d4a] bg-[#0d1529]/80 backdrop-blur-sm sticky top-0 z-20">
      <div>
        <h1 className="text-base font-semibold text-white">{title}</h1>
        {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
      </div>

      <div className="flex items-center gap-3">
        {actions}
        <button className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-all">
          <Bell className="w-4 h-4" />
        </button>
      </div>
    </header>
  )
}
