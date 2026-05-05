import Link from 'next/link'
import { Building2, Crown, ShieldCheck, Users } from 'lucide-react'
import { Header } from '@/components/layout/Header'

export const dynamic = 'force-dynamic'

function RoleCard({
  href,
  label,
  description,
  icon: Icon,
}: {
  href: string
  label: string
  description: string
  icon: typeof Users
}) {
  return (
    <Link
      href={href}
      className="card p-5 transition hover:border-cyan-500/30 hover:bg-slate-950/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-white">{label}</div>
          <div className="mt-1 text-xs text-slate-400">{description}</div>
        </div>
        <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-3 text-cyan-300">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </Link>
  )
}

export default function EquifaxCrmLandingPage() {
  return (
    <>
      <Header
        title="CRM Equifax (roles)"
        subtitle="KPIs, rankings, semáforos y proyección para operación diaria"
      />

      <div className="space-y-6 p-6">
        <div className="grid gap-4 md:grid-cols-3">
          <RoleCard
            href="/equifax-crm/manager"
            label="Manager"
            description="Detalle por agente + brechas y acciones"
            icon={Users}
          />
          <RoleCard
            href="/equifax-crm/supervisor"
            label="Supervisor"
            description="Monitoreo táctico + ranking operativo"
            icon={ShieldCheck}
          />
          <RoleCard
            href="/equifax-crm/executive"
            label="Executive"
            description="Resumen ejecutivo sin selección de agente"
            icon={Crown}
          />
        </div>

        <div className="card p-5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            <Building2 className="h-4 w-4 text-cyan-300" />
            Acceso rápido
          </div>
          <div className="mt-3 text-sm text-slate-200">
            Para generar y empujar bases a CRM usa <Link href="/equifax-bdd" className="text-cyan-300 hover:underline">Armado BDD Equifax</Link>.
          </div>
        </div>
      </div>
    </>
  )
}

