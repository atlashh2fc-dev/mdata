import { cn } from '@/lib/utils/formatters'

interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function Spinner({ size = 'md', className }: SpinnerProps) {
  const sizeClass = { sm: 'w-4 h-4', md: 'w-6 h-6', lg: 'w-8 h-8' }[size]
  return (
    <div
      className={cn(
        sizeClass,
        'border-2 border-brand-500/20 border-t-brand-500 rounded-full animate-spin',
        className
      )}
    />
  )
}

export function LoadingState({ text = 'Cargando...' }: { text?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-4">
      <Spinner size="lg" />
      <p className="text-sm text-slate-500">{text}</p>
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
      <div className="w-12 h-12 rounded-full bg-surface-800 flex items-center justify-center">
        <span className="text-2xl">◦</span>
      </div>
      <div>
        <p className="text-sm font-medium text-slate-300">{title}</p>
        {description && <p className="text-xs text-slate-500 mt-1">{description}</p>}
      </div>
      {action}
    </div>
  )
}
