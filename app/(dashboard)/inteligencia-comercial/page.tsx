import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BrainCircuit,
  Clock3,
  Gauge,
  Layers3,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  Zap,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Header } from '@/components/layout/Header'
import { getCommercialBrainOverview } from '@/lib/services/commercial-brain'
import { getCommercialOverview } from '@/lib/services/commercial-intelligence'
import { getUnifiedCrmUntouchedPropensitySummary } from '@/lib/services/crm-unified-bases'
import { formatDatetime, formatNumber, formatPercentage } from '@/lib/utils/formatters'
import type { CampaignHealthCard, LeadActionItem, SegmentHealthInsight, TacticalRecommendation, WindowPerformance } from '@/types'

export const dynamic = 'force-dynamic'

function StatCard({
  label,
  value,
  hint,
  accent = 'cyan',
}: {
  label: string
  value: string | number
  hint: string
  accent?: 'cyan' | 'emerald' | 'amber' | 'rose'
}) {
  const accentClasses = {
    cyan: 'from-cyan-500/15 border-cyan-500/20 text-cyan-300',
    emerald: 'from-emerald-500/15 border-emerald-500/20 text-emerald-300',
    amber: 'from-amber-500/15 border-amber-500/20 text-amber-300',
    rose: 'from-rose-500/15 border-rose-500/20 text-rose-300',
  }[accent]

  return (
    <div className={`card overflow-hidden border bg-gradient-to-br to-transparent p-5 ${accentClasses}`}>
      <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <div className="mt-3 text-3xl font-semibold text-white">{value}</div>
      <p className="mt-2 text-xs text-slate-400">{hint}</p>
    </div>
  )
}

function SeverityBadge({ severity }: { severity: CampaignHealthCard['severity'] }) {
  const classes = {
    healthy: 'badge-success',
    watch: 'badge-info',
    risk: 'badge-warning',
    critical: 'badge-danger',
  }[severity]

  const label = {
    healthy: 'Saludable',
    watch: 'Vigilancia',
    risk: 'Riesgo',
    critical: 'Crítica',
  }[severity]

  return <span className={classes}>{label}</span>
}

function DeltaChip({
  current,
  expected,
  label,
}: {
  current: number
  expected: number
  label: string
}) {
  const delta = current - expected
  const positive = delta >= 0

  return (
    <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
      positive
        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
        : 'border-rose-500/20 bg-rose-500/10 text-rose-300'
    }`}>
      {positive ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
      <span>{label}: {positive ? '+' : ''}{delta.toFixed(1)} pts vs baseline</span>
    </div>
  )
}

function ProgressRail({ value, tone = 'cyan' }: { value: number; tone?: 'cyan' | 'emerald' | 'amber' | 'rose' }) {
  const toneClass = {
    cyan: 'bg-cyan-400',
    emerald: 'bg-emerald-400',
    amber: 'bg-amber-400',
    rose: 'bg-rose-400',
  }[tone]

  return (
    <div className="progress-bar mt-2">
      <div className={`progress-fill ${toneClass}`} style={{ width: `${Math.max(0, Math.min(value, 100))}%` }} />
    </div>
  )
}

function PropensityBadge({ color }: { color: 'green' | 'yellow' | 'red' | 'sin_score' }) {
  const classes = {
    green: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    yellow: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    red: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
    sin_score: 'border-slate-700 bg-slate-800/60 text-slate-300',
  }[color]

  const label = {
    green: 'Verde',
    yellow: 'Amarillo',
    red: 'Rojo',
    sin_score: 'Sin score',
  }[color]

  return <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${classes}`}>{label}</span>
}

