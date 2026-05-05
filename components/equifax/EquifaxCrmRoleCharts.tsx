'use client'

import {
  Bar,
  BarChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

type RankingRow = {
  agent_name: string
  attempts: number
  contacts: number
  purchases: number
}

export function EquifaxCrmRoleCharts({ rankings }: { rankings: RankingRow[] }) {
  const data = rankings
    .slice(0, 10)
    .map(item => ({
      name: item.agent_name.length > 18 ? `${item.agent_name.slice(0, 18)}…` : item.agent_name,
      intentos: item.attempts,
      contactos: item.contacts,
      compras: item.purchases,
    }))

  if (!data.length) return null

  return (
    <div className="card p-5">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
        Ranking (top 10)
      </div>
      <div className="mt-4 h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-15} height={60} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Legend />
            <Bar dataKey="intentos" fill="#06b6d4" />
            <Bar dataKey="contactos" fill="#34d399" />
            <Bar dataKey="compras" fill="#f59e0b" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

