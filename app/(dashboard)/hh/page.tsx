import Link from 'next/link'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  Clock,
  Database,
  ExternalLink,
  FileText,
  Filter,
  Gauge,
  Lock,
  RefreshCcw,
  ShieldAlert,
  Sigma,
  Table2,
  Trophy,
  Users,
} from 'lucide-react'
import { notFound, redirect } from 'next/navigation'
import { Header } from '@/components/layout/Header'
import { createSupabaseServerClient, hasSupabasePublicEnv } from '@/lib/db/supabase'
import { cn, formatNumber } from '@/lib/utils/formatters'

export const dynamic = 'force-dynamic'

const HH_ALLOWED_EMAIL = 'hh2fc24@gmail.com'

type SearchParams = {
  date?: string | string[]
  hipodromo?: string | string[]
  risk?: string | string[]
}

type HHMeeting = {
  id: string
  source_id: string
  meeting_date: string
  hippodrome: string
  description: string | null
  scheduled_time: string | null
  program_url: string | null
  program_status: string
}

type HHSource = {
  id: string
  name: string
  base_url: string | null
  adapter_status: string
  notes: string | null
}

type HHPredictionRun = {
  id: string
  from_date: string
  to_date: string
  status: string
  model_version: string
  report_path: string | null
  json_path: string | null
  summary: Record<string, unknown> | null
  completed_at: string | null
  created_at: string
}

type HHPrediction = {
  id: string
  run_id: string
  source_id: string
  race_date: string
  hippodrome: string
  race_number: number
  horse: string
  horse_key: string
  saddle_number: number | null
  jockey: string | null
  trainer: string | null
  win_probability: number | string
  podium_probability: number | string
  risk: string
  score: number | string | null
  signal: Record<string, unknown> | null
  raw_payload: Record<string, unknown> | null
}

type HHProgramEntry = {
  race_date: string
  hippodrome: string
  race_number: number
  horse_key: string
  scheduled_time: string | null
  program_url: string | null
  recent_positions: unknown
  last_dividend: number | string | null
}

type HHResult = {
  race_date: string
  hippodrome: string
  race_number: number
  horse: string
  horse_key: string
  final_position: number | null
  jockey: string | null
  jockey_key: string | null
  trainer: string | null
  trainer_key: string | null
  dividend: number | string | null
}

type CountMap = {
  sources: number
  meetings: number
  races: number
  results: number
  entries: number
  runs: number
  predictions: number
}

type HHDashboardData = {
  counts: CountMap
  sources: HHSource[]
  meetings: HHMeeting[]
  latestRun: HHPredictionRun | null
  predictions: HHPrediction[]
  filteredPredictions: HHPrediction[]
  programEntryByKey: Map<string, HHProgramEntry>
  historicalResults: HHResult[]
  errors: string[]
}

type EntityStat = {
  key: string
  label: string
  secondary?: string | null
  starts: number
  wins: number
  podiums: number
  avgPosition: number
  winRate: number
  podiumRate: number
  lastDate?: string
}