function CampaignCard({ campaign }: { campaign: CampaignHealthCard }) {
  const tone = campaign.severity === 'critical'
    ? 'rose'
    : campaign.severity === 'risk'
      ? 'amber'
      : campaign.severity === 'watch'
        ? 'cyan'
        : 'emerald'

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-white">{campaign.campaign_name}</h3>
            <SeverityBadge severity={campaign.severity} />
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {campaign.underperformance_hours >= 3
              ? 'La regla crítica de 3 horas ya fue activada.'
              : 'Monitoreo intradía con baseline histórico por campaña y hora.'}
          </p>
        </div>

        <div className="text-right">
          <div className="text-2xl font-semibold text-white">{campaign.health_score}</div>
          <div className="text-xs text-slate-500">Health score</div>
        </div>
      </div>

      <ProgressRail value={campaign.health_score} tone={tone} />

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Contactabilidad 3h</div>
          <div className="mt-1 text-lg font-semibold text-white">{formatPercentage(campaign.current_contact_rate)}</div>
          <div className="text-xs text-slate-500">Esperado {formatPercentage(campaign.baseline_contact_rate)}</div>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Conversión 3h</div>
          <div className="mt-1 text-lg font-semibold text-white">{formatPercentage(campaign.current_conversion_rate)}</div>
          <div className="text-xs text-slate-500">Esperado {formatPercentage(campaign.baseline_conversion_rate)}</div>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">Fatiga</div>
          <div className="mt-1 text-lg font-semibold text-white">{campaign.fatigue_score}</div>
          <div className="text-xs text-slate-500">{formatNumber(campaign.attempts_3h)} intentos en 3h</div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <DeltaChip current={campaign.current_contact_rate} expected={campaign.baseline_contact_rate} label="Contacto" />
        <DeltaChip current={campaign.current_conversion_rate} expected={campaign.baseline_conversion_rate} label="Venta" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Causas probables</div>
          <div className="space-y-2 text-sm text-slate-300">
            {campaign.probable_causes.map(cause => (
              <div key={cause} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
                <span>{cause}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Ajuste táctico</div>
          <div className="text-sm font-medium text-white">{campaign.recommended_action}</div>
          <div className="mt-3 space-y-2 text-xs text-slate-400">
            <div>Canal dominante: <span className="text-slate-200">{campaign.top_channel ?? 'Sin señal'}</span></div>
            <div>Ventana sugerida: <span className="text-slate-200">{campaign.best_next_window}</span></div>
            <div>Leads únicos 3h: <span className="text-slate-200">{formatNumber(campaign.unique_leads_3h)}</span></div>
          </div>
          <div className="mt-3 space-y-2 text-xs text-slate-300">
            {campaign.recommended_adjustments.slice(0, 2).map(item => (
              <div key={item} className="rounded-xl border border-cyan-500/10 bg-cyan-500/5 px-3 py-2">
                {item}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function RecommendationList({ items }: { items: TacticalRecommendation[] }) {
  return (
    <div className="card p-5">
      <div className="mb-4 flex items-center gap-2">
        <Zap className="h-4 w-4 text-amber-400" />
        <h3 className="text-sm font-semibold text-white">Acciones del motor</h3>
      </div>
      <div className="space-y-3">
        {items.map(item => (
          <div key={`${item.scope}-${item.title}`} className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-white">{item.title}</div>
              <span className={item.priority === 'high' ? 'badge-danger' : item.priority === 'medium' ? 'badge-warning' : 'badge-neutral'}>
                {item.priority}
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-400">{item.rationale}</p>
            <p className="mt-3 text-sm text-slate-200">{item.action}</p>
            <p className="mt-2 text-xs text-cyan-300">{item.impact}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function WindowList({ windows }: { windows: WindowPerformance[] }) {
  return (
    <div className="card p-5">
      <div className="mb-4 flex items-center gap-2">
        <Clock3 className="h-4 w-4 text-cyan-400" />
        <h3 className="text-sm font-semibold text-white">Ventanas óptimas</h3>
      </div>
      <div className="space-y-3">
        {windows.map(window => (
          <div key={window.label} className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-white">{window.label}</div>
                <div className="text-xs text-slate-500">{formatNumber(window.attempts)} intentos históricos útiles</div>
              </div>
              <div className="text-right">
                <div className="text-lg font-semibold text-white">{window.score}</div>
                <div className="text-xs text-slate-500">window score</div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-slate-300">
              <div>Contacto {formatPercentage(window.contact_rate)}</div>
              <div>Venta {formatPercentage(window.conversion_rate)}</div>
              <div>Interés {formatPercentage(window.interest_rate)}</div>
            </div>
            <p className="mt-3 text-xs text-slate-400">{window.recommendation}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function SegmentColumn({
  title,
  icon,
  items,
  tone,
}: {
  title: string
  icon: ReactNode
  items: SegmentHealthInsight[]
  tone: 'emerald' | 'rose'
}) {
  return (
    <div className="card p-5">
      <div className="mb-4 flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-semibold text-white">{title}</h3>
      </div>

      <div className="space-y-3">
        {items.map(item => (
          <div key={`${item.segment_type}-${item.segment_label}`} className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-white">{item.segment_label}</div>
                <div className="text-xs text-slate-500">{item.segment_type} · {formatNumber(item.volume)} intentos</div>
              </div>
              <div className={`text-sm font-semibold ${tone === 'emerald' ? 'text-emerald-300' : 'text-rose-300'}`}>
                {item.health_delta > 0 ? '+' : ''}{item.health_delta}
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-300">
              <div>Contacto {formatPercentage(item.current_contact_rate)}</div>
              <div>Base {formatPercentage(item.baseline_contact_rate)}</div>
              <div>Conversión {formatPercentage(item.current_conversion_rate)}</div>
              <div>Base {formatPercentage(item.baseline_conversion_rate)}</div>
            </div>
            <p className="mt-3 text-xs text-slate-400">{item.recommendation}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function LeadTable({ leads }: { leads: LeadActionItem[] }) {
  return (
    <div className="card p-5">
      <div className="mb-4 flex items-center gap-2">
        <Target className="h-4 w-4 text-cyan-400" />
        <h3 className="text-sm font-semibold text-white">Priorización dinámica</h3>
      </div>

      <div className="overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Lead</th>
              <th>Campaña</th>
              <th>Score dinámico</th>
              <th>Contacto</th>
              <th>Conversión</th>
              <th>Fatiga</th>
              <th>Ventana</th>
              <th>Canal</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            {leads.map(lead => (
              <tr key={lead.rutid}>
                <td>
                  <div className="font-medium text-white">{lead.nombre_completo ?? lead.rutid}</div>
                  <div className="text-xs text-slate-500">{lead.rutid}</div>
                  <div className="text-xs text-slate-500">{lead.region ?? 'Sin región'} · {lead.comuna ?? 'Sin comuna'}</div>
                </td>
                <td>{lead.campaign_name ?? 'Asignación dinámica'}</td>
                <td className="font-semibold text-cyan-300">{lead.dynamic_priority_score}</td>
                <td>{lead.contact_probability}</td>
                <td>{lead.conversion_probability}</td>
                <td>{lead.fatigue_score}</td>
                <td>{lead.optimal_window}</td>
                <td className="capitalize">{lead.recommended_channel}</td>
                <td>
                  <div className="text-sm text-slate-200">{lead.next_best_action}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {lead.reason_tags.map(tag => (
                      <span key={tag} className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">
                        {tag}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

async function UnifiedUntouchedUniverse() {
  try {
    const summary = await getUnifiedCrmUntouchedPropensitySummary()

    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Layers3 className="h-4 w-4 text-emerald-400" />
          <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-400">Base unificada sin contacto y no tocada</h2>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-7">
          <StatCard
            label="Universo único"
            value={formatNumber(summary.unique_universe)}
            hint={`${formatNumber(summary.untouched_unique)} no tocados`}
            accent="emerald"
          />
          <StatCard
            label="Filas elegibles"
            value={formatNumber(summary.eligible_rows_before_dedupe)}
            hint={`${formatNumber(summary.duplicate_rows_removed)} duplicados removidos`}
            accent="cyan"
          />
          <StatCard
            label="Recorridos"
            value={formatNumber(summary.recorridos_sin_contacto)}
            hint="Discado sin contacto real"
            accent="amber"
          />
          <StatCard
            label="Verdes"
            value={formatNumber(summary.green)}
            hint="Alta propensión Equifax"
            accent="emerald"
          />
          <StatCard
            label="Amarillos"
            value={formatNumber(summary.yellow)}
            hint="Madurar con secuencia"
            accent="amber"
          />
          <StatCard
            label="Rojos"
            value={formatNumber(summary.red)}
            hint="Baja prioridad comercial"
            accent="rose"
          />
          <StatCard
            label="Sin score"
            value={formatNumber(summary.sin_score)}
            hint={`${formatNumber(summary.scored)} cruzaron con modelo`}
            accent="cyan"
          />
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-xs text-slate-400">
          Bases Dicom desde {summary.bases_from}: {formatNumber(summary.crm_base_rows)} filas revisadas. Se excluyeron {formatNumber(summary.excluded_contacted_rows)} filas contactadas, {formatNumber(summary.excluded_bad_number_rows)} por número malo y {formatNumber(summary.excluded_exception_rows)} por excepción.
        </div>

        <div className="grid gap-4 xl:grid-cols-[0.75fr_1.25fr]">
          <div className="card p-5">
            <div className="mb-4 flex items-center gap-2">
              <Target className="h-4 w-4 text-cyan-400" />
              <h3 className="text-sm font-semibold text-white">Resultado por semáforo</h3>
            </div>
            <div className="space-y-3">
              {summary.by_color.map(bucket => (
                <div key={bucket.color} className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <PropensityBadge color={bucket.color} />
                    <div className="text-lg font-semibold text-white">{formatNumber(bucket.total)}</div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-slate-300">
                    <div>Score {bucket.avg_lead_score}</div>
                    <div>Contacto {bucket.avg_contact_probability}</div>
                    <div>Compra {bucket.avg_purchase_probability}</div>
                  </div>
                  <div className="mt-2 text-xs text-slate-500">
                    No tocados: {formatNumber(bucket.untouched)} · Recorridos sin contacto: {formatNumber(bucket.recorridos_sin_contacto)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card p-5">
            <div className="mb-4 flex items-center gap-2">
              <Activity className="h-4 w-4 text-amber-400" />
              <h3 className="text-sm font-semibold text-white">Desglose por base origen</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Base</th>
                    <th>Total único</th>
                    <th>Verde</th>
                    <th>Amarillo</th>
                    <th>Rojo</th>
                    <th>Sin score</th>
                    <th>No tocados</th>
                    <th>Recorridos</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.by_base.slice(0, 12).map(row => (
                    <tr key={row.base_name}>
                      <td className="font-medium text-white">{row.base_name}</td>
                      <td>{formatNumber(row.total)}</td>
                      <td className="text-emerald-300">{formatNumber(row.green)}</td>
                      <td className="text-amber-300">{formatNumber(row.yellow)}</td>
                      <td className="text-rose-300">{formatNumber(row.red)}</td>
                      <td>{formatNumber(row.sin_score)}</td>
                      <td>{formatNumber(row.untouched)}</td>
                      <td>{formatNumber(row.recorridos_sin_contacto)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Generado: {formatDatetime(summary.generated_at)}. El cruce deduplica por RUT y excluye contactos efectivos previos.
            </p>
          </div>
        </div>
      </div>
    )
  } catch (error) {
    return (
      <div className="card p-5">
        <div className="text-sm font-semibold text-white">Base unificada sin contacto y no tocada</div>
        <p className="mt-2 text-sm text-slate-400">
          {error instanceof Error ? error.message : 'No fue posible calcular el universo unificado.'}
        </p>
      </div>
    )
  }
}

export default async function InteligenciaComercialPage() {
  const [overview, brain] = await Promise.all([
    getCommercialOverview(),
    getCommercialBrainOverview(),
  ])

  return (
    <>
      <Header
        title="Inteligencia Comercial"
        subtitle="Cerebro operativo para campañas, contactabilidad, scoring dinámico y corrección táctica"
      />

      <div className="space-y-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-cyan-500/10 bg-gradient-to-r from-cyan-500/10 via-slate-950/20 to-transparent px-5 py-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-white">
              <BrainCircuit className="h-4 w-4 text-cyan-400" />
              Loop unificado de inteligencia comercial
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Este proyecto scorea, aprende, detecta deterioro temprano y le entrega al CRM decisiones livianas para ejecutar.
            </p>
          </div>
          <div className="flex flex-wrap gap-4 text-xs text-slate-400">
            <span>Último sync: {overview.last_feedback_sync ? formatDatetime(overview.last_feedback_sync) : 'sin sync'}</span>
            <span>Última señal: {brain.snapshot.last_feedback_at ? formatDatetime(brain.snapshot.last_feedback_at) : 'sin feedback'}</span>
            <span>Generado: {formatDatetime(brain.generated_at)}</span>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <StatCard
            label="Salud Operativa"
            value={brain.snapshot.overall_health_score}
            hint={`${brain.snapshot.campaigns_at_risk} campañas en riesgo o crítica`}
            accent={brain.snapshot.critical_campaigns > 0 ? 'rose' : 'cyan'}
          />
          <StatCard
            label="Campañas Activas"
            value={brain.snapshot.active_campaigns}
            hint={`${brain.snapshot.anomaly_count} desvíos tempranos monitoreados`}
            accent="amber"
          />
          <StatCard
            label="Contacto Actual"
            value={formatPercentage(brain.snapshot.current_contact_rate)}
            hint={`Baseline ${formatPercentage(brain.snapshot.expected_contact_rate)}`}
            accent={brain.snapshot.current_contact_rate >= brain.snapshot.expected_contact_rate ? 'emerald' : 'rose'}
          />
          <StatCard
            label="Conversión Actual"
            value={formatPercentage(brain.snapshot.current_conversion_rate)}
            hint={`Baseline ${formatPercentage(brain.snapshot.expected_conversion_rate)}`}
            accent={brain.snapshot.current_conversion_rate >= brain.snapshot.expected_conversion_rate ? 'emerald' : 'amber'}
          />
          <StatCard
            label="Base Scoreada"
            value={formatNumber(overview.total_scored_personas)}
            hint={`${formatNumber(overview.high_priority_personas)} leads ya están en alta prioridad`}
            accent="cyan"
          />
        </div>

        {brain.ai_executive_summary ? (
          <div className="card overflow-hidden border border-emerald-500/10 bg-gradient-to-r from-emerald-500/10 via-slate-950/10 to-transparent p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <Sparkles className="h-4 w-4 text-emerald-400" />
              Lectura ejecutiva de Inception
            </div>
            <p className="mt-3 max-w-5xl text-sm leading-6 text-slate-200">{brain.ai_executive_summary}</p>
          </div>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-cyan-400" />
              <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-400">Campañas bajo control táctico</h2>
            </div>

            {brain.campaigns.length > 0 ? brain.campaigns.map(campaign => (
              <CampaignCard key={campaign.campaign_name} campaign={campaign} />
            )) : (
              <div className="card p-6 text-sm text-slate-400">
                Aún no hay campañas activas suficientes para construir vigilancia táctica.
              </div>
            )}
          </div>

          <div className="space-y-4">
            <RecommendationList items={brain.recommendations} />
            <WindowList windows={brain.optimal_windows} />
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <SegmentColumn
            title="Segmentos fuertes"
            icon={<TrendingUp className="h-4 w-4 text-emerald-400" />}
            items={brain.strong_segments}
            tone="emerald"
          />
          <SegmentColumn
            title="Segmentos débiles"
            icon={<TrendingDown className="h-4 w-4 text-rose-400" />}
            items={brain.weak_segments}
            tone="rose"
          />
        </div>

        <LeadTable leads={brain.lead_actions} />

        <UnifiedUntouchedUniverse />

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="card p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
              <Layers3 className="h-4 w-4 text-cyan-400" />
              Qué entrega al CRM
            </div>
            <div className="space-y-2 text-sm text-slate-300">
              <div>Scores multidimensionales por lead, segmento y campaña.</div>
              <div>Alertas tempranas cuando una campaña rompe su baseline operativo.</div>
              <div>Ranking dinámico por bloque horario y recomendaciones concretas de secuencia, intensidad y ventana.</div>
            </div>
          </div>

          <div className="card p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
              <Activity className="h-4 w-4 text-amber-400" />
              Variables centrales del loop
            </div>
            <div className="space-y-2 text-sm text-slate-300">
              <div>Probabilidad de contacto, probabilidad de conversión y afinidad operativa.</div>
              <div>Fatiga o desgaste, mejor ventana, mejor canal y feedback histórico real.</div>
              <div>Contexto interpretado por IA y diagnóstico de desvíos para no reaccionar tarde.</div>
            </div>
          </div>

          <div className="card p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
              <ArrowUpRight className="h-4 w-4 text-emerald-400" />
              Siguiente evolución natural
            </div>
            <div className="space-y-2 text-sm text-slate-300">
              <div>Persistir snapshots tácticos por bloque para backtesting y aprendizaje continuo.</div>
              <div>Incorporar afinidad agente-estrategia y elasticidad de intensidad por cohorte.</div>
              <div>Publicar recomendaciones al CRM como feed operacional listo para ejecución.</div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
