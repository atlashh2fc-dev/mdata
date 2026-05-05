import Link from 'next/link'
import { notFound } from 'next/navigation'
import { BarChart3, ChevronLeft, Gauge, Target, Users } from 'lucide-react'
import { Header } from '@/components/layout/Header'
import { EquifaxCrmAgentPicker } from '@/components/equifax/EquifaxCrmAgentPicker'
import { EquifaxCrmRoleCharts } from '@/components/equifax/EquifaxCrmRoleCharts'
import { loadEquifaxRoleViewData, type EquifaxCrmRole } from '@/lib/services/equifax-role-view'
import { cn, formatNumber, formatPercentage } from '@/lib/utils/formatters'

export const dynamic = 'force-dynamic'

function isRole(value: string): value is EquifaxCrmRole {
  return value === 'manager' || value === 'supervisor' || value === 'executive'
}

function roleLabel(role: EquifaxCrmRole) {
  if (role === 'manager') return 'Manager'
  if (role === 'supervisor') return 'Supervisor'
  return 'Executive'
}

function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string
  value: string
  hint: string
  icon: typeof Gauge
}) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</div>
          <div className="mt-2 text-3xl font-semibold text-white">{value}</div>
          <div className="mt-1 text-xs text-slate-400">{hint}</div>
        </div>
        <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-3 text-cyan-300">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  )
}

function SemaforoChip({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'green' | 'yellow' | 'red' | 'slate'
}) {
  const classes = {
    green: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    yellow: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    red: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
    slate: 'border-slate-700 bg-slate-900/50 text-slate-200',
  }[tone]

  return (
    <div className={cn('rounded-2xl border px-4 py-3', classes)}>
      <div className="text-xs font-semibold uppercase tracking-[0.16em] opacity-80">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{formatNumber(value)}</div>
    </div>
  )
}

