import { Header } from '@/components/layout/Header'
import { getCommercialOverview } from '@/lib/services/commercial-intelligence'
import { formatDatetime } from '@/lib/utils/formatters'

export const dynamic = 'force-dynamic'

function StatCard({
  label,
  value,
  accent = false,
}: {
  label: string
  value: string | number
  accent?: boolean
}) {
  return (
    <div className={`card p-5 ${accent ? 'border-cyan-500/20 bg-cyan-500/5' : ''}`}>
      <p className="text-[11px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-white">{value}</p>
    </div>
  )
}

export default async function InteligenciaComercialPage() {
  const overview = await getCommercialOverview()

  return (
    <>
      <Header
        title="Inteligencia Comercial"
        subtitle="Motor vivo de scoring, feedback operativo y priorización comercial"
      />

      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Proyecto A scorea y sirve; Proyecto B retroalimenta incrementalmente</span>
          <span>
            Último sync: {overview.last_feedback_sync ? formatDatetime(overview.last_feedback_sync) : 'sin sync'}
          </span>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Personas scoreadas" value={overview.total_scored_personas} accent />
          <StatCard label="Con feedback" value={overview.with_feedback} />
          <StatCard label="Alta prioridad" value={overview.high_priority_personas} />
          <StatCard label="Canal phone sugerido" value={overview.recommended_phone} />
          <StatCard label="Canal email sugerido" value={overview.recommended_email} />
          <StatCard label="Avg contactability" value={overview.avg_contactability_score.toFixed(1)} />
          <StatCard label="Avg propensity" value={overview.avg_purchase_propensity_score.toFixed(1)} />
          <StatCard label="Avg priority" value={overview.avg_priority_score.toFixed(1)} />
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="card p-5 xl:col-span-2">
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-white">Top oportunidades</h3>
              <p className="mt-1 text-xs text-slate-500">
                Ranking listo para operación, dashboard y futura activación automática.
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-3">RUT</th>
                    <th className="px-3 py-3">Priority</th>
                    <th className="px-3 py-3">Contactability</th>
                    <th className="px-3 py-3">Propensity</th>
                    <th className="px-3 py-3">Canal</th>
                    <th className="px-3 py-3">Hora</th>
                    <th className="px-3 py-3">Acción</th>
                    <th className="px-3 py-3">Actualizado</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.top_opportunities.map(item => (
                    <tr key={item.rutid} className="border-b border-slate-900/70 text-slate-300">
                      <td className="px-3 py-3 font-mono text-xs">{item.rutid}</td>
                      <td className="px-3 py-3 font-semibold text-cyan-300">{item.priority_score}</td>
                      <td className="px-3 py-3">{item.contactability_score}</td>
                      <td className="px-3 py-3">{item.purchase_propensity_score}</td>
                      <td className="px-3 py-3 capitalize">{item.best_channel}</td>
                      <td className="px-3 py-3">{item.best_contact_hour ?? '10'}:00</td>
                      <td className="px-3 py-3">{item.next_best_action}</td>
                      <td className="px-3 py-3 text-xs text-slate-500">{formatDatetime(item.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card p-5">
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-white">Runs de sincronización</h3>
              <p className="mt-1 text-xs text-slate-500">
                Trazabilidad de ingestión incremental desde `registro-intel`.
              </p>
            </div>

            <div className="space-y-3">
              {overview.recent_syncs.length > 0 ? overview.recent_syncs.map((run: Record<string, unknown>) => (
                <div key={String(run.id)} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-white">{String(run.source_name ?? 'registro_intel')}</span>
                    <span className="text-xs uppercase tracking-wider text-cyan-300">
                      {String(run.status ?? 'unknown')}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1 text-xs text-slate-500">
                    <div>Fetched: {String(run.records_fetched ?? 0)}</div>
                    <div>Loaded: {String(run.records_loaded ?? 0)}</div>
                    <div>Affected RUTs: {String(run.affected_ruts ?? 0)}</div>
                    <div>
                      Inicio: {run.started_at ? formatDatetime(String(run.started_at)) : '—'}
                    </div>
                  </div>
                </div>
              )) : (
                <p className="text-sm text-slate-500">Sin ejecuciones registradas todavía.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
