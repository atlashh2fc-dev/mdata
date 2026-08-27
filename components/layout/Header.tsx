import type { ReactNode } from 'react'

interface HeaderProps { title: string; subtitle?: string; actions?: ReactNode }

export function Header({ title, subtitle, actions }: HeaderProps) {
  return <header className="atlas-page-header mx-6 mt-6">
    <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
    {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
  </header>
}
