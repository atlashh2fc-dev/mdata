'use client'

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { formatNumber } from '@/lib/utils/formatters'

interface ScoreDonutChartProps {
  data: { range: string; count: number }[]
}

const COLORS = ['#ef4444', '#f59e0b', '#eab308', '#10b981', '#06b6d4', '#8b5cf6']
const LABELS: Record<string, string> = {
  '0': 'Sin datos adicionales',
  '1-20': 'Básico',
  '21-40': 'Medio-Bajo',
  '41-60': 'Medio',
  '61-80': 'Alto',
  '81+': 'Premium'
}

const CustomTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload
    return (
      <div className="bg-[#0f172a] border border-[#334155] p-3 rounded-lg shadow-elevation-2">
        <p className="text-sm font-semibold text-slate-200 mb-1">{LABELS[data.range] || data.range}</p>
        <p className="text-xs text-slate-400">
          Personas: <span className="font-medium text-slate-200">{formatNumber(data.count)}</span>
        </p>
      </div>
    )
  }
  return null
}

const renderLegend = (props: any) => {
  const { payload } = props
  return (
    <ul className="flex flex-col gap-2 mt-4 text-xs text-slate-300">
      {payload.map((entry: any, index: number) => (
        <li key={`item-${index}`} className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: entry.color }} />
            <span>{LABELS[entry.value] || entry.value}</span>
          </div>
          <span className="font-medium">{formatNumber(entry.payload.count)}</span>
        </li>
      ))}
    </ul>
  )
}

export function ScoreDonutChart({ data }: ScoreDonutChartProps) {
  return (
    <div className="card p-5">
      <div className="mb-2">
        <h3 className="text-base font-bold text-slate-100">Distribución de Score</h3>
        <p className="text-xs text-slate-400 mt-1">Calidad del perfil patrimonial y contacto</p>
      </div>

      <div className="h-[280px] w-full flex">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              innerRadius={70}
              outerRadius={100}
              paddingAngle={2}
              dataKey="count"
              nameKey="range"
              stroke="none"
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
            <Legend content={renderLegend} layout="vertical" verticalAlign="middle" align="right" />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
