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
    cyan: 'from-surface-muted border-primary/20 text-primary-ink',
    emerald: 'from-surface-muted border-success/20 text-success',
    amber: 'from-surface-muted border-warning/20 text-warning',
    rose: 'from-surface-muted border-danger/20 text-danger',
  }[accent]

  return (
    <div className={`card overflow-hidden border bg-gradient-to-br to-transparent p-5 ${accentClasses}`}>
      <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <div className="mt-3 text-3xl font-semibold text-foreground">{value}</div>
      <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
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
        ? 'border-success/20 bg-success-bg text-success'
        : 'border-danger/20 bg-danger-bg text-danger'
    }`}>
      {positive ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
      <span>{label}: {positive ? '+' : ''}{delta.toFixed(1)} pts vs baseline</span>
    </div>
  )
}

function ProgressRail({ value, tone = 'cyan' }: { value: number; tone?: 'cyan' | 'emerald' | 'amber' | 'rose' }) {
  const toneClass = {
    cyan: 'bg-primary',
    emerald: 'bg-success',
    amber: 'bg-warning',
    rose: 'bg-danger',
  }[tone]

  return (
    <div className="progress-bar mt-2">
      <div className={`progress-fill ${toneClass}`} style={{ width: `${Math.max(0, Math.min(value, 100))}%` }} />
    </div>
  )
}

function PropensityBadge({ color }: { color: 'green' | 'yellow' | 'red' | 'sin_score' }) {
  const classes = {
    green: 'border-success/30 bg-success-bg text-success',
    yellow: 'border-warning/30 bg-warning-bg text-warning',
    red: 'border-danger/30 bg-danger-bg text-danger',
    sin_score: 'border-border bg-surface-muted text-foreground',
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
            <h3 className="text-base font-semibold text-foreground">{campaign.campaign_name}</h3>
            <SeverityBadge severity={campaign.severity} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {campaign.underperformance_hours >= 3
              ? 'La regla crítica de 3 horas ya fue activada.'
              : 'Monitoreo intradía con baseline histórico por campaña y hora.'}
          </p>
        </div>

        <div className="text-right">
          <div className="text-2xl font-semibold text-foreground">{campaign.health_score}</div>
          <div className="text-xs text-muted-foreground">Health score</div>
        </div>
      </div>

      <ProgressRail value={campaign.health_score} tone={tone} />

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-border bg-background p-3">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Contactabilidad 3h</div>
          <div className="mt-1 text-lg font-semibold text-foreground">{formatPercentage(campaign.current_contact_rate)}</div>
          <div className="text-xs text-muted-foreground">Esperado {formatPercentage(campaign.baseline_contact_rate)}</div>
        </div>
        <div className="rounded-2xl border border-border bg-background p-3">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Conversión 3h</div>
          <div className="mt-1 text-lg font-semibold text-foreground">{formatPercentage(campaign.current_conversion_rate)}</div>
          <div className="text-xs text-muted-foreground">Esperado {formatPercentage(campaign.baseline_conversion_rate)}</div>
        </div>
        <div className="rounded-2xl border border-border bg-background p-3">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Fatiga</div>
          <div className="mt-1 text-lg font-semibold text-foreground">{campaign.fatigue_score}</div>
          <div className="text-xs text-muted-foreground">{formatNumber(campaign.attempts_3h)} intentos en 3h</div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <DeltaChip current={campaign.current_contact_rate} expected={campaign.baseline_contact_rate} label="Contacto" />
        <DeltaChip current={campaign.current_conversion_rate} expected={campaign.baseline_conversion_rate} label="Venta" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-2xl border border-border bg-background p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Causas probables</div>
          <div className="space-y-2 text-sm text-foreground">
            {campaign.probable_causes.map(cause => (
              <div key={cause} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" />
                <span>{cause}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-background p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Ajuste táctico</div>
          <div className="text-sm font-medium text-foreground">{campaign.recommended_action}</div>
          <div className="mt-3 space-y-2 text-xs text-muted-foreground">
            <div>Canal dominante: <span className="text-foreground">{campaign.top_channel ?? 'Sin señal'}</span></div>
            <div>Ventana sugerida: <span className="text-foreground">{campaign.best_next_window}</span></div>
            <div>Leads únicos 3h: <span className="text-foreground">{formatNumber(campaign.unique_leads_3h)}</span></div>
          </div>
          <div className="mt-3 space-y-2 text-xs text-foreground">
            {campaign.recommended_adjustments.slice(0, 2).map(item => (
              <div key={item} className="rounded-xl border border-primary/10 bg-surface-muted px-3 py-2">
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
        <Zap className="h-4 w-4 text-warning" />
        <h3 className="text-sm font-semibold text-foreground">Acciones del motor</h3>
      </div>
      <div className="space-y-3">
        {items.map(item => (
          <div key={`${item.scope}-${item.title}`} className="rounded-2xl border border-border bg-background p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-foreground">{item.title}</div>
              <span className={item.priority === 'high' ? 'badge-danger' : item.priority === 'medium' ? 'badge-warning' : 'badge-neutral'}>
                {item.priority}
              </span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{item.rationale}</p>
            <p className="mt-3 text-sm text-foreground">{item.action}</p>
            <p className="mt-2 text-xs text-primary-ink">{item.impact}</p>
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
        <Clock3 className="h-4 w-4 text-primary-ink" />
        <h3 className="text-sm font-semibold text-foreground">Ventanas óptimas</h3>
      </div>
      <div className="space-y-3">
        {windows.map(window => (
          <div key={window.label} className="rounded-2xl border border-border bg-background p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-foreground">{window.label}</div>
                <div className="text-xs text-muted-foreground">{formatNumber(window.attempts)} intentos históricos útiles</div>
              </div>
              <div className="text-right">
                <div className="text-lg font-semibold text-foreground">{window.score}</div>
                <div className="text-xs text-muted-foreground">window score</div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-foreground">
              <div>Contacto {formatPercentage(window.contact_rate)}</div>
              <div>Venta {formatPercentage(window.conversion_rate)}</div>
              <div>Interés {formatPercentage(window.interest_rate)}</div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">{window.recommendation}</p>
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
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>

      <div className="space-y-3">
        {items.map(item => (
          <div key={`${item.segment_type}-${item.segment_label}`} className="rounded-2xl border border-border bg-background p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-foreground">{item.segment_label}</div>
                <div className="text-xs text-muted-foreground">{item.segment_type} · {formatNumber(item.volume)} intentos</div>
              </div>
              <div className={`text-sm font-semibold ${tone === 'emerald' ? 'text-success' : 'text-danger'}`}>
                {item.health_delta > 0 ? '+' : ''}{item.health_delta}
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-foreground">
              <div>Contacto {formatPercentage(item.current_contact_rate)}</div>
              <div>Base {formatPercentage(item.baseline_contact_rate)}</div>
              <div>Conversión {formatPercentage(item.current_conversion_rate)}</div>
              <div>Base {formatPercentage(item.baseline_conversion_rate)}</div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">{item.recommendation}</p>
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
        <Target className="h-4 w-4 text-primary-ink" />
        <h3 className="text-sm font-semibold text-foreground">Priorización dinámica</h3>
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
                  <div className="font-medium text-foreground">{lead.nombre_completo ?? lead.rutid}</div>
                  <div className="text-xs text-muted-foreground">{lead.rutid}</div>
                  <div className="text-xs text-muted-foreground">{lead.region ?? 'Sin región'} · {lead.comuna ?? 'Sin comuna'}</div>
                </td>
                <td>{lead.campaign_name ?? 'Asignación dinámica'}</td>
                <td className="font-semibold text-primary-ink">{lead.dynamic_priority_score}</td>
                <td>{lead.contact_probability}</td>
                <td>{lead.conversion_probability}</td>
                <td>{lead.fatigue_score}</td>
                <td>{lead.optimal_window}</td>
                <td className="capitalize">{lead.recommended_channel}</td>
                <td>
                  <div className="text-sm text-foreground">{lead.next_best_action}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {lead.reason_tags.map(tag => (
                      <span key={tag} className="rounded-full bg-surface-muted px-2 py-0.5 text-[10px] text-muted-foreground">
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
          <Layers3 className="h-4 w-4 text-success" />
          <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">Base unificada sin contacto y no tocada</h2>
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

        <div className="rounded-2xl border border-border bg-background px-4 py-3 text-xs text-muted-foreground">
          Bases Dicom desde {summary.bases_from}: {formatNumber(summary.crm_base_rows)} filas revisadas. Se excluyeron {formatNumber(summary.excluded_contacted_rows)} filas contactadas, {formatNumber(summary.excluded_bad_number_rows)} por número malo y {formatNumber(summary.excluded_exception_rows)} por excepción.
        </div>

        <div className="grid gap-4 xl:grid-cols-[0.75fr_1.25fr]">
          <div className="card p-5">
            <div className="mb-4 flex items-center gap-2">
              <Target className="h-4 w-4 text-primary-ink" />
              <h3 className="text-sm font-semibold text-foreground">Resultado por semáforo</h3>
            </div>
            <div className="space-y-3">
              {summary.by_color.map(bucket => (
                <div key={bucket.color} className="rounded-2xl border border-border bg-background p-4">
                  <div className="flex items-center justify-between gap-3">
                    <PropensityBadge color={bucket.color} />
                    <div className="text-lg font-semibold text-foreground">{formatNumber(bucket.total)}</div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-foreground">
                    <div>Score {bucket.avg_lead_score}</div>
                    <div>Contacto {bucket.avg_contact_probability}</div>
                    <div>Compra {bucket.avg_purchase_probability}</div>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    No tocados: {formatNumber(bucket.untouched)} · Recorridos sin contacto: {formatNumber(bucket.recorridos_sin_contacto)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card p-5">
            <div className="mb-4 flex items-center gap-2">
              <Activity className="h-4 w-4 text-warning" />
              <h3 className="text-sm font-semibold text-foreground">Desglose por base origen</h3>
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
                      <td className="font-medium text-foreground">{row.base_name}</td>
                      <td>{formatNumber(row.total)}</td>
                      <td className="text-success">{formatNumber(row.green)}</td>
                      <td className="text-warning">{formatNumber(row.yellow)}</td>
                      <td className="text-danger">{formatNumber(row.red)}</td>
                      <td>{formatNumber(row.sin_score)}</td>
                      <td>{formatNumber(row.untouched)}</td>
                      <td>{formatNumber(row.recorridos_sin_contacto)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Generado: {formatDatetime(summary.generated_at)}. El cruce deduplica por RUT y excluye contactos efectivos previos.
            </p>
          </div>
        </div>
      </div>
    )
  } catch (error) {
    return (
      <div className="card p-5">
        <div className="text-sm font-semibold text-foreground">Base unificada sin contacto y no tocada</div>
        <p className="mt-2 text-sm text-muted-foreground">
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
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-primary/10 bg-gradient-to-r from-surface-muted via-surface to-transparent px-5 py-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <BrainCircuit className="h-4 w-4 text-primary-ink" />
              Loop unificado de inteligencia comercial
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Este proyecto scorea, aprende, detecta deterioro temprano y le entrega al CRM decisiones livianas para ejecutar.
            </p>
          </div>
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
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
          <div className="card overflow-hidden border border-success/10 bg-gradient-to-r from-surface-muted via-surface to-transparent p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Sparkles className="h-4 w-4 text-success" />
              Lectura ejecutiva de Inception
            </div>
            <p className="mt-3 max-w-5xl text-sm leading-6 text-foreground">{brain.ai_executive_summary}</p>
          </div>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-primary-ink" />
              <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">Campañas bajo control táctico</h2>
            </div>

            {brain.campaigns.length > 0 ? brain.campaigns.map(campaign => (
              <CampaignCard key={campaign.campaign_name} campaign={campaign} />
            )) : (
              <div className="card p-6 text-sm text-muted-foreground">
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
            icon={<TrendingUp className="h-4 w-4 text-success" />}
            items={brain.strong_segments}
            tone="emerald"
          />
          <SegmentColumn
            title="Segmentos débiles"
            icon={<TrendingDown className="h-4 w-4 text-danger" />}
            items={brain.weak_segments}
            tone="rose"
          />
        </div>

        <LeadTable leads={brain.lead_actions} />

        <UnifiedUntouchedUniverse />

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="card p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
              <Layers3 className="h-4 w-4 text-primary-ink" />
              Qué entrega al CRM
            </div>
            <div className="space-y-2 text-sm text-foreground">
              <div>Scores multidimensionales por lead, segmento y campaña.</div>
              <div>Alertas tempranas cuando una campaña rompe su baseline operativo.</div>
              <div>Ranking dinámico por bloque horario y recomendaciones concretas de secuencia, intensidad y ventana.</div>
            </div>
          </div>

          <div className="card p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
              <Activity className="h-4 w-4 text-warning" />
              Variables centrales del loop
            </div>
            <div className="space-y-2 text-sm text-foreground">
              <div>Probabilidad de contacto, probabilidad de conversión y afinidad operativa.</div>
              <div>Fatiga o desgaste, mejor ventana, mejor canal y feedback histórico real.</div>
              <div>Contexto interpretado por IA y diagnóstico de desvíos para no reaccionar tarde.</div>
            </div>
          </div>

          <div className="card p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
              <ArrowUpRight className="h-4 w-4 text-success" />
              Siguiente evolución natural
            </div>
            <div className="space-y-2 text-sm text-foreground">
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
