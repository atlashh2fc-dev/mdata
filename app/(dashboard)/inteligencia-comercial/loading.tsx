import { BrainCircuit, LoaderCircle, Target } from 'lucide-react'

function SkeletonCard() {
  return (
    <div className="rounded-2xl border border-border bg-background p-5">
      <div className="h-3 w-28 animate-pulse rounded bg-surface-muted" />
      <div className="mt-4 h-8 w-20 animate-pulse rounded bg-surface-muted" />
      <div className="mt-3 h-3 w-40 animate-pulse rounded bg-background" />
    </div>
  )
}

export default function LoadingInteligenciaComercial() {
  return (
    <>
      <header className="h-16 flex items-center justify-between px-6 border-b border-border bg-surface backdrop-blur-sm sticky top-0 z-20">
        <div>
          <h1 className="text-base font-semibold text-foreground">Inteligencia Comercial</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Cargando monitoreo táctico, campañas y priorización dinámica.
          </p>
        </div>
      </header>

      <div className="space-y-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-primary/10 bg-gradient-to-r from-surface-muted via-surface to-transparent px-5 py-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <BrainCircuit className="h-4 w-4 text-primary-ink" />
              Armando inteligencia comercial
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Estamos cargando campañas, desvíos, ventanas y recomendaciones.
            </p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-surface-muted px-3 py-1.5 text-xs text-primary-ink">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            Abriendo módulo
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <SkeletonCard key={index} />
          ))}
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
          <div className="rounded-2xl border border-border bg-background p-5">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <Target className="h-4 w-4 text-primary-ink" />
              Cargando campañas
            </div>
            <div className="mt-4 space-y-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <div key={index} className="rounded-2xl border border-border bg-background p-4">
                  <div className="h-4 w-48 animate-pulse rounded bg-surface-muted" />
                  <div className="mt-3 h-3 w-full animate-pulse rounded bg-background" />
                  <div className="mt-2 h-3 w-4/5 animate-pulse rounded bg-background" />
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            {Array.from({ length: 2 }).map((_, index) => (
              <div key={index} className="rounded-2xl border border-border bg-background p-5">
                <div className="h-4 w-40 animate-pulse rounded bg-surface-muted" />
                <div className="mt-4 space-y-3">
                  {Array.from({ length: 3 }).map((__, innerIndex) => (
                    <div key={innerIndex} className="rounded-2xl border border-border bg-background p-4">
                      <div className="h-3 w-32 animate-pulse rounded bg-surface-muted" />
                      <div className="mt-3 h-3 w-full animate-pulse rounded bg-background" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
