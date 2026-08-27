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

const USO_LABELS: Record<string, string> = {
  residencial: 'Residencial',
  comercial: 'Comercial',
  mixto_comercial_residencial: 'Mixto',
  rural_productivo: 'Rural',
  indeterminado_o_especial: 'Especial',
}

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
        className="font-mono text-primary-ink hover:text-primary-ink flex items-center gap-1"
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
      <span className="text-foreground">{row.nombre_completo?.trim() || '—'}</span>
    ),
  },
  {
    key: 'email',
    label: 'Email',
    render: row =>
      row.email ? (
        <div className="flex items-center gap-1.5">
          <Mail className="w-3 h-3 text-success" />
          <span className="text-xs">{row.email}</span>
        </div>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'region_part',
    label: 'Región',
    render: row => (
      <span className="text-xs text-muted-foreground">{row.region_part ?? row.domicilio_region ?? '—'}</span>
    ),
  },
  {
    key: 'n_autos',
    label: 'Autos',
    sortable: true,
    render: row =>
      row.n_autos > 0 ? (
        <div className="flex items-center gap-1 text-xs text-warning">
          <Car className="w-3 h-3" />
          {row.n_autos}
        </div>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'tiene_empresa',
    label: 'Empresa',
    render: row =>
      row.tiene_empresa ? (
        <div className="flex items-start gap-1 text-xs text-violet">
          <Building2 className="w-3 h-3 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="truncate max-w-[150px]">{row.razon_social_empresa}</div>
            {(row.rubro || row.tamano_empresas) && (
              <div className="truncate max-w-[150px] text-[10px] text-muted-foreground">
                {[row.tamano_empresas, row.rubro].filter(Boolean).join(' · ')}
              </div>
            )}
            {row.facturacion_sub_rango && (
              <div className="truncate max-w-[150px] text-[10px] text-muted-foreground">
                {row.facturacion_sub_rango}
              </div>
            )}
          </div>
        </div>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'n_bienes_raices',
    label: 'B. Raíces',
    sortable: true,
    render: row =>
      row.n_bienes_raices > 0 ? (
        <div className="flex items-center gap-1 text-xs text-warning">
          <Home className="w-3 h-3" />
          {row.n_bienes_raices}
          <span className="text-[10px] text-muted-foreground">
            ({formatCurrency(row.totalavaluos)})
          </span>
        </div>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'uso_propiedad_inferido',
    label: 'Uso',
    render: row =>
      row.uso_propiedad_inferido ? (
        <div className="flex flex-col gap-0.5 text-xs">
          <span className="text-primary-ink font-medium">
            {USO_LABELS[row.uso_propiedad_inferido] ?? row.uso_propiedad_inferido}
          </span>
          {row.bbrr_destinos?.length > 0 && (
            <span className="text-[10px] text-muted-foreground truncate max-w-[180px]">
              {row.bbrr_destinos.slice(0, 3).join(', ')}
              {row.bbrr_destinos.length > 3 ? '…' : ''}
            </span>
          )}
        </div>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'score_patrimonial',
    label: 'Score',
    sortable: true,
    render: row => {
      const s = row.score_patrimonial ?? 0
      const color = s >= 60 ? 'text-success' : s >= 30 ? 'text-warning' : 'text-muted-foreground'
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
          <div className="w-16 h-1.5 bg-surface rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full"
              style={{ width: `${c}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground">{c}%</span>
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
      ? <ArrowUp className="w-3 h-3 text-primary-ink" />
      : <ArrowDown className="w-3 h-3 text-primary-ink" />
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
                      className="flex items-center gap-1 hover:text-foreground transition-colors"
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
