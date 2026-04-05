'use client'

import type { CoberturaItem } from '@/types'
import { formatNumber, formatPercentage } from '@/lib/utils/formatters'

interface CoberturaChartProps {
  items: CoberturaItem[]
}

const COLOR_MAP: Record<string, string> = {
  nombres:       'bg-blue-500',
  email:         'bg-green-500',
  fono_cel:      'bg-cyan-500',
  n_autos:       'bg-orange-500',
  empresa:       'bg-purple-500',
  domicilio:     'bg-pink-500',
  bienes_raices: 'bg-amber-500',
}

export function CoberturaChart({ items }: CoberturaChartProps) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="text-sm font-semibold text-slate-200">Cobertura de datos</h3>
          <p className="text-xs text-slate-500 mt-0.5">Porcentaje de RUTs con cada campo</p>
        </div>
      </div>

      <div className="space-y-3">
        {items.map(item => (
          <div key={item.field}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-slate-300">{item.label}</span>
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-500">{formatNumber(item.count)}</span>
                <span className="text-xs font-semibold text-slate-200 w-10 text-right">
                  {formatPercentage(item.pct, 0)}
                </span>
              </div>
            </div>
            <div className="progress-bar">
              <div
                className={`progress-fill ${COLOR_MAP[item.field] ?? 'bg-brand-500'}`}
                style={{ width: `${Math.min(item.pct, 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