type RaceSignal = {
  key: string
  date: string
  hippodrome: string
  raceNumber: number
  fieldSize: number
  topHorse: string
  topWin: number
  topPodium: number
  gap: number
  highRiskCount: number
  clarity: number
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

function toNumber(value: number | string | null | undefined) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function probabilityPct(value: number | string | null | undefined) {
  const numeric = toNumber(value)
  return numeric > 1 ? numeric : numeric * 100
}

function formatPct(value: number | string | null | undefined, decimals = 1) {
  return `${probabilityPct(value).toFixed(decimals)}%`
}

function formatScore(value: number | string | null | undefined) {
  const numeric = toNumber(value)
  return numeric ? numeric.toFixed(2) : '--'
}

function formatLocalDate(value: string | null | undefined) {
  if (!value) return '--'
  const [year, month, day] = value.split('-')
  return year && month && day ? `${day}-${month}-${year}` : value
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return '--'
  return new Intl.DateTimeFormat('es-CL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function entryKey(row: { race_date: string; hippodrome: string; race_number: number; horse_key: string }) {
  return `${row.race_date}::${row.hippodrome}::${row.race_number}::${row.horse_key}`
}

function raceKey(row: Pick<HHPrediction, 'race_date' | 'hippodrome' | 'race_number'>) {
  return `${row.race_date}::${row.hippodrome}::${row.race_number}`
}

function normalizePositions(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.map(item => Number(item)).filter(item => Number.isFinite(item) && item > 0)
}

function riskTone(risk: string | null | undefined): 'emerald' | 'amber' | 'rose' | 'slate' {
  const normalized = (risk ?? '').toLowerCase()
  if (normalized.includes('bajo')) return 'emerald'
  if (normalized.includes('medio')) return 'amber'
  if (normalized.includes('alto')) return 'rose'
  return 'slate'
}

function confidenceLabel(run: HHPredictionRun | null, predictions: HHPrediction[]) {
  if (!run || !predictions.length) return 'Sin corrida'
  const projectedMeetings = Number(run.summary?.projected_programs ?? 0)
  if (projectedMeetings < 3) return 'Limitado'
  return 'Operativo'
}

async function countTable(client: any, table: string) {
  const { count, error } = await client.from(table).select('id', { count: 'exact', head: true })
  if (error) throw new Error(`${table}: ${error.message}`)
  return count ?? 0
}

async function fetchHistoricalResults(client: any) {
  const rows: HHResult[] = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from('hh_racing_results')
      .select('race_date, hippodrome, race_number, horse, horse_key, final_position, jockey, jockey_key, trainer, trainer_key, dividend')
      .order('race_date', { ascending: false })
      .range(from, from + pageSize - 1)

    if (error) throw new Error(`hh_racing_results: ${error.message}`)
    rows.push(...((data ?? []) as HHResult[]))
    if (!data || data.length < pageSize) break
  }
  return rows
}

async function loadHHData(client: any, params: SearchParams): Promise<HHDashboardData> {
  const selectedDate = firstParam(params.date)
  const selectedHipodromo = firstParam(params.hipodromo)
  const selectedRisk = firstParam(params.risk)
  const errors: string[] = []

  try {
    const [
      sourcesCount,
      meetingsCount,
      racesCount,
      resultsCount,
      entriesCount,
      runsCount,
      predictionsCount,
      sourcesResult,
      runResult,
      historicalResults,
    ] = await Promise.all([
      countTable(client, 'hh_racing_sources'),
      countTable(client, 'hh_racing_meetings'),
      countTable(client, 'hh_racing_races'),
      countTable(client, 'hh_racing_results'),
      countTable(client, 'hh_racing_program_entries'),
      countTable(client, 'hh_racing_prediction_runs'),
      countTable(client, 'hh_racing_predictions'),
      client
        .from('hh_racing_sources')
        .select('id, name, base_url, adapter_status, notes')
        .order('name', { ascending: true }),
      client
        .from('hh_racing_prediction_runs')
        .select('*')
        .order('completed_at', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(1),
      fetchHistoricalResults(client),
    ])

    if (sourcesResult.error) throw new Error(`hh_racing_sources: ${sourcesResult.error.message}`)
    if (runResult.error) throw new Error(`hh_racing_prediction_runs: ${runResult.error.message}`)

    const latestRun = ((runResult.data ?? [])[0] ?? null) as HHPredictionRun | null
    let meetings: HHMeeting[] = []
    let predictions: HHPrediction[] = []
    let programEntries: HHProgramEntry[] = []

    if (latestRun) {
      const [meetingsResult, predictionsResult, entriesResult] = await Promise.all([
        client
          .from('hh_racing_meetings')
          .select('id, source_id, meeting_date, hippodrome, description, scheduled_time, program_url, program_status')
          .gte('meeting_date', latestRun.from_date)
          .lte('meeting_date', latestRun.to_date)
          .order('meeting_date', { ascending: true })
          .order('scheduled_time', { ascending: true }),
        client
          .from('hh_racing_predictions')
          .select('*')
          .eq('run_id', latestRun.id)
          .order('race_date', { ascending: true })
          .order('hippodrome', { ascending: true })
          .order('race_number', { ascending: true })
          .order('win_probability', { ascending: false }),
        client
          .from('hh_racing_program_entries')
          .select('race_date, hippodrome, race_number, horse_key, scheduled_time, program_url, recent_positions, last_dividend')
          .gte('race_date', latestRun.from_date)
          .lte('race_date', latestRun.to_date),
      ])

      if (meetingsResult.error) throw new Error(`hh_racing_meetings: ${meetingsResult.error.message}`)
      if (predictionsResult.error) throw new Error(`hh_racing_predictions: ${predictionsResult.error.message}`)
      if (entriesResult.error) throw new Error(`hh_racing_program_entries: ${entriesResult.error.message}`)

      meetings = (meetingsResult.data ?? []) as HHMeeting[]
      predictions = (predictionsResult.data ?? []) as HHPrediction[]
      programEntries = (entriesResult.data ?? []) as HHProgramEntry[]
    }

    const filteredPredictions = predictions.filter(row => {
      if (selectedDate && row.race_date !== selectedDate) return false
      if (selectedHipodromo && row.hippodrome !== selectedHipodromo) return false
      if (selectedRisk && row.risk !== selectedRisk) return false
      return true
    })

    return {
      counts: {
        sources: sourcesCount,
        meetings: meetingsCount,
        races: racesCount,
        results: resultsCount,
        entries: entriesCount,
        runs: runsCount,
        predictions: predictionsCount,
      },
      sources: (sourcesResult.data ?? []) as HHSource[],
      meetings,
      latestRun,
      predictions,
      filteredPredictions,
      programEntryByKey: new Map(programEntries.map(row => [entryKey(row), row])),
      historicalResults,
      errors,
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Error desconocido cargando HH')
    return {
      counts: { sources: 0, meetings: 0, races: 0, results: 0, entries: 0, runs: 0, predictions: 0 },
      sources: [],
      meetings: [],
      latestRun: null,
      predictions: [],
      filteredPredictions: [],
      programEntryByKey: new Map(),
      historicalResults: [],
      errors,
    }
  }
}

function buildEntityStats(results: HHResult[], kind: 'horse' | 'jockey' | 'trainer' | 'pair') {
  const stats = new Map<string, EntityStat & { totalPosition: number }>()

  for (const row of results) {
    const position = Number(row.final_position)
    if (!Number.isFinite(position) || position <= 0) continue

    let key = row.horse_key
    let label = row.horse
    let secondary: string | null | undefined

    if (kind === 'jockey') {
      if (!row.jockey_key || !row.jockey) continue
      key = row.jockey_key
      label = row.jockey
    }

    if (kind === 'trainer') {
      if (!row.trainer_key || !row.trainer) continue
      key = row.trainer_key
      label = row.trainer
    }

    if (kind === 'pair') {
      if (!row.jockey_key || !row.jockey) continue
      key = `${row.horse_key}::${row.jockey_key}`
      label = row.horse
      secondary = row.jockey
    }

    const current = stats.get(key) ?? {
      key,
      label,
      secondary,
      starts: 0,
      wins: 0,
      podiums: 0,
      avgPosition: 0,
      totalPosition: 0,
      winRate: 0,
      podiumRate: 0,
      lastDate: row.race_date,
    }

    current.starts += 1
    current.wins += position === 1 ? 1 : 0
    current.podiums += position <= 3 ? 1 : 0
    current.totalPosition += position
    current.lastDate = !current.lastDate || row.race_date > current.lastDate ? row.race_date : current.lastDate
    stats.set(key, current)
  }

  return [...stats.values()]
    .map(item => ({
      ...item,
      avgPosition: item.starts ? item.totalPosition / item.starts : 0,
      winRate: item.starts ? item.wins / item.starts : 0,
      podiumRate: item.starts ? item.podiums / item.starts : 0,
    }))
    .sort((a, b) => (
      b.wins - a.wins ||
      b.podiumRate - a.podiumRate ||
      b.starts - a.starts ||
      a.avgPosition - b.avgPosition
    ))
}

function buildRaceSignals(predictions: HHPrediction[]) {
  const groups = new Map<string, HHPrediction[]>()
  for (const row of predictions) {
    const key = raceKey(row)
    groups.set(key, [...(groups.get(key) ?? []), row])
  }

  return [...groups.entries()].map(([key, rows]) => {
    const sorted = rows.sort((a, b) => probabilityPct(b.win_probability) - probabilityPct(a.win_probability))
    const top = sorted[0]
    const second = sorted[1]
    const topWin = probabilityPct(top?.win_probability)
    const secondWin = probabilityPct(second?.win_probability)
    const topPodium = probabilityPct(top?.podium_probability)
    const highRiskCount = sorted.filter(row => row.risk === 'alto').length
    const gap = Math.max(0, topWin - secondWin)
    const clarity = gap + topPodium * 0.12 - highRiskCount * 1.5

    return {
      key,
      date: top.race_date,
      hippodrome: top.hippodrome,
      raceNumber: top.race_number,
      fieldSize: sorted.length,
      topHorse: top.horse,
      topWin,
      topPodium,
      gap,
      highRiskCount,
      clarity,
    }
  }).sort((a, b) => b.clarity - a.clarity)
}

function Pill({
  children,
  tone = 'cyan',
}: {
  children: React.ReactNode
  tone?: 'cyan' | 'emerald' | 'amber' | 'rose' | 'slate'
}) {
  const classes = {
    cyan: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200',
    emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    rose: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
    slate: 'border-slate-700 bg-slate-800/70 text-slate-300',
  }[tone]

  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${classes}`}>{children}</span>
}

function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'cyan',
}: {
  label: string
  value: string
  hint: string
  icon: typeof Database
  tone?: 'cyan' | 'emerald' | 'amber' | 'rose'
}) {
  const toneClass = {
    cyan: 'border-cyan-500/25 bg-cyan-500/10 text-cyan-300',
    emerald: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
    amber: 'border-amber-500/25 bg-amber-500/10 text-amber-300',
    rose: 'border-rose-500/25 bg-rose-500/10 text-rose-300',
  }[tone]

  return (
    <div className={`card min-h-[132px] p-5 ${toneClass}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{label}</p>
        <Icon className="h-4 w-4" />
      </div>
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

function ProbabilityBar({ value, tone = 'cyan' }: { value: number; tone?: 'cyan' | 'emerald' | 'amber' | 'rose' }) {
  const color = {
    cyan: 'bg-cyan-400',
    emerald: 'bg-emerald-400',
    amber: 'bg-amber-400',
    rose: 'bg-rose-400',
  }[tone]

  return (
    <div className="mt-1.5 h-1.5 w-24 overflow-hidden rounded-full bg-slate-800">
      <div className={`${color} h-full rounded-full`} style={{ width: `${Math.max(3, Math.min(100, value))}%` }} />
    </div>
  )
}

function StatTable({ title, rows }: { title: string; rows: EntityStat[] }) {
  return (
    <div className="card p-5">
      <SectionTitle icon={Trophy} title={title} subtitle="Calculado desde resultados historicos guardados en Supabase." />
      <div className="overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Entidad</th>
              <th>Salidas</th>
              <th>Vict.</th>
              <th>Podio</th>
              <th>Prom.</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 5).map(row => (
              <tr key={row.key}>
                <td>
                  <div className="font-medium text-white">{row.label}</div>
                  {row.secondary ? <div className="text-xs text-slate-500">{row.secondary}</div> : null}
                </td>
                <td>{formatNumber(row.starts)}</td>
                <td>{formatPct(row.winRate, 1)}</td>
                <td>{formatPct(row.podiumRate, 1)}</td>
                <td>{row.avgPosition.toFixed(1)}</td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-slate-500">Sin historico suficiente.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default async function HHPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  if (!hasSupabasePublicEnv) {
    redirect('/login')
  }

  const params = searchParams ? await searchParams : {}
  const selectedDate = firstParam(params.date) ?? ''
  const selectedHipodromo = firstParam(params.hipodromo) ?? ''
  const selectedRisk = firstParam(params.risk) ?? ''

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

  const data = await loadHHData(supabase as any, params)
  const horseStats = buildEntityStats(data.historicalResults, 'horse')
  const jockeyStats = buildEntityStats(data.historicalResults, 'jockey')
  const trainerStats = buildEntityStats(data.historicalResults, 'trainer')
  const pairStats = buildEntityStats(data.historicalResults, 'pair').filter(row => row.starts >= 2)
  const raceSignals = buildRaceSignals(data.predictions)
  const availableDates = [...new Set(data.meetings.map(meeting => meeting.meeting_date))].sort()
  const availableHipodromos = [...new Set(data.meetings.map(meeting => meeting.hippodrome))].sort()
  const availableRisks = [...new Set(data.predictions.map(row => row.risk).filter(Boolean))].sort()
  const topWin = [...data.predictions].sort((a, b) => probabilityPct(b.win_probability) - probabilityPct(a.win_probability)).slice(0, 5)
  const topPodium = [...data.predictions].sort((a, b) => probabilityPct(b.podium_probability) - probabilityPct(a.podium_probability)).slice(0, 5)
  const latestRunLabel = data.latestRun ? `${formatLocalDate(data.latestRun.from_date)} a ${formatLocalDate(data.latestRun.to_date)}` : 'Sin corrida'
  const confidence = confidenceLabel(data.latestRun, data.predictions)

  return (
    <>
      <Header
        title="HH"
        subtitle="Carreras, historico y proyecciones hipicas desde Supabase"
        actions={<Pill tone="emerald"><Lock className="mr-1 h-3 w-3" /> {HH_ALLOWED_EMAIL}</Pill>}
      />

      <div className="space-y-6 p-6" data-testid="hh-dashboard">
        <section className="overflow-hidden rounded-xl border border-slate-800 bg-[#111a31]">
          <div className="grid gap-0 xl:grid-cols-[1fr_360px]">
            <div className="p-6">
              <div className="flex flex-wrap gap-2">
                <Pill>Semana {latestRunLabel}</Pill>
                <Pill tone={confidence === 'Operativo' ? 'emerald' : 'amber'}>Confianza {confidence}</Pill>
                <Pill tone="slate">Modelo {data.latestRun?.model_version ?? 'pendiente'}</Pill>
              </div>
              <h1 className="mt-5 max-w-4xl text-3xl font-semibold leading-tight text-white">
                Dashboard HH con carreras y proyecciones cargadas
              </h1>
              <p className="mt-4 max-w-3xl text-sm leading-6 text-slate-300">
                La vista ahora lee Supabase en vivo: historico, calendario semanal, inscritos parseados,
                probabilidades base y rankings. Cuando un programa aun no esta publicado queda marcado
                como pendiente, sin inventar inscritos.
              </p>
            </div>

            <div className="border-t border-slate-800 bg-slate-950/40 p-6 xl:border-l xl:border-t-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <ShieldAlert className="h-4 w-4 text-amber-300" />
                Control de calidad
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-300">
                Las probabilidades son escenarios estadisticos, no certeza de apuesta. El motor queda listo
                para backtest y calibracion; un 90% defendible exige validacion fuera de muestra.
              </p>
              <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                <div className="text-xs uppercase tracking-[0.16em] text-slate-500">Ultima corrida</div>
                <div className="mt-1 text-sm font-medium text-white">{formatDateTime(data.latestRun?.completed_at ?? data.latestRun?.created_at)}</div>
              </div>
            </div>
          </div>
        </section>

        {data.errors.length ? (
          <section className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-100">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div>
                <div className="font-semibold">No pude cargar todo el tablero HH.</div>
                <div className="mt-1 text-rose-200/80">{data.errors.join(' | ')}</div>
              </div>
            </div>
          </section>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard icon={CalendarDays} label="Reuniones" value={formatNumber(data.counts.meetings)} hint="Historico + semana objetivo almacenados." />
          <MetricCard icon={Trophy} label="Carreras historicas" value={formatNumber(data.counts.races)} hint="Resultados oficiales normalizados por carrera." tone="emerald" />
          <MetricCard icon={Users} label="Resultados" value={formatNumber(data.counts.results)} hint="Participantes historicos listos para features." tone="amber" />
          <MetricCard icon={Sigma} label="Proyecciones" value={formatNumber(data.counts.predictions)} hint="Filas probabilisticas guardadas por corrida." tone="cyan" />
        </div>

        <section className="card p-5">
          <SectionTitle
            icon={Filter}
            title="Opciones Del Tablero"
            subtitle="Filtra la semana cargada por fecha, hipodromo y riesgo del modelo."
          />
          <form action="/hh" className="grid gap-3 md:grid-cols-[1fr_1.4fr_1fr_auto_auto]">
            <select name="date" defaultValue={selectedDate} className="input-base">
              <option value="">Todas las fechas</option>
              {availableDates.map(date => <option key={date} value={date}>{formatLocalDate(date)}</option>)}
            </select>
            <select name="hipodromo" defaultValue={selectedHipodromo} className="input-base">
              <option value="">Todos los hipodromos</option>
              {availableHipodromos.map(hipodromo => <option key={hipodromo} value={hipodromo}>{hipodromo}</option>)}
            </select>
            <select name="risk" defaultValue={selectedRisk} className="input-base">
              <option value="">Todos los riesgos</option>
              {availableRisks.map(risk => <option key={risk} value={risk}>{risk}</option>)}
            </select>
            <button type="submit" className="btn-primary justify-center">
              <Filter className="h-4 w-4" />
              Aplicar
            </button>
            <Link href="/hh" className="btn-secondary justify-center">
              <RefreshCcw className="h-4 w-4" />
              Limpiar
            </Link>
          </form>
        </section>

        <section className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
          <div className="card p-5">
            <SectionTitle
              icon={CalendarDays}
              title="Donde Hay Carreras"
              subtitle="Calendario semanal descubierto desde Teletrak y programas oficiales disponibles."
            />
            <div className="space-y-3">
              {data.meetings.map(meeting => {
                const entries = data.predictions.filter(row => row.race_date === meeting.meeting_date && row.hippodrome === meeting.hippodrome).length
                return (
                  <div key={meeting.id} className="rounded-lg border border-slate-800 bg-slate-950/40 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-white">{formatLocalDate(meeting.meeting_date)}</span>
                          <Pill tone="slate">{meeting.scheduled_time?.slice(0, 5) ?? '--:--'}</Pill>
                        </div>
                        <div className="mt-2 text-sm text-slate-300">{meeting.hippodrome}</div>
                        <div className="mt-1 text-xs text-slate-500">{meeting.description ?? 'Sin descripcion'}</div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Pill tone={meeting.program_status === 'available' ? 'emerald' : 'amber'}>
                          {meeting.program_status === 'available' ? 'programa' : 'pendiente'}
                        </Pill>
                        <Pill tone={entries ? 'cyan' : 'slate'}>{entries} inscritos</Pill>
                        {meeting.program_url ? (
                          <a href={meeting.program_url} target="_blank" rel="noreferrer" className="btn-secondary px-3 py-1.5 text-xs">
                            <ExternalLink className="h-3.5 w-3.5" />
                            PDF
                          </a>
                        ) : null}
                      </div>
                    </div>
                  </div>
                )
              })}
              {!data.meetings.length ? <div className="py-8 text-center text-slate-500">No hay calendario cargado.</div> : null}
            </div>
          </div>

          <div className="card p-5">
            <SectionTitle
              icon={BarChart3}
              title="Senal Por Carrera"
              subtitle="Carreras con mayor claridad versus carreras con incertidumbre alta."
            />
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-4">
                <div className="text-sm font-semibold text-emerald-100">Mejor senal estadistica</div>
                <div className="mt-3 space-y-3">
                  {raceSignals.slice(0, 3).map(signal => (
                    <div key={signal.key} className="text-sm">
                      <div className="font-medium text-white">{formatLocalDate(signal.date)} C{signal.raceNumber} - {signal.topHorse}</div>
                      <div className="mt-1 text-xs text-emerald-100/80">{signal.hippodrome} | P(gana) {signal.topWin.toFixed(1)}% | gap {signal.gap.toFixed(1)} pts</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-4">
                <div className="text-sm font-semibold text-rose-100">Mas riesgosas</div>
                <div className="mt-3 space-y-3">
                  {[...raceSignals].sort((a, b) => a.clarity - b.clarity).slice(0, 3).map(signal => (
                    <div key={signal.key} className="text-sm">
                      <div className="font-medium text-white">{formatLocalDate(signal.date)} C{signal.raceNumber} - {signal.topHorse}</div>
                      <div className="mt-1 text-xs text-rose-100/80">{signal.hippodrome} | participantes {signal.fieldSize} | alto riesgo {signal.highRiskCount}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-2">
          <div className="card p-5">
            <SectionTitle icon={Trophy} title="Top 5 Ganar" subtitle="Ranking de probabilidad estimada de victoria en la ultima corrida." />
            <div className="space-y-3">
              {topWin.map(row => (
                <div key={row.id} className="flex items-center justify-between gap-4 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                  <div>
                    <div className="font-medium text-white">#{row.saddle_number ?? '--'} {row.horse}</div>
                    <div className="mt-1 text-xs text-slate-500">{formatLocalDate(row.race_date)} | {row.hippodrome} | Carrera {row.race_number}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm text-cyan-300">{formatPct(row.win_probability)}</div>
                    <ProbabilityBar value={probabilityPct(row.win_probability)} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card p-5">
            <SectionTitle icon={CheckCircle2} title="Top 5 Podio" subtitle="Escenario conservador: mayor probabilidad de entrar 1-2-3." />
            <div className="space-y-3">
              {topPodium.map(row => (
                <div key={row.id} className="flex items-center justify-between gap-4 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                  <div>
                    <div className="font-medium text-white">#{row.saddle_number ?? '--'} {row.horse}</div>
                    <div className="mt-1 text-xs text-slate-500">{formatLocalDate(row.race_date)} | {row.hippodrome} | Carrera {row.race_number}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm text-emerald-300">{formatPct(row.podium_probability)}</div>
                    <ProbabilityBar value={probabilityPct(row.podium_probability)} tone="emerald" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="card p-5">
          <SectionTitle
            icon={Table2}
            title="Proyeccion Por Carrera"
            subtitle={`${formatNumber(data.filteredPredictions.length)} inscritos filtrados desde la corrida vigente.`}
          />
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Hipodromo</th>
                  <th>Carrera</th>
                  <th>Caballo</th>
                  <th>Jockey</th>
                  <th>Preparador</th>
                  <th>P(gana)</th>
                  <th>P(podio)</th>
                  <th>Score</th>
                  <th>Riesgo</th>
                  <th>Comentario tecnico</th>
                </tr>
              </thead>
              <tbody>
                {data.filteredPredictions.slice(0, 120).map(row => {
                  const entry = data.programEntryByKey.get(entryKey(row))
                  const recent = normalizePositions(entry?.recent_positions ?? row.raw_payload?.recent_positions)
                  const dividend = entry?.last_dividend ?? row.raw_payload?.last_dividend
                  return (
                    <tr key={row.id}>
                      <td>{formatLocalDate(row.race_date)}</td>
                      <td className="min-w-[180px]">{row.hippodrome}</td>
                      <td>
                        <div className="font-mono text-white">C{row.race_number}</div>
                        <div className="text-xs text-slate-500">{entry?.scheduled_time ?? '--:--'}</div>
                      </td>
                      <td className="min-w-[180px]">
                        <div className="font-medium text-white">#{row.saddle_number ?? '--'} {row.horse}</div>
                        <div className="text-xs text-slate-500">Ultimas: {recent.length ? recent.join('-') : 'sin dato'}</div>
                      </td>
                      <td>{row.jockey ?? 'sin dato'}</td>
                      <td>{row.trainer ?? 'sin dato'}</td>
                      <td>
                        <div className="font-mono text-cyan-300">{formatPct(row.win_probability)}</div>
                        <ProbabilityBar value={probabilityPct(row.win_probability)} />
                      </td>
                      <td>
                        <div className="font-mono text-emerald-300">{formatPct(row.podium_probability)}</div>
                        <ProbabilityBar value={probabilityPct(row.podium_probability)} tone="emerald" />
                      </td>
                      <td className="font-mono">{formatScore(row.score)}</td>
                      <td><Pill tone={riskTone(row.risk)}>{row.risk}</Pill></td>
                      <td className="min-w-[260px] text-xs leading-5 text-slate-400">
                        OPC {formatScore(row.signal?.option as number | string | null)} | forma {formatScore(row.signal?.recent as number | string | null)} | mercado {formatScore(row.signal?.market as number | string | null)}
                        {dividend ? ` | ult. div ${dividend}` : ''}
                      </td>
                    </tr>
                  )
                })}
                {!data.filteredPredictions.length ? (
                  <tr>
                    <td colSpan={11} className="py-10 text-center text-slate-500">
                      No hay proyecciones para los filtros seleccionados.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-2">
          <StatTable title="Top Caballos Historicos" rows={horseStats.filter(row => row.starts >= 3)} />
          <StatTable title="Top Binomios Caballo-Jockey" rows={pairStats} />
          <StatTable title="Top Jockeys Historicos" rows={jockeyStats.filter(row => row.starts >= 10)} />
          <StatTable title="Top Preparadores Historicos" rows={trainerStats.filter(row => row.starts >= 10)} />
        </section>

        <section className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
          <div className="card p-5">
            <SectionTitle icon={Database} title="Fuentes HH" subtitle="Adapters y fuentes registradas en Supabase." />
            <div className="space-y-3">
              {data.sources.map(source => (
                <div key={source.id} className="rounded-lg border border-slate-800 bg-slate-950/40 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="font-medium text-white">{source.name}</div>
                      <div className="mt-1 text-xs text-slate-500">{source.notes ?? 'Sin notas'}</div>
                    </div>
                    <Pill tone={source.adapter_status.includes('pending') ? 'amber' : 'cyan'}>{source.adapter_status}</Pill>
                  </div>
                  {source.base_url ? (
                    <a href={source.base_url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs text-cyan-300 hover:text-cyan-200">
                      Abrir fuente <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="card p-5">
            <SectionTitle icon={FileText} title="Operacion" subtitle="Comandos que alimentan este tablero en produccion." />
            <div className="space-y-3">
              <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Clock className="h-4 w-4 text-cyan-300" />
                  Historico anual
                </div>
                <code className="mt-3 block rounded-md bg-black/30 p-3 text-xs text-slate-300">
                  npm run ops:hh:pipeline -- --from=2025-05-05 --to=2026-05-03 --target-from=2026-05-04 --target-to=2026-05-10
                </code>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Activity className="h-4 w-4 text-emerald-300" />
                  Semana objetivo
                </div>
                <code className="mt-3 block rounded-md bg-black/30 p-3 text-xs text-slate-300">
                  npm run ops:hh:week -- --from=2026-05-04 --to=2026-05-10 --year=2026 --month=5
                </code>
              </div>
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100">
                Programas pendientes se mantienen como pendientes hasta que Teletrak o el hipodromo publique PDF oficial.
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  )
}
