import type { IngestionStatus } from '@/types'
import { cn } from '@/lib/utils/formatters'

const STATUS_CONFIG: Record<IngestionStatus, { label: string; className: string }> = {
  pending:    { label: 'Pendiente',    className: 'badge-neutral' },
  processing: { label: 'Procesando',  className: 'badge-info' },
  validating: { label: 'Validando',   className: 'badge-info' },
  merging:    { label: 'Mergeando',   className: 'badge-warning' },
  completed:  { label: 'Completado',  className: 'badge-success' },
  failed:     { label: 'Fallido',     className: 'badge-danger' },
  cancelled:  { label: 'Cancelado',   className: 'badge-neutral' },
}

interface StatusBadgeProps {
  status: IngestionStatus | string
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status as IngestionStatus] ?? {
    label: status,
    className: 'badge-neutral',
  }
  return (
    <span className={cn('badge', config.className)}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {config.label}
    </span>
  )
}
