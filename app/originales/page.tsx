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
    <main className="min-h-screen bg-[#07111f] px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="overflow-hidden rounded-3xl border border-cyan-400/20 bg-slate-900/70 shadow-2xl shadow-cyan-950/20">
          <div className="border-b border-white/10 bg-gradient-to-br from-cyan-500/15 via-blue-500/5 to-transparent px-6 py-8 sm:px-10 sm:py-10">
            <div className="mb-6 flex items-center justify-between gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-300/20 bg-cyan-400/10 text-cyan-300">
                <Archive className="h-6 w-6" aria-hidden="true" />
              </div>
              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-300">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                Enlace privado
              </span>
            </div>
            <p className="mb-2 text-sm font-semibold uppercase tracking-[0.22em] text-cyan-300">Geimser · Big Data</p>
            <h1 className="max-w-3xl text-3xl font-bold tracking-tight text-white sm:text-4xl">Datasets originales de BDD</h1>
          </div>

          <div className="grid gap-px bg-white/10 sm:grid-cols-3">
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
              <article key={dataset.slug} className="group rounded-2xl border border-white/10 bg-slate-900/65 p-5 transition hover:border-cyan-400/30 hover:bg-slate-900/90 sm:flex sm:items-center sm:justify-between sm:gap-6">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold text-white">{dataset.name}</h2>
                    <span className="rounded-md bg-slate-800 px-2 py-1 font-mono text-[11px] text-slate-400">CSV.GZ</span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-400">{dataset.description}</p>
                  <p className="mt-2 text-xs text-slate-500">
                    {[rows ? `${rows} filas` : null, `Tabla: ${dataset.table}`].filter(Boolean).join(' · ')}
                  </p>
                </div>

                <a
                  href={href}
                  className="mt-4 inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-cyan-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 focus:outline-none focus:ring-2 focus:ring-cyan-300 sm:mt-0"
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  Descargar
                </a>
              </article>
            )
          })}
        </section>

        <footer className="mt-8 rounded-2xl border border-amber-400/15 bg-amber-400/[0.06] px-5 py-4 text-sm leading-6 text-amber-100/80">
          Información de uso restringido. El enlace permite acceder a datos personales y empresariales; reenvíalo únicamente a destinatarios autorizados.
        </footer>
      </div>
    </main>
  )
}

function Summary({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="bg-slate-950/70 px-6 py-4 sm:px-8">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-slate-500">
        {icon}
        {label}
      </div>
      <p className="mt-1.5 text-lg font-semibold text-slate-100">{value}</p>
    </div>
  )
}
