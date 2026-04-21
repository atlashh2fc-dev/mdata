'use client'

import Link from 'next/link'
import type { PersonaView } from '@/types'
import { formatNumber, formatCurrency } from '@/lib/utils/formatters'
import { formatRut } from '@/lib/utils/rut'
import { Pagination } from '@/components/ui/Pagination'
import { EmptyState } from '@/components/ui/Spinner'
import {
  ArrowUpDown, ArrowUp, ArrowDown,
  Car, Building2, Home, Mail, ExternalLink,
} from 'lucide-react'

interface Column {
  key: keyof PersonaView
  label: string
  sortable?: boolean
  render?: (row: PersonaView) => React.ReactNode
}

const COLUMNS: Column[] = [
  {
    key: 'rutid',
    label: 'RUT',
    sortable: true,
    render: row => (
      <Link
        href={`/buscar?rut=${row.rutid}`}
        className="font-mono text-brand-400 hover:text-brand-300 flex items-center gap-1"
      >
        {formatRut(row.rutid ?? '')}
        <ExternalLink className="w-3 h-3 opacity-50" />
      </Link>
    ),
  },
  {
    key: 'nombre_completo',
    label: 'Nombre',
    render: row => (
      <span className="text-slate-200">{row.nombre_completo?.trim() || '—'}</span>
    ),
  },
  {
    key: 'email',
    label: 'Email',
    render: row =>
      row.email ? (
        <div className="flex items-center gap-1.5">
          <Mail className="w-3 h-3 text-green-500" />
          <span className="text-xs">{row.email}</span>
        </div>
      ) : (
        <span className="text-slate-600">—</span>
      ),
  },
  {
    key: 'region_part',
    label: 'Región',
    render: row => (
      <span className="text-xs text-slate-400">{row.region_part ?? row.domicilio_region ?? '—'}</span>
    ),
  },
  {
    key: 'n_autos',
    label: 'Autos',
    sortable: true,
    render: row =>
      row.n_autos > 0 ? (
        <div className="flex items-center gap-1 text-xs text-orange-400">
          <Car className="w-3 h-3" />
          {row.n_autos}
        </div>
      ) : (
        <span className="text-slate-600">—</span>
      ),
  },
  {
    key: 'tiene_empresa',
    label: 'Empresa',
    render: row =>
      row.tiene_empresa ? (
        <div className="flex items-center gap-1 text-xs text-purple-400">
          <Building2 className="w-3 h-3" />
          <span className="truncate max-w-[120px]">{row.razon_social_empresa}</span>
        </div>
      ) : (
        <span className="text-slate-600">—</span>
      ),
  },
  {
    key: 'n_bienes_raices',
    label: 'B. Raíces',
    sortable: true,
    render: row =>
      row.n_bienes_raices > 0 ? (
        <div className="flex items-center gap-1 text-xs text-amber-400">
          <Home className="w-3 h-3" />
          {row.n_bienes_raices}
          <span className="text-[10px] text-slate-500">
            ({formatCurrency(row.totalavaluos)})
          </span>
        </div>
      ) : (
        <span className="text-slate-600">—</span>
      ),
  },
  {
    key: 'score_patrimonial',
    label: 'Score',
    sortable: true,
    render: row => {
      const s = row.score_patrimonial ?? 0
      const color = s >= 60 ? 'text-green-400' : s >= 30 ? 'text-amber-400' : 'text-slate-400'
      return <span className={`font-bold text-sm ${color}`}>{s}</span>
    },
  },
  {
    key: 'cobertura_pct',
    label: 'Cobertura',
    sortable: true,
    render: row => {
      const c = row.cobertura_pct ?? 0
      return (
        <div className="flex items-center gap-2">
          <div className="w-16 h-1.5 bg-[#334155] rounded-full overflow-hidden">
            <div
              className="h-full bg-brand-500 rounded-full"
              style={{ width: `${c}%` }}
            />
          </div>
          <span className="text-xs text-slate-400">{c}%</span>
        </div>
      )
    },
  },
]

interface PersonasTableProps {
  data: PersonaView[]
  total: number
  page: number
  pageSize: number
  onPageChange: (page: number) => void
  sortBy: string
  sortOrder: 'asc' | 'desc'
  onSort: (field: string) => void
}

export function PersonasTable({
  data,
  total,
  page,
  pageSize,
  onPageChange,
  sortBy,
  sortOrder,
  onSort,
}: PersonasTableProps) {
  if (data.length === 0) {
    return (
      <EmptyState
        title="Sin resultados"
        description="No se encontraron personas con los criterios indicados"
      />
    )
  }

  function SortIcon({ field }: { field: string }) {
    if (sortBy !== field) return <ArrowUpDown className="w-3 h-3 opacity-30" />
    return sortOrder === 'asc'
      ? <ArrowUp className="w-3 h-3 text-brand-400" />
      : <ArrowDown className="w-3 h-3 text-brand-400" />
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              {COLUMNS.map(col => (
                <th key={col.key}>
                  {col.sortable ? (
                    <button
                      onClick={() => onSort(col.key)}
                      className="flex items-center gap-1 hover:text-white transition-colors"
                    >
                      {col.label}
                      <SortIcon field={col.key} />
                    </button>
                  ) : (
                    col.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map(row => (
              <tr key={row.rutid}>
                {COLUMNS.map(col => (
                  <td key={col.key}>
                    {col.render ? col.render(row) : String(row[col.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        totalPages={Math.ceil(total / pageSize)}
        total={total}
        pageSize={pageSize}
        onPageChange={onPageChange}
      />
    </div>
  )
}
