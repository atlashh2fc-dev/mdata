import { Suspense } from 'react'
import { Header } from '@/components/layout/Header'
import { getDashboardKPIs, getCoberturaData, getRecentActivity, getScoreDistribution, getStatsPorRegion } from '@/lib/services/dashboard'
import { KPIGrid } from '@/components/dashboard/KPIGrid'
import { CoberturaChart } from '@/components/dashboard/CoberturaChart'
import { ScoreDonutChart } from '@/components/dashboard/ScoreDonutChart'
import { RegionChart } from '@/components/dashboard/RegionChart'
import { ActivityFeed } from '@/components/dashboard/ActivityFeed'
import { LoadingState } from '@/components/ui/Spinner'
import { formatDatetime } from '@/lib/utils/formatters'
import { RefreshCw, Database } from 'lucide-react'

export const dynamic = 'force-dynamic'

async function DashboardContent() {
  const [stats, cobertura, scoreDist, regionStats, activity] = await Promise.all([
    getDashboardKPIs(),
    getCoberturaData(),
    getScoreDistribution(),
    getStatsPorRegion(10),
    getRecentActivity(8),
  ])

  return (
    <div className="p-6 space-y-6">
      {/* Stats refresh info */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Database className="w-3.5 h-3.5" />
          <span>Base de datos: ~9.5M RUTs únicos</span>
          <span className="text-slate-700">·</span>
          <span>Actualizado: {formatDatetime(stats.last_refreshed)}</span>
        </div>
        <form action="/api/dashboard" method="POST">
          <button
            formAction={async () => {
              'use server'
              const { refreshStats } = await import('@/lib/services/dashboard')
              await refreshStats()
            }}
            className="btn-secondary text-xs py-1.5 px-3"
          >
            <RefreshCw className="w-3 h-3" />
            Refrescar stats
          </button>
        </form>
      </div>

      {/* KPIs */}
      <KPIGrid stats={stats} />

      {/* Charts Row 1 */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <CoberturaChart items={cobertura} />
        <ScoreDonutChart data={scoreDist} />
      </div>

      {/* Charts Row 2 */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <RegionChart data={regionStats} />
        <div className="xl:col-span-1">
          <ActivityFeed items={activity as Parameters<typeof ActivityFeed>[0]['items']} />
        </div>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  return (
    <>
      <Header
        title="Dashboard"
        subtitle="Visión general del sistema de inteligencia de datos"
      />
      <Suspense fallback={<LoadingState text="Cargando KPIs..." />}>
        <DashboardContent />
      </Suspense>
    </>
  )
}
