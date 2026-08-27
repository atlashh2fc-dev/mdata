'use client'

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { formatNumber } from '@/lib/utils/formatters'

interface RegionChartProps {
  data: { region: string; total: number; con_email: number; con_fono: number }[]
}

const CustomTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload
    return (
      <div className="bg-background border border-border p-3 rounded-lg shadow-elevation-2">
        <p className="text-sm font-semibold text-foreground mb-2 truncate max-w-[200px]" title={data.region}>
          {data.region}
        </p>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground flex justify-between gap-4">
            Total: <span className="font-medium text-brand">{formatNumber(data.total)}</span>
          </p>
          <p className="text-xs text-muted-foreground flex justify-between gap-4">
            Con Email: <span className="font-medium text-success">{formatNumber(data.con_email)}</span>
          </p>
          <p className="text-xs text-muted-foreground flex justify-between gap-4">
            Con Teléfono: <span className="font-medium text-primary-ink">{formatNumber(data.con_fono)}</span>
          </p>
        </div>
      </div>
    )
  }
  return null
}

export function RegionChart({ data }: RegionChartProps) {
  // Acortar nombres de regiones para el eje X
  const formattedData = data.map(d => ({
    ...d,
    shortRegion: d.region.replace(/REGION |DEL |DE |Y LA ANTARTICA CHILENA/gi, '').trim().substring(0, 15) + (d.region.length > 20 ? '...' : '')
  }))

  return (
    <div className="card p-5 xl:col-span-2">
      <div className="mb-5 flex justify-between items-end">
        <div>
          <h3 className="text-base font-bold text-foreground">Top 10 Regiones</h3>
          <p className="text-xs text-muted-foreground mt-1">Concentración poblacional y datos de contacto</p>
        </div>
      </div>

      <div className="h-[300px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={formattedData}
            margin={{ top: 5, right: 5, left: 5, bottom: 25 }}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--atlas-border)" opacity={0.5} />
            <XAxis
              dataKey="shortRegion"
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'var(--atlas-secondary)', fontSize: 11 }}
              angle={-45}
              textAnchor="end"
            />
            <YAxis
              hide
            />
            <Tooltip cursor={{ fill: 'var(--atlas-border)', opacity: 0.2 }} content={<CustomTooltip />} />
            <Bar dataKey="total" radius={[4, 4, 0, 0]} maxBarSize={40}>
              {formattedData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill="#0ea5e9" />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
