'use client'

import type { CoberturaItem } from '@/types'
import { formatNumber, formatPercentage } from '@/lib/utils/formatters'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'

interface CoberturaChartProps {
  items: CoberturaItem[]
}

const COLOR_MAP: Record<string, string> = {
  nombres:       '#3b82f6', // blue-500
  email:         '#10b981', // emerald-500
  fono_cel:      '#06b6d4', // cyan-500
  n_autos:       '#f97316', // orange-500
  empresa:       '#8b5cf6', // violet-500
  domicilio:     '#ec4899', // pink-500
  bienes_raices: '#f59e0b', // amber-500
}

const CustomTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload
    return (
      <div className="bg-[#0f172a] border border-[#334155] p-3 rounded-lg shadow-elevation-2">
        <p className="text-sm font-semibold text-slate-200 mb-1">{data.label}</p>
        <p className="text-xs text-slate-400">
          Registros: <span className="font-medium text-slate-200">{formatNumber(data.count)}</span>
        </p>
        <p className="text-xs text-slate-400">
          Cobertura: <span className="font-medium text-brand">{formatPercentage(data.pct, 1)}</span>
        </p>
      </div>
    )
  }
  return null
}

export function CoberturaChart({ items }: CoberturaChartProps) {
  return (
    <div className="card p-5">
      <div className="mb-5">
        <h3 className="text-base font-bold text-slate-100">Cobertura de datos</h3>
        <p className="text-xs text-slate-400 mt-1">Porcentaje de campos completados sobre el total de RUTs</p>
      </div>

      <div className="h-[300px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={items}
            layout="vertical"
            margin={{ top: 5, right: 30, left: 10, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#334155" opacity={0.5} />
            <XAxis type="number" domain={[0, 100]} hide />
            <YAxis 
              dataKey="label" 
              type="category" 
              axisLine={false} 
              tickLine={false} 
              tick={{ fill: '#94a3b8', fontSize: 12 }} 
              width={90}
            />
            <Tooltip cursor={{ fill: '#334155', opacity: 0.2 }} content={<CustomTooltip />} />
            <Bar dataKey="pct" radius={[0, 4, 4, 0]} barSize={20}>
              {items.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLOR_MAP[entry.field] || '#06b6d4'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
