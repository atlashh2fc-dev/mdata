'use client'

import { useEffect, useState } from 'react'
import {
  Activity,
  BadgeDollarSign,
  Clock3,
  Mail,
  Phone,
  Sparkles,
  Star,
  Target,
} from 'lucide-react'
import { formatCurrency, formatDatetime } from '@/lib/utils/formatters'
import type { PersonaCommercialIntelligence } from '@/types'

function ScoreBar({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'cyan' | 'emerald' | 'amber'
}) {
  const colorClass = {
    cyan: 'bg-primary',
    emerald: 'bg-success',
    amber: 'bg-warning',
  }[tone]

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold text-foreground">{value}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
        <div className={`h-full rounded-full ${colorClass}`} style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
    </div>
  )
}

export function CommercialIntelligencePanel({ rut }: { rut: string }) {
  const [data, setData] = useState<PersonaCommercialIntelligence | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true

    async function load() {
      setLoading(true)
      setError(null)

      try {
        const response = await fetch(`/api/commercial-intelligence?rut=${encodeURIComponent(rut)}`)
        const json = await response.json()

        if (!response.ok || !json.success) {
          throw new Error(json.error ?? 'No fue posible cargar inteligencia comercial')
        }

        if (mounted) setData(json.data)
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : 'Error cargando inteligencia')
      } finally {
        if (mounted) setLoading(false)
      }
    }

    load()
    return () => {
      mounted = false
    }
  }, [rut])

  if (loading) {
    return (
      <div className="card p-5">
        <div className="text-sm text-muted-foreground">Cargando inteligencia comercial...</div>
      </div>
    )
  }

  if (error || !data?.score) {
    return (
      <div className="card p-5">
        <div className="text-sm text-muted-foreground">
          {error ?? 'Aún no hay score comercial disponible para este RUT.'}
        </div>
      </div>
    )
  }

  const { score, history, contact_points } = data
  const signals = score.signal_summary ?? {}

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Sparkles className="h-4 w-4 text-primary-ink" />
              Inteligencia comercial
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Contactabilidad, propensión y siguiente mejor acción.
            </p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-foreground">{score.priority_score}</div>
            <div className="text-xs text-muted-foreground">Prioridad comercial</div>
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          <div className="space-y-3">
            <ScoreBar label="Contactability Score" value={score.contactability_score} tone="cyan" />
            <ScoreBar label="Purchase Propensity" value={score.purchase_propensity_score} tone="emerald" />
            <ScoreBar label="Priority Score" value={score.priority_score} tone="amber" />
          </div>

          <div className="space-y-2 rounded-2xl border border-border bg-background p-4 text-sm">
            <div className="flex items-center gap-2 text-foreground">
              <Target className="h-4 w-4 text-primary-ink" />
              <span>Next Best Action: <strong>{score.next_best_action}</strong></span>
            </div>
            <div className="flex items-center gap-2 text-foreground">
              {score.best_channel === 'email' ? (
                <Mail className="h-4 w-4 text-success" />
              ) : (
                <Phone className="h-4 w-4 text-success" />
              )}
              <span>Canal sugerido: <strong>{score.best_channel}</strong></span>
            </div>
            <div className="flex items-center gap-2 text-foreground">
              <Clock3 className="h-4 w-4 text-warning" />
              <span>Mejor horario: <strong>{score.best_contact_hour ?? '10'}:00</strong></span>
            </div>
            <div className="flex items-center gap-2 text-foreground">
              <Activity className="h-4 w-4 text-violet" />
              <span>Prioridad operativa: <strong>{score.action_priority}</strong></span>
            </div>
            {score.best_phone && (
              <div className="text-xs text-muted-foreground">Teléfono sugerido: {score.best_phone}</div>
            )}
            {score.best_email && (
              <div className="text-xs text-muted-foreground">Email sugerido: {score.best_email}</div>
            )}
          </div>

          <div className="rounded-2xl border border-border bg-background p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
              <Star className="h-4 w-4 text-warning" />
              Señales relevantes
            </div>
            <div className="space-y-2 text-xs text-muted-foreground">
              <div>Cobertura feedback: {score.feedback_coverage ? 'Sí' : 'No'}</div>
              <div>Interacciones: {score.total_interactions}</div>
              <div>Contactos efectivos: {score.effective_contacts}</div>
              <div>Interés detectado: {score.interest_events}</div>
              <div>Callbacks: {score.callback_events}</div>
              <div>Ventas: {score.sales_events}</div>
              <div>Mejores gestiones: {score.best_management_events}</div>
              <div>Score patrimonial base: {String(signals.score_patrimonial ?? '0')}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="card p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Activity className="h-4 w-4 text-primary-ink" />
            Historial resumido de gestiones
          </div>
          <div className="space-y-3">
            {history.length === 0 && (
              <div className="text-sm text-muted-foreground">Sin feedback operativo aún.</div>
            )}
            {history.slice(0, 8).map(event => (
              <div key={event.id} className="rounded-xl border border-border bg-background p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm text-foreground">
                    {event.outcome}
                    {event.outcome_subtype ? ` · ${event.outcome_subtype}` : ''}
                  </div>
                  <div className="text-xs text-muted-foreground">{formatDatetime(event.managed_at)}</div>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {event.channel} · {event.campaign_name ?? 'Sin campaña'} · {event.agent_name ?? 'Sin agente'}
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-foreground">
                  {event.effective_contact && <span className="rounded-full bg-surface-muted px-2 py-1 text-primary-ink">Contacto efectivo</span>}
                  {event.interested && <span className="rounded-full bg-success-bg px-2 py-1 text-success">Interés</span>}
                  {event.sale && <span className="rounded-full bg-warning-bg px-2 py-1 text-warning">Venta</span>}
                  {event.mail_opened && <span className="rounded-full bg-surface-muted px-2 py-1 text-primary-ink">Mail opened</span>}
                  {event.clicked && <span className="rounded-full bg-violet-bg px-2 py-1 text-violet">Clicked</span>}
                  {event.callback_requested && <span className="rounded-full bg-warning-bg px-2 py-1 text-warning">Callback</span>}
                  {event.is_best_management && <span className="rounded-full bg-violet-bg px-2 py-1 text-violet">Mejor gestión</span>}
                </div>
                {event.value_amount ? (
                  <div className="mt-2 text-xs text-muted-foreground">
                    Valor: {formatCurrency(event.value_amount)}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <div className="card p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <BadgeDollarSign className="h-4 w-4 text-success" />
            Cobertura de feedback
          </div>
          <div className="space-y-3">
            <div className="rounded-xl border border-border bg-background p-4">
              <div className="text-xs text-muted-foreground">Puntos de contacto conocidos</div>
              <div className="mt-2 text-lg font-semibold text-foreground">{contact_points.length}</div>
            </div>
            {contact_points.slice(0, 6).map(point => {
              const executiveName = typeof point.metadata?.nombre_ejecutivo === 'string'
                ? point.metadata.nombre_ejecutivo
                : null
              const executiveRole = typeof point.metadata?.cargo === 'string'
                ? point.metadata.cargo
                : null

              return (
                <div key={point.id} className="rounded-xl border border-border bg-background p-3 text-xs text-foreground">
                  <div className="font-medium text-foreground">{point.contact_value}</div>
                  <div className="mt-1 text-muted-foreground">
                    {point.contact_type} · {point.source_name} · calidad {point.quality_score}
                  </div>
                  {executiveName && (
                    <div className="mt-2 text-muted-foreground">
                      {executiveName}
                      {executiveRole ? ` · ${executiveRole}` : ''}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
