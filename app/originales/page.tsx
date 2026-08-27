import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { Archive, Database, Download, FileCheck2, ShieldCheck } from 'lucide-react'
import {
  formatDatasetRows,
  RAW_DATASETS,
  RAW_DATASET_SESSION_COOKIE,
  RAW_DATASETS_RELEASE,
  verifyRawDatasetShareToken,
} from '@/lib/raw-datasets'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Datasets originales | Geimser',
  description: 'Descarga privada de datasets fuente originales.',
  robots: { index: false, follow: false, nocache: true },
}

export default async function OriginalDatasetsPage() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(RAW_DATASET_SESSION_COOKIE)?.value ?? null
  if (!verifyRawDatasetShareToken(sessionToken)) notFound()

  return (
    <main className="min-h-screen bg-surface px-4 py-10 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="overflow-hidden rounded-3xl border border-primary/20 bg-background shadow-2xl shadow-cyan-950/20">
          <div className="border-b border-border bg-gradient-to-br from-surface-muted via-surface-muted to-transparent px-6 py-8 sm:px-10 sm:py-10">
            <div className="mb-6 flex items-center justify-between gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/20 bg-surface-muted text-primary-ink">
                <Archive className="h-6 w-6" aria-hidden="true" />
              </div>
              <span className="inline-flex items-center gap-2 rounded-full border border-success/20 bg-success-bg px-3 py-1.5 text-xs font-semibold text-success">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                Enlace privado
              </span>
            </div>
            <p className="mb-2 text-sm font-semibold uppercase tracking-[0.22em] text-primary-ink">Geimser · Big Data</p>
            <h1 className="max-w-3xl text-3xl font-bold tracking-tight text-foreground sm:text-4xl">Datasets originales de BDD</h1>
          </div>

          <div className="grid gap-px bg-surface-muted sm:grid-cols-3">
            <Summary icon={<Database className="h-4 w-4" />} label="Datasets fuente" value={String(RAW_DATASETS.length)} />
            <Summary icon={<FileCheck2 className="h-4 w-4" />} label="Origen" value="Supabase directo" />
            <Summary icon={<ShieldCheck className="h-4 w-4" />} label="Publicación" value={RAW_DATASETS_RELEASE} />
          </div>
        </header>

        <section className="mt-6 space-y-3" aria-label="Archivos disponibles">
          {RAW_DATASETS.map(dataset => {
            const rows = formatDatasetRows(dataset.rows)
            const href = `/api/originales/${dataset.slug}`

            return (
              <article key={dataset.slug} className="group rounded-2xl border border-border bg-background p-5 transition hover:border-primary/30 hover:bg-background sm:flex sm:items-center sm:justify-between sm:gap-6">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold text-foreground">{dataset.name}</h2>
                    <span className="rounded-md bg-surface-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">CSV.GZ</span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{dataset.description}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {[rows ? `${rows} filas` : null, `Tabla: ${dataset.table}`].filter(Boolean).join(' · ')}
                  </p>
                </div>

                <a
                  href={href}
                  className="mt-4 inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-muted-foreground transition hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-primary sm:mt-0"
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  Descargar
                </a>
              </article>
            )
          })}
        </section>

        <footer className="mt-8 rounded-2xl border border-warning/15 bg-warning-bg px-5 py-4 text-sm leading-6 text-warning">
          Información de uso restringido. El enlace permite acceder a datos personales y empresariales; reenvíalo únicamente a destinatarios autorizados.
        </footer>
      </div>
    </main>
  )
}

function Summary({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="bg-background px-6 py-4 sm:px-8">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="mt-1.5 text-lg font-semibold text-foreground">{value}</p>
    </div>
  )
}
