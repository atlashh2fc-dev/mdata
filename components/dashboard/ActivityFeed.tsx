'use client'

import { formatRelativeTime, formatNumber } from '@/lib/utils/formatters'
import { StatusBadge } from '@/components/ui/StatusBadge'
import type { IngestionStatus } from '@/types'

interface ActivityItem {
  id: string
  file_name: string | null
  status: string
  total_rows: number
  valid_rows: number
  new_rows: number
  created_at: string
  data_sources?: { name: string } | null
}

interface ActivityFeedProps {
  items: ActivityItem[]
}

export function ActivityFeed({ items }: ActivityFeedProps) {
  if (items.length === 0) {
    return (
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-slate-200 mb-4">Actividad reciente</h3>
        <p className="text-sm text-slate-500 text-center py-8">No hay actividad reciente</p>
      </div>
    )
  }

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-slate-200 mb-4">Actividad reciente</h3>
      <div className="space-y-3">
        {items.map(item => (
          <div
            key={item.id}
            className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.02] border border-[#253357]/50"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <p className="text-xs font-medium text-slate-300 truncate">
                  {item.file_name ?? item.data_sources?.name ?? 'Archivo sin nombre'}
                </p>
                <StatusBadge status={item.status as IngestionStatus} />
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-600">
                <span>{formatNumber(item.total_rows)} filas</span>
                <span>·</span>
                <span>{formatNumber(item.valid_rows)} válidas</span>
                {item.new_rows > 0 && (
                  <>
                    <span>·</span>
                    <span className="text-green-500">+{formatNumber(item.new_rows)} nuevos</span>
                  </>
                )}
              </div>
            </div>
            <p className="text-[10px] text-slate-600 flex-shrink-0">
              {formatRelativeTime(item.created_at)}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
