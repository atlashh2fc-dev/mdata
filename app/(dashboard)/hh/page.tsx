import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  Database,
  FileSearch,
  Gauge,
  Lock,
  Sigma,
  Table2,
  Trophy,
} from 'lucide-react'
import { notFound, redirect } from 'next/navigation'
import { Header } from '@/components/layout/Header'
import { createSupabaseServerClient, hasSupabasePublicEnv } from '@/lib/db/supabase'

export const dynamic = 'force-dynamic'

const HH_ALLOWED_EMAIL = 'hh2fc24@gmail.com'

const sourceRegistry = [
  {
    name: 'Club Hipico de Santiago',
    type: 'Resultados por jornada y carrera',
    status: 'Prioridad oficial',
    url: 'https://www.clubhipico.cl/carreras/resultados/',
  },
  {
    name: 'Hipodromo Chile',
    type: 'Resultados por reunion, retiros, programas y estadisticas',
    status: 'Prioridad oficial',
    url: 'https://hipodromo.cl/carreras-resultados-todos',
  },
  {
    name: 'Valparaiso Sporting',
    type: 'Programas, resultados, estado de pista y figuracion',
    status: 'Prioridad oficial',
    url: 'https://www.sporting.cl/hipica/front/es/resultado/2026-05-03/06.html',
  },
  {
    name: 'Consejo Superior de la Hipica Nacional',
    type: 'Marco regulatorio y nominas profesionales',
    status: 'Control normativo',
    url: 'https://consejosuperior.cl/',
  },
  {
    name: 'Reglamento de Carreras de Chile',
    type: 'Definiciones, calendario oficial y reglas de validacion',
    status: 'Base metodologica',
    url: 'https://www.bcn.cl/leychile/navegar?idNorma=40596&idVersion=2022-01-07',
  },
  {
    name: 'Stud Book de Chile',
    type: 'Registro, estadistica anual y reglas de hipodromos reconocidos',
    status: 'Base historica',
    url: 'https://www.studbookdechile.cl/public/historicos/libros/2024/index.php?menu=reglamento_ES',
  },
]

const phases = [
  {
    title: '1. Recopilacion',
    icon: FileSearch,
    detail: 'Extraer resultados oficiales del 05-05-2025 al 03-05-2026 y programas de la semana iniciada el 04-05-2026.',
    deliverable: 'Carreras, inscritos, figuracion, dividendos, tiempos, pista, retiros e incidencias.',
  },
  {
    title: '2. Normalizacion',
    icon: Database,
    detail: 'Unificar entidades y marcar campos incompletos por caballo, jockey, preparador, stud, recinto, distancia y pista.',
    deliverable: 'Tabla maestra consolidada con trazabilidad por fuente y fecha de captura.',
  },
  {
    title: '3. Variables',
    icon: Sigma,
    detail: 'Calcular forma reciente, win rate, podio, volatilidad, descanso, distancia, recinto y compatibilidad caballo-jockey.',
    deliverable: 'Features auditables para caballo, jockey, preparador y binomio.',
  },
  {
    title: '4. Modelo',
    icon: BarChart3,
    detail: 'Entrenar baseline probabilistico y comparar contra modelos de ranking, Elo, gradient boosting y ajuste bayesiano.',
    deliverable: 'Probabilidad de ganar, podio, fuera de podio, riesgo y confianza calibrada.',
  },
  {
    title: '5. Semana objetivo',
    icon: CalendarDays,
    detail: 'Cruzar los inscritos oficiales de la semana del 04-05-2026 con el historial limpio del ultimo ano movil.',
    deliverable: 'Informe por carrera, ranking de escenarios y carreras a evitar.',
  },
]

const requiredFields = [
  'Fecha',
  'Hipodromo',
  'Carrera',
  'Distancia',
  'Pista',
  'Estado pista',
  'Tipo carrera',
  'Caballo',
  'Posicion',
  'Jockey',
  'Preparador',
  'Stud',
  'Peso',
  'Edad / sexo',
  'Dividendo',
  'Tiempo',
  'Diferencia',
  'Participantes',
  'Favorito',
  'Retiros / incidencias',
]

const modelWeights = [
  { signal: 'Forma reciente del caballo', weight: 24, note: 'Ultimas 3, 5 y 10 carreras con decaimiento temporal.' },
  { signal: 'Historial contextual del caballo', weight: 18, note: 'Recinto, distancia, pista y tipo de carrera.' },
  { signal: 'Jockey y preparador', weight: 16, note: 'Win rate, podio, tendencia y combinaciones recurrentes.' },
  { signal: 'Binomio caballo-jockey', weight: 12, note: 'Efectividad juntos versus separados.' },
  { signal: 'Condiciones de carrera', weight: 12, note: 'Numero de competidores, peso, descanso y superficie.' },
  { signal: 'Mercado si hay cuotas', weight: 10, note: 'Comparacion contra probabilidad implicita, sin copiar al mercado.' },
  { signal: 'Calidad del dato', weight: 8, note: 'Penaliza vacios, fuentes no oficiales e inconsistencias.' },
]