export default async function EquifaxCrmRolePage({
  params,
  searchParams,
}: {
  params: Promise<{ role?: string | string[] }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const resolvedParams = await params
  const roleValue = Array.isArray(resolvedParams.role) ? resolvedParams.role[0] : resolvedParams.role
  if (!roleValue || !isRole(roleValue)) notFound()

  const role = roleValue
  const basePath = `/equifax-crm/${role}`
  const resolvedSearchParams = await searchParams
  const rawAgent = typeof resolvedSearchParams?.agent === 'string' ? resolvedSearchParams.agent : Array.isArray(resolvedSearchParams?.agent) ? resolvedSearchParams?.agent[0] : null
  const chartEnabledRaw = typeof resolvedSearchParams?.chart === 'string' ? resolvedSearchParams.chart : Array.isArray(resolvedSearchParams?.chart) ? resolvedSearchParams?.chart[0] : null
  const chartEnabled = chartEnabledRaw === '1' || chartEnabledRaw === 'true'
  const agentName = role === 'executive' ? null : (rawAgent?.trim() || null)

  const data = await loadEquifaxRoleViewData({ role, agentName })

  const toggleChartParams = new URLSearchParams()
  if (data.agent_selected) toggleChartParams.set('agent', data.agent_selected)
  if (!chartEnabled) toggleChartParams.set('chart', '1')

  const goals = data.goals
  const goalGap = goals
    ? {
        contacts: goals.contacts - data.kpis.contacts,
        interests: goals.interests - data.kpis.interests,
        purchases: goals.purchases - data.kpis.purchases,
      }
    : null

  return (
    <>
      <Header
        title={`CRM Equifax · ${roleLabel(role)}`}
        subtitle={`Ventana: ${data.window.label} · ${new Date(data.window.start).toLocaleString('es-CL')} → ${new Date(data.window.end).toLocaleString('es-CL')}`}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/equifax-crm"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-950/60"
            >
              <ChevronLeft className="h-4 w-4" />
              Roles
            </Link>

            {role !== 'executive' && (
              <EquifaxCrmAgentPicker
                agents={data.agents}
                currentAgent={data.agent_selected}
                basePath={basePath}
              />
            )}

            <Link
              href={`${basePath}?${toggleChartParams.toString()}`}
              className="inline-flex items-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs font-semibold text-cyan-300 hover:bg-cyan-500/15"
            >
              <BarChart3 className="h-4 w-4" />
              {chartEnabled ? 'Ocultar charts' : 'Mostrar charts'}
            </Link>
          </div>
        )}
      />

      <div className="space-y-6 p-6">
        {data.warnings.length > 0 && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-200">Notas</div>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {data.warnings.slice(0, 6).map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <MetricCard
            label="Intentos"
            value={formatNumber(data.kpis.attempts)}
            hint={`${formatNumber(data.kpis.unique_leads)} leads únicos`}
            icon={Gauge}
          />
          <MetricCard
            label="Contacto"
            value={formatNumber(data.kpis.contacts)}
            hint={`Rate ${formatPercentage(data.kpis.contact_rate)}`}
            icon={Target}
          />
          <MetricCard
            label="Interés"
            value={formatNumber(data.kpis.interests)}
            hint={`Rate ${formatPercentage(data.kpis.interest_rate)}`}
            icon={Users}
          />
          <MetricCard
            label="Compra"
            value={formatNumber(data.kpis.purchases)}
            hint={`Rate ${formatPercentage(data.kpis.purchase_rate)}`}
            icon={Target}
          />
          <MetricCard
            label="Brecha compras"
            value={goalGap ? formatNumber(goalGap.purchases) : '—'}
            hint={goals ? `Meta ${formatNumber(goals.purchases)} (${goals.source})` : 'Metas no configuradas'}
            icon={Target}
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
          <div className="card p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Semáforo</div>
              {data.agent_selected && (
                <div className="text-xs text-slate-400">Agente: <span className="text-slate-200">{data.agent_selected}</span></div>
              )}
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <SemaforoChip label="Portfolio Verde" value={data.semaforo.portfolio.green} tone="green" />
              <SemaforoChip label="Portfolio Amarillo" value={data.semaforo.portfolio.yellow} tone="yellow" />
              <SemaforoChip label="Portfolio Rojo" value={data.semaforo.portfolio.red} tone="red" />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-4">
              <SemaforoChip label="Gestionados Verde" value={data.semaforo.managed_today.green} tone="green" />
              <SemaforoChip label="Gestionados Amarillo" value={data.semaforo.managed_today.yellow} tone="yellow" />
              <SemaforoChip label="Gestionados Rojo" value={data.semaforo.managed_today.red} tone="red" />
              <SemaforoChip label="Gestionados Sin score" value={data.semaforo.managed_today.unknown} tone="slate" />
            </div>
          </div>

          <div className="card p-5">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Proyección (pipeline)</div>
            {data.projection ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3">
                  <div className="text-xs text-slate-400">Top 1000 · Contactos esperados</div>
                  <div className="mt-1 text-2xl font-semibold text-white">{formatNumber(Math.round(data.projection.top_1000.expected_contacts))}</div>
                </div>
                <div className="rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3">
                  <div className="text-xs text-slate-400">Top 1000 · Intereses esperados</div>
                  <div className="mt-1 text-2xl font-semibold text-white">{formatNumber(Math.round(data.projection.top_1000.expected_interests))}</div>
                </div>
                <div className="rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3">
                  <div className="text-xs text-slate-400">Top 1000 · Compras esperadas</div>
                  <div className="mt-1 text-2xl font-semibold text-white">{formatNumber(Math.round(data.projection.top_1000.expected_purchases))}</div>
                </div>
              </div>
            ) : (
              <div className="mt-3 text-sm text-slate-400">Sin datos de proyección.</div>
            )}

            <div className="mt-5 rounded-2xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">
                <Target className="h-4 w-4" />
                Acciones sugeridas
              </div>
              <div className="mt-3 space-y-2 text-sm text-slate-200">
                {data.actions.slice(0, 4).map(action => (
                  <div key={action} className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2">
                    {action}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="card p-5">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Ranking por agente</div>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-[0.16em] text-slate-500">
                  <th className="pb-2 pr-4">Agente</th>
                  <th className="pb-2 pr-4">Intentos</th>
                  <th className="pb-2 pr-4">Contactos</th>
                  <th className="pb-2 pr-4">Compras</th>
                  <th className="pb-2 pr-4">Rate contacto</th>
                  <th className="pb-2 pr-4">Rate compra</th>
                </tr>
              </thead>
              <tbody>
                {data.rankings.slice(0, role === 'executive' ? 12 : 30).map(row => (
                  <tr key={row.agent_name} className="border-b border-slate-900/70">
                    <td className="py-3 pr-4 font-medium text-white">{row.agent_name}</td>
                    <td className="py-3 pr-4 text-slate-200">{formatNumber(row.attempts)}</td>
                    <td className="py-3 pr-4 text-slate-200">{formatNumber(row.contacts)}</td>
                    <td className="py-3 pr-4 text-slate-200">{formatNumber(row.purchases)}</td>
                    <td className="py-3 pr-4 text-slate-300">{formatPercentage(row.contact_rate)}</td>
                    <td className="py-3 pr-4 text-slate-300">{formatPercentage(row.purchase_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {chartEnabled && <EquifaxCrmRoleCharts rankings={data.rankings} />}
      </div>
    </>
  )
}
