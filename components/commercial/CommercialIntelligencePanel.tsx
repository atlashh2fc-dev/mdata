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
    cyan: 'bg-cyan-400',
    emerald: 'bg-emerald-400',
    amber: 'bg-amber-400',
  }[tone]

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className="font-semibold text-white">{value}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-800">
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
        <div className="text-sm text-slate-400">Cargando inteligencia comercial...</div>
      </div>
    )
  }

  if (error || !data?.score) {
    return (
      <div className="card p-5">
        <div className="text-sm text-slate-400">
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
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
              <Sparkles className="h-4 w-4 text-cyan-400" />
              Inteligencia comercial
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              Contactabilidad, propensión y siguiente mejor acción.
            </p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-white">{score.priority_score}</div>
            <div className="text-xs text-slate-500">Prioridad comercial</div>
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          <div className="space-y-3">
            <ScoreBar label="Contactability Score" value={score.contactability_score} tone="cyan" />
            <ScoreBar label="Purchase Propensity" value={score.purchase_propensity_score} tone="emerald" />
            <ScoreBar label="Priority Score" value={score.priority_score} tone="amber" />
          </div>

          <div className="space-y-2 rounded-2xl border border-slate-800 bg-slate-950/40 p-4 text-sm">
            <div className="flex items-center gap-2 text-slate-300">
              <Target className="h-4 w-4 text-cyan-400" />
              <span>Next Best Action: <strong>{score.next_best_action}</strong></span>
            </div>
            <div className="flex items-center gap-2 text-slate-300">
              {score.best_channel === 'email' ? (
                <Mail className="h-4 w-4 text-emerald-400" />
              ) : (
                <Phone className="h-4 w-4 text-emerald-400" />
              )}
              <span>Canal sugerido: <strong>{score.best_channel}</strong></span>
            </div>
            <div className="flex items-center gap-2 text-slate-300">
              <Clock3 className="h-4 w-4 text-amber-400" />
              <span>Mejor horario: <strong>{score.best_contact_hour ?? '10'}:00</strong></span>
            </div>
            <div className="flex items-center gap-2 text-slate-300">
              <Activity className="h-4 w-4 text-violet-400" />
              <span>Prioridad operativa: <strong>{score.action_priority}</strong></span>
            </div>
            {score.best_phone && (
              <div className="text-xs text-slate-400">Teléfono sugerido: {score.best_phone}</div>
            )}
            {score.best_email && (
              <div className="text-xs text-slate-400">Email sugerido: {score.best_email}</div>
            )}
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
              <Star className="h-4 w-4 text-amber-400" />
              Señales relevantes
            </div>
            <div className="space-y-2 text-xs text-slate-400">
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
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
            <Activity className="h-4 w-4 text-cyan-400" />
            Historial resumido de gestiones
          </div>
          <div className="space-y-3">
            {history.length === 0 && (
              <div className="text-sm text-slate-500">Sin feedback operativo aún.</div>
            )}
            {history.slice(0, 8).map(event => (
              <div key={event.id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm text-slate-200">
                    {event.outcome}
                    {event.outcome_subtype ? ` · ${event.outcome_subtype}` : ''}
                  </div>
                  <div className="text-xs text-slate-500">{formatDatetime(event.managed_at)}</div>
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  {event.channel} · {event.campaign_name ?? 'Sin campaña'} · {event.agent_name ?? 'Sin agente'}
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-300">
                  {event.effective_contact && <span className="rounded-full bg-cyan-500/10 px-2 py-1 text-cyan-300">Contacto efectivo</span>}
                  {event.interested && <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-emerald-300">Interés</span>}
                  {event.sale && <span className="rounded-full bg-amber-500/10 px-2 py-1 text-amber-300">Venta</span>}
                  {event.mail_opened && <span className="rounded-full bg-sky-500/10 px-2 py-1 text-sky-300">Mail opened</span>}
                  {event.clicked && <span className="rounded-full bg-violet-500/10 px-2 py-1 text-violet-300">Clicked</span>}
                  {event.callback_requested && <span className="rounded-full bg-orange-500/10 px-2 py-1 text-orange-300">Callback</span>}
                  {event.is_best_management && <span className="rounded-full bg-fuchsia-500/10 px-2 py-1 text-fuchsia-300">Mejor gestión</span>}
                </div>
                {event.value_amount ? (
                  <div className="mt-2 text-xs text-slate-400">
                    Valor: {formatCurrency(event.value_amount)}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <div className="card p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
            <BadgeDollarSign className="h-4 w-4 text-emerald-400" />
            Cobertura de feedback
          </div>
          <div className="space-y-3">
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
              <div className="text-xs text-slate-500">Puntos de contacto conocidos</div>
              <div className="mt-2 text-lg font-semibold text-white">{contact_points.length}</div>
            </div>
            {contact_points.slice(0, 6).map(point => {
              const executiveName = typeof point.metadata?.nombre_ejecutivo === 'string'
                ? point.metadata.nombre_ejecutivo
                : null
              const executiveRole = typeof point.metadata?.cargo === 'string'
                ? point.metadata.cargo
                : null

              return (
                <div key={point.id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-300">
                  <div className="font-medium text-white">{point.contact_value}</div>
                  <div className="mt-1 text-slate-500">
                    {point.contact_type} · {point.source_name} · calidad {point.quality_score}
                  </div>
                  {executiveName && (
                    <div className="mt-2 text-slate-400">
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