const dashboardRows = [
  {
    label: 'Top 5 ganar',
    value: 'Pendiente',
    detail: 'Se publica solo despues de cargar inscritos oficiales y validar historico.',
  },
  {
    label: 'Top 5 podio',
    value: 'Pendiente',
    detail: 'Requiere figuracion completa y normalizacion de participantes.',
  },
  {
    label: 'Binomios fuertes',
    value: 'Pendiente',
    detail: 'Minimo recomendado: 3 carreras juntos o ajuste bayesiano.',
  },
  {
    label: 'Carreras claras',
    value: 'Pendiente',
    detail: 'Se exige separacion estadistica entre candidatos y baja entropia.',
  },
  {
    label: 'Carreras riesgosas',
    value: 'Pendiente',
    detail: 'Marcadas por poca data, debutantes, retiros o pista incierta.',
  },
]

const outputColumns = [
  'Fecha',
  'Hipodromo',
  'Carrera',
  'Caballo',
  'Jockey',
  'Entrenador',
  'P(gana)',
  'P(podio)',
  'Score historico',
  'Score reciente',
  'Riesgo',
  'Comentario tecnico',
]

function Pill({ children, tone = 'cyan' }: { children: React.ReactNode; tone?: 'cyan' | 'emerald' | 'amber' | 'rose' | 'slate' }) {
  const classes = {
    cyan: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200',
    emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    rose: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
    slate: 'border-slate-700 bg-slate-800/70 text-slate-300',
  }[tone]

  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${classes}`}>{children}</span>
}

function MetricCard({
  label,
  value,
  hint,
  tone = 'cyan',
}: {
  label: string
  value: string
  hint: string
  tone?: 'cyan' | 'emerald' | 'amber' | 'rose'
}) {
  const toneClass = {
    cyan: 'border-cyan-500/20 bg-cyan-500/10 text-cyan-300',
    emerald: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
    amber: 'border-amber-500/20 bg-amber-500/10 text-amber-300',
    rose: 'border-rose-500/20 bg-rose-500/10 text-rose-300',
  }[tone]

  return (
    <div className={`card border p-5 ${toneClass}`}>
      <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <div className="mt-3 text-2xl font-semibold text-white">{value}</div>
      <p className="mt-2 text-xs leading-5 text-slate-400">{hint}</p>
    </div>
  )
}

function SectionTitle({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: typeof Gauge
  title: string
  subtitle: string
}) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10">
        <Icon className="h-4 w-4 text-cyan-300" />
      </div>
      <div>
        <h2 className="text-base font-semibold text-white">{title}</h2>
        <p className="mt-1 text-sm text-slate-400">{subtitle}</p>
      </div>
    </div>
  )
}

export default async function HHPage() {
  if (!hasSupabasePublicEnv) {
    redirect('/login')
  }

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  if ((user.email ?? '').toLowerCase() !== HH_ALLOWED_EMAIL) {
    notFound()
  }

  return (
    <>
      <Header
        title="HH"
        subtitle="Motor cuantitativo privado para analisis hipico chileno"
        actions={<Pill tone="emerald"><Lock className="mr-1 h-3 w-3" /> {HH_ALLOWED_EMAIL}</Pill>}
      />

      <div className="p-6 space-y-6">
        <section className="overflow-hidden rounded-xl border border-slate-800 bg-[#111a31]">
          <div className="grid gap-0 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="p-6">
              <div className="flex flex-wrap gap-2">
                <Pill>Semana objetivo 04-05-2026</Pill>
                <Pill tone="amber">Sin datos inventados</Pill>
                <Pill tone="slate">Chile: CHS, HCH, VSC y recintos oficiales</Pill>
              </div>
              <h1 className="mt-5 max-w-4xl text-3xl font-semibold leading-tight text-white">
                Centro de analisis HH para carreras de caballos en Chile
              </h1>
              <p className="mt-4 max-w-3xl text-sm leading-6 text-slate-300">
                Este modulo queda preparado para recopilar resultados oficiales, normalizar entidades,
                calcular senales cuantitativas y emitir escenarios probabilisticos. El sistema no promete
                certeza de apuesta: solo publicara probabilidades cuando exista trazabilidad, cobertura de
                datos y validacion fuera de muestra.
              </p>
            </div>

            <div className="border-t border-slate-800 bg-slate-950/40 p-6 lg:border-l lg:border-t-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <AlertTriangle className="h-4 w-4 text-amber-300" />
                Regla de calidad HH
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-300">
                Una meta de acierto mayor al 90% no es defendible antes de entrenar y calibrar con datos reales.
                El umbral operativo sera publicar alta confianza solo si el backtest supera benchmarks,
                la calibracion es estable y la cobertura de campos criticos llega al 90% o mas.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                  <div className="text-xl font-semibold text-white">365d</div>
                  <div className="text-xs text-slate-500">Ventana historica</div>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                  <div className="text-xl font-semibold text-white">90%+</div>
                  <div className="text-xs text-slate-500">Cobertura critica, no promesa de acierto</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Periodo base"
            value="05-05-2025 a 03-05-2026"
            hint="Ultimo ano movil anterior a la semana objetivo."
          />
          <MetricCard
            label="Modelos candidatos"
            value="Logit + ranking"
            hint="Fallback explicito si los datos no soportan modelos complejos."
            tone="emerald"
          />
          <MetricCard
            label="Salida"
            value="Probabilidades"
            hint="Ganar, podio, fuera de podio, score y riesgo."
            tone="amber"
          />
          <MetricCard
            label="Estado"
            value="Listo para ingesta"
            hint="Sin predicciones hasta cargar fuentes oficiales."
            tone="rose"
          />
        </div>

        <section className="card p-5">
          <SectionTitle
            icon={FileSearch}
            title="Fuentes Y Trazabilidad"
            subtitle="Prioridad a paginas oficiales, reguladores, programas y resultados historicos verificables."
          />
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Fuente</th>
                  <th>Uso</th>
                  <th>Estado</th>
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {sourceRegistry.map(source => (
                  <tr key={source.url}>
                    <td className="font-medium text-white">{source.name}</td>
                    <td>{source.type}</td>
                    <td><Pill tone={source.status.includes('oficial') ? 'emerald' : 'slate'}>{source.status}</Pill></td>
                    <td>
                      <a className="text-cyan-300 hover:text-cyan-200" href={source.url} target="_blank" rel="noreferrer">
                        Abrir fuente
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-5">
          {phases.map(phase => {
            const Icon = phase.icon
            return (
              <div key={phase.title} className="card p-4">
                <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10">
                  <Icon className="h-4 w-4 text-cyan-300" />
                </div>
                <h3 className="text-sm font-semibold text-white">{phase.title}</h3>
                <p className="mt-2 text-xs leading-5 text-slate-400">{phase.detail}</p>
                <p className="mt-3 text-xs leading-5 text-slate-300">{phase.deliverable}</p>
              </div>
            )
          })}
        </section>

        <section className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
          <div className="card p-5">
            <SectionTitle
              icon={Table2}
              title="Campos Minimos"
              subtitle="La tabla maestra debe conservar campo original, campo normalizado y fuente."
            />
            <div className="flex flex-wrap gap-2">
              {requiredFields.map(field => (
                <Pill key={field} tone="slate">{field}</Pill>
              ))}
            </div>
          </div>

          <div className="card p-5">
            <SectionTitle
              icon={Gauge}
              title="Modelo Probabilistico"
              subtitle="Pesos iniciales del score cuando el dataset todavia no permite entrenar un modelo complejo."
            />
            <div className="space-y-3">
              {modelWeights.map(item => (
                <div key={item.signal} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="text-sm font-medium text-white">{item.signal}</div>
                    <div className="font-mono text-sm text-cyan-300">{item.weight}%</div>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
                    <div className="h-full rounded-full bg-cyan-400" style={{ width: `${item.weight * 3}%` }} />
                  </div>
                  <p className="mt-2 text-xs text-slate-400">{item.note}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-[1fr_1fr]">
          <div className="card p-5">
            <SectionTitle
              icon={Trophy}
              title="Dashboard Resumido"
              subtitle="Estos rankings quedan bloqueados hasta que existan datos cargados y auditados."
            />
            <div className="space-y-3">
              {dashboardRows.map(row => (
                <div key={row.label} className="flex items-start justify-between gap-4 rounded-lg border border-slate-800 bg-slate-950/40 p-4">
                  <div>
                    <div className="text-sm font-semibold text-white">{row.label}</div>
                    <p className="mt-1 text-xs leading-5 text-slate-400">{row.detail}</p>
                  </div>
                  <Pill tone="amber">{row.value}</Pill>
                </div>
              ))}
            </div>
          </div>

          <div className="card p-5">
            <SectionTitle
              icon={CheckCircle2}
              title="Salida Profesional"
              subtitle="Formato del informe ejecutivo y tabla por carrera solicitada."
            />
            <div className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="table-base">
                <thead>
                  <tr>
                    {outputColumns.map(column => <th key={column}>{column}</th>)}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td colSpan={outputColumns.length} className="py-8 text-center text-slate-500">
                      La tabla se pobla solo con carreras oficiales, datos historicos trazables y probabilidades calibradas.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-100">
                Conservador: prioriza podio y baja volatilidad.
              </div>
              <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/10 p-3 text-sm text-cyan-100">
                Moderado: balance entre victoria, podio y cuota.
              </div>
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-100">
                Agresivo: mayor dispersion, solo si hay retorno esperado.
              </div>
              <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-100">
                Evitar: senal insuficiente o datos criticos faltantes.
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  )
}
