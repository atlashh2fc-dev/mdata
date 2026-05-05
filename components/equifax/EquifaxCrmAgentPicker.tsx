'use client'

import { useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

export function EquifaxCrmAgentPicker({
  agents,
  currentAgent,
  disabled = false,
  basePath,
}: {
  agents: string[]
  currentAgent: string | null
  disabled?: boolean
  basePath: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const currentValue = currentAgent ?? ''
  const options = useMemo(() => agents.slice(0, 200), [agents])

  return (
    <label className="inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-200">
      <span className="text-slate-400">Agente</span>
      <select
        value={currentValue}
        disabled={disabled}
        onChange={event => {
          const params = new URLSearchParams(searchParams?.toString())
          const value = event.target.value.trim()
          if (value) params.set('agent', value)
          else params.delete('agent')
          router.push(`${basePath}?${params.toString()}`)
        }}
        className="rounded-lg border border-slate-700 bg-slate-950/60 px-2 py-1 text-xs text-white outline-none focus:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <option value="">Todos</option>
        {options.map(agent => (
          <option key={agent} value={agent}>
            {agent}
          </option>
        ))}
      </select>
    </label>
  )
}

