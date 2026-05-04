import { db } from '@/lib/db/supabase'
import { getCommercialBrainOverview } from '@/lib/services/commercial-brain'
import { getCommercialOverview } from '@/lib/services/commercial-intelligence'
import { previewEquifaxLeadScenarios } from '@/lib/services/equifax-bdd'
import { buildEquifaxProjectionSummary } from '@/lib/services/equifax-scoring'
import type {
  CommercialBrainOverview,
  CommercialOverview,
  MiroFishScenarioPhase,
  MiroFishScenarioRun,
  MiroFishScenarioScope,
  MiroFishScenarioStartRequest,
} from '@/types'
import type { EquifaxLeadGenerationParams, EquifaxLeadPreviewResult } from '@/types/equifax'

const MIROFISH_API_URL = process.env.MIROFISH_API_URL
const MIROFISH_API_KEY = process.env.MIROFISH_API_KEY
const DEFAULT_SYNC_BATCH = 10
const DEFAULT_REPORT_SUMMARY_CHARS = 1600

type ScenarioLifecycleStatus = MiroFishScenarioRun['status']

type ScenarioRow = {
  id: string
  title: string
  scenario_scope: MiroFishScenarioScope
  status: ScenarioLifecycleStatus
  phase: MiroFishScenarioPhase
  simulation_requirement: string
  hypothesis: string | null
  additional_context: string | null
  scenario_pack_markdown: string
  source_payload: Record<string, unknown> | null
  remote_project_id: string | null
  remote_graph_id: string | null
  remote_graph_task_id: string | null
  remote_simulation_id: string | null
  remote_prepare_task_id: string | null
  remote_report_task_id: string | null
  remote_report_id: string | null
  remote_status_payload: Record<string, unknown> | null
  report_markdown: string | null
  report_summary: string | null
  last_error: string | null
  created_by: string | null
  started_at: string
  completed_at: string | null
  last_synced_at: string | null
  created_at: string
  updated_at: string
}

type RemoteEnvelope<T> = {
  success?: boolean
  error?: string
  message?: string
  data?: T
}

type RemoteTask = {
  task_id?: string
  status?: string
  progress?: number
  message?: string
  result?: Record<string, unknown> | null
}

type RemoteProject = {
  project_id: string
  name?: string
  status?: string
  graph_id?: string | null
  graph_build_task_id?: string | null
  simulation_requirement?: string | null
  ontology?: Record<string, unknown> | null
  analysis_summary?: string | null
  error?: string | null
}

type RemoteSimulation = {
  simulation_id: string
  project_id?: string
  graph_id?: string
  status?: string
  entities_count?: number
  profiles_count?: number
  current_round?: number
  error?: string | null
}

type RemoteRunStatus = {
  simulation_id: string
  runner_status: string
  current_round?: number
  total_rounds?: number
  progress_percent?: number
  simulated_hours?: number
  total_simulation_hours?: number
  twitter_running?: boolean
  reddit_running?: boolean
  total_actions_count?: number
}

type RemoteReport = {
  report_id: string
  simulation_id: string
  status?: string
  markdown_content?: string
  outline?: Record<string, unknown>
  created_at?: string
  completed_at?: string | null
}

type RemotePrepareStatus = {
  status?: string
  progress?: number
  message?: string
  already_prepared?: boolean
  prepare_info?: Record<string, unknown>
}

type RemoteReportStatus = {
  status?: string
  progress?: number
  message?: string
  report_id?: string
  already_completed?: boolean
}

type ScenarioPack = {
  title: string
  simulationRequirement: string
  markdown: string
  sourcePayload: Record<string, unknown>
}

type ScenarioSyncPatch = Partial<ScenarioRow> & {
  remote_status_payload?: Record<string, unknown>
}

function ensureMiroFishConfigured() {
  if (!MIROFISH_API_URL) {
    throw new Error('MIROFISH_API_URL no configurada.')
  }
}

function toArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : []
}

function compactText(value?: string | null): string | null {
  if (!value) return null
  const normalized = value.trim()
  return normalized || null
}

function toJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function mapScenarioRow(row: ScenarioRow): MiroFishScenarioRun {
  return {
    ...row,
    source_payload: row.source_payload ?? {},
    remote_status_payload: row.remote_status_payload ?? {},
  }
}

function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function cleanMarkdownSnippet(value?: string | null, limit = DEFAULT_REPORT_SUMMARY_CHARS): string | null {
  const normalized = compactText(value)
  if (!normalized) return null

  const clean = normalized
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return clean.slice(0, limit)
}

function renderList(items: string[], fallback = 'Sin hallazgos relevantes.'): string {
  if (!items.length) return `- ${fallback}`
  return items.map(item => `- ${item}`).join('\n')
}

function renderTopOpportunityLines(overview: CommercialOverview): string {
  const rows = toArray(overview.top_opportunities).slice(0, 8)
  if (!rows.length) return '- No hay oportunidades priorizadas en este momento.'

  return rows.map(item => {
    const name = item.rutid
    return [
      `- ${name}`,
      `  prioridad=${item.priority_score}`,
      ` contacto=${item.contactability_score}`,
      ` compra=${item.purchase_propensity_score}`,
      ` accion=${item.next_best_action}`,
      ` canal=${item.best_channel}`,
    ].filter(Boolean).join(' | ')
  }).join('\n')
}

function renderCampaignLines(brain: CommercialBrainOverview): string {
  const campaigns = toArray(brain.campaigns).slice(0, 6)
  if (!campaigns.length) return '- No hay campanas activas relevantes.'

  return campaigns.map(campaign => (
    `- ${campaign.campaign_name}: severidad=${campaign.severity}, health=${campaign.health_score}, ` +
    `contacto_actual=${campaign.current_contact_rate}%, baseline_contacto=${campaign.baseline_contact_rate}%, ` +
    `venta_actual=${campaign.current_conversion_rate}%, baseline_venta=${campaign.baseline_conversion_rate}%`
  )).join('\n')
}

function renderRecommendationLines(brain: CommercialBrainOverview): string {
  const recommendations = toArray(brain.recommendations).slice(0, 8)
  if (!recommendations.length) return '- Sin recomendaciones nuevas.'

  return recommendations.map(item => (
    `- [${item.priority}] ${item.title}: ${item.action} Impacto esperado: ${item.impact}`
  )).join('\n')
}

function renderLeadActionLines(brain: CommercialBrainOverview): string {
  const leads = toArray(brain.lead_actions).slice(0, 10)
  if (!leads.length) return '- Sin leads destacados para esta corrida.'

  return leads.map(lead => {
    const name = lead.nombre_completo ?? lead.rutid
    return [
      `- ${name}`,
      `  prioridad_dinamica=${round(lead.dynamic_priority_score, 1)}`,
      ` contacto=${round(lead.contact_probability, 1)}%`,
      ` conversion=${round(lead.conversion_probability, 1)}%`,
      ` ventana=${lead.optimal_window}`,
      ` canal=${lead.recommended_channel}`,
      ` accion=${lead.next_best_action}`,
    ].join(' | ')
  }).join('\n')
}

function renderWindowLines(brain: CommercialBrainOverview): string {
  const windows = toArray(brain.optimal_windows).slice(0, 5)
  if (!windows.length) return '- No hay ventanas optimas calculadas.'

  return windows.map(window => (
    `- ${window.label}: score=${window.score}, contacto=${window.contact_rate}%, conversion=${window.conversion_rate}%`
  )).join('\n')
}

function buildDefaultSimulationRequirement(input: MiroFishScenarioStartRequest): string {
  return [
    `Simula la evolucion del portafolio comercial descrito en este dossier para evaluar la hipotesis: "${input.hypothesis}".`,
    'Necesito proyectar cambios de contactabilidad, fatiga comercial, conversion, saturacion operativa y posible deterioro tactico.',
    'Incluye interacciones entre prospectos, decisores, agentes, campanas, canales y factores externos del mercado.',
    'Entrega un reporte que recomiende que hacer primero, que evitar y que senales deberiamos monitorear en la operacion real.',
  ].join(' ')
}

async function buildScenarioPack(input: MiroFishScenarioStartRequest): Promise<ScenarioPack> {
  const scope = input.scope ?? 'commercial_brain'
  const includeEquifaxProjection = input.include_equifax_projection !== false

  const [overview, brain, equifaxProjection, equifaxPreview] = await Promise.all([
    getCommercialOverview(),
    getCommercialBrainOverview(),
    includeEquifaxProjection ? buildEquifaxProjectionSummary() : Promise.resolve(null),
    input.equifax_generation_params
      ? previewEquifaxLeadScenarios(input.equifax_generation_params as unknown as EquifaxLeadGenerationParams)
      : Promise.resolve<EquifaxLeadPreviewResult | null>(null),
  ])

  const simulationRequirement =
    compactText(input.simulation_requirement) ??
    buildDefaultSimulationRequirement(input)

  const snapshot = brain.snapshot
  const scenarioPack = [
    `# ${input.title}`,
    '## Objetivo de simulacion',
    simulationRequirement,
    '## Hipotesis principal',
    input.hypothesis,
    '## Scope operacional',
    `- scope=${scope}
- fecha_generacion=${new Date().toISOString()}
- fuente_principal=rut-intelligence
- contexto=score comercial + brain tactico + feedback operativo`,
    input.additional_context ? `## Contexto adicional\n${input.additional_context}` : null,
    '## Snapshot cuantitativo del cerebro local',
    [
      `- personas_scored=${overview.total_scored_personas}`,
      `- personas_con_feedback=${overview.with_feedback}`,
      `- personas_alta_prioridad=${overview.high_priority_personas}`,
      `- avg_contactability=${overview.avg_contactability_score}`,
      `- avg_purchase_propensity=${overview.avg_purchase_propensity_score}`,
      `- avg_priority=${overview.avg_priority_score}`,
      `- feedback_sync=${overview.last_feedback_sync ?? 'sin dato'}`,
      `- score_refresh=${overview.last_score_refresh ?? 'sin dato'}`,
      `- health_score_portafolio=${snapshot.overall_health_score}`,
      `- campanas_activas=${snapshot.active_campaigns}`,
      `- campanas_en_riesgo=${snapshot.campaigns_at_risk}`,
      `- campanas_criticas=${snapshot.critical_campaigns}`,
      `- current_contact_rate=${snapshot.current_contact_rate}`,
      `- expected_contact_rate=${snapshot.expected_contact_rate}`,
      `- current_conversion_rate=${snapshot.current_conversion_rate}`,
      `- expected_conversion_rate=${snapshot.expected_conversion_rate}`,
    ].join('\n'),
    '## Campanas monitoreadas',
    renderCampaignLines(brain),
    '## Recomendaciones actuales del motor local',
    renderRecommendationLines(brain),
    '## Ventanas operativas sugeridas',
    renderWindowLines(brain),
    '## Leads dinamicos prioritarios',
    renderLeadActionLines(brain),
    '## Top opportunities estaticas',
    renderTopOpportunityLines(overview),
    brain.ai_executive_summary ? `## Resumen ejecutivo IA local\n${brain.ai_executive_summary}` : null,
    includeEquifaxProjection && equifaxProjection
      ? [
          '## Proyeccion base Equifax',
          `- portfolio_expected_contacts=${equifaxProjection.portfolio.expected_contacts}`,
          `- portfolio_expected_interests=${equifaxProjection.portfolio.expected_interests}`,
          `- portfolio_expected_purchases=${equifaxProjection.portfolio.expected_purchases}`,
          `- top_1000_expected_contacts=${equifaxProjection.top_1000.expected_contacts}`,
          `- top_1000_expected_purchases=${equifaxProjection.top_1000.expected_purchases}`,
          `- top_3000_expected_contacts=${equifaxProjection.top_3000.expected_contacts}`,
          `- top_3000_expected_purchases=${equifaxProjection.top_3000.expected_purchases}`,
        ].join('\n')
      : null,
    equifaxPreview
      ? [
          '## Escenarios Equifax sugeridos',
          `- recommended_scenario_key=${equifaxPreview.recommended_scenario_key}`,
          `- universe_analyzed=${equifaxPreview.universe_analyzed}`,
          `- eligible_matches=${equifaxPreview.eligible_matches}`,
          '',
          ...equifaxPreview.scenarios.slice(0, 3).map(scenario => (
            `### ${scenario.title}
- key=${scenario.key}
- generated_count=${scenario.generated_count}
- avg_priority_score=${scenario.summary.avg_priority_score}
- avg_contactability_score=${scenario.summary.avg_contactability_score}
- avg_purchase_propensity_score=${scenario.summary.avg_purchase_propensity_score}
- highlights=${scenario.highlights.join(' | ')}`
          )),
        ].join('\n')
      : null,
    '## Instrucciones de analisis para MiroFish',
    renderList([
      'Modela agentes que representen prospectos, decisores, operadores de contact center, campanas, canales y fuerzas externas del mercado.',
      'Evalua como cambia la intencion de respuesta si subimos o bajamos intensidad comercial, cambiamos ventana horaria o redistribuimos segmentos.',
      'Identifica umbrales de fatiga, riesgo de rechazo, saturacion operativa o deterioro de conversion.',
      'Devuelve un reporte accionable con senales tempranas, escenarios favorables/adversos y decisiones recomendadas para la operacion real.',
    ]),
    '## Datos estructurados de referencia',
    `\`\`\`json
${JSON.stringify(
  {
    title: input.title,
    scope,
    hypothesis: input.hypothesis,
    commercial_overview: {
      total_scored_personas: overview.total_scored_personas,
      with_feedback: overview.with_feedback,
      high_priority_personas: overview.high_priority_personas,
      avg_contactability_score: overview.avg_contactability_score,
      avg_purchase_propensity_score: overview.avg_purchase_propensity_score,
      avg_priority_score: overview.avg_priority_score,
    },
    brain_snapshot: snapshot,
    top_recommendations: brain.recommendations.slice(0, 5),
    top_campaigns: brain.campaigns.slice(0, 5),
    top_windows: brain.optimal_windows.slice(0, 5),
    top_lead_actions: brain.lead_actions.slice(0, 8),
    equifax_projection: equifaxProjection,
    equifax_preview: equifaxPreview,
  },
  null,
  2
)}
\`\`\``,
  ].filter(Boolean).join('\n\n')

  return {
    title: input.title,
    simulationRequirement,
    markdown: scenarioPack,
    sourcePayload: {
      scope,
      hypothesis: input.hypothesis,
      include_equifax_projection: includeEquifaxProjection,
      commercial_overview: {
        total_scored_personas: overview.total_scored_personas,
        with_feedback: overview.with_feedback,
        high_priority_personas: overview.high_priority_personas,
        avg_contactability_score: overview.avg_contactability_score,
        avg_purchase_propensity_score: overview.avg_purchase_propensity_score,
        avg_priority_score: overview.avg_priority_score,
      },
      brain_snapshot: snapshot,
      top_campaigns: brain.campaigns.slice(0, 5).map(item => ({
        campaign_name: item.campaign_name,
        severity: item.severity,
        health_score: item.health_score,
      })),
      top_recommendations: brain.recommendations.slice(0, 5),
      top_leads: brain.lead_actions.slice(0, 10),
      equifax_projection: equifaxProjection,
      equifax_preview: equifaxPreview,
      user_options: {
        max_rounds: input.max_rounds ?? null,
      },
    },
  }
}

function getMiroFishHeaders(headers?: HeadersInit): HeadersInit {
  return {
    ...(headers ?? {}),
    ...(MIROFISH_API_KEY ? { 'x-api-key': MIROFISH_API_KEY } : {}),
  }
}

async function requestMiroFish<T>(
  path: string,
  init?: RequestInit,
  options?: { allow404?: boolean }
): Promise<T | null> {
  ensureMiroFishConfigured()

  const url = new URL(path, MIROFISH_API_URL)
  const response = await fetch(url.toString(), {
    ...init,
    headers: getMiroFishHeaders(init?.headers),
    cache: 'no-store',
  })

  if (response.status === 404 && options?.allow404) return null

  let payload: RemoteEnvelope<T> | string | null = null
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    payload = await response.json()
  } else {
    payload = await response.text()
  }

  if (!response.ok) {
    if (typeof payload === 'string') {
      throw new Error(`MiroFish error ${response.status}: ${payload}`)
    }
    throw new Error(`MiroFish error ${response.status}: ${payload?.error ?? payload?.message ?? 'sin detalle'}`)
  }

  if (typeof payload === 'string') {
    return payload as T
  }

  if (payload?.success === false) {
    throw new Error(payload.error ?? payload.message ?? 'MiroFish devolvio success=false')
  }

  return (payload?.data ?? null) as T | null
}

async function createRemoteProject(pack: ScenarioPack) {
  const formData = new FormData()
  formData.append('project_name', pack.title)
  formData.append('simulation_requirement', pack.simulationRequirement)
  formData.append('additional_context', 'Documento semilla generado por rut-intelligence para simulacion comercial.')
  formData.append(
    'files',
    new Blob([pack.markdown], { type: 'text/markdown' }),
    `${pack.title.replace(/[^a-z0-9]+/gi, '_').toLowerCase() || 'scenario_pack'}.md`
  )

  return requestMiroFish<{
    project_id: string
    ontology?: Record<string, unknown>
    total_text_length?: number
  }>('/api/graph/ontology/generate', {
    method: 'POST',
    body: formData,
  })
}

async function buildRemoteGraph(projectId: string, title: string) {
  return requestMiroFish<{ project_id: string; task_id: string; message?: string }>('/api/graph/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_id: projectId,
      graph_name: `${title} Graph`,
    }),
  })
}

async function getRemoteProject(projectId: string) {
  return requestMiroFish<RemoteProject>(`/api/graph/project/${projectId}`, undefined, { allow404: true })
}

async function getRemoteTask(taskId: string) {
  return requestMiroFish<RemoteTask>(`/api/graph/task/${taskId}`, undefined, { allow404: true })
}

async function createRemoteSimulation(projectId: string, graphId: string) {
  return requestMiroFish<RemoteSimulation>('/api/simulation/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_id: projectId,
      graph_id: graphId,
      enable_twitter: true,
      enable_reddit: true,
    }),
  })
}

async function getRemoteSimulation(simulationId: string) {
  return requestMiroFish<RemoteSimulation>(`/api/simulation/${simulationId}`, undefined, { allow404: true })
}

async function prepareRemoteSimulation(simulationId: string) {
  return requestMiroFish<{
    simulation_id: string
    task_id?: string
    status?: string
    already_prepared?: boolean
    prepare_info?: Record<string, unknown>
  }>('/api/simulation/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      simulation_id: simulationId,
      use_llm_for_profiles: true,
      parallel_profile_count: 4,
    }),
  })
}

async function getRemotePrepareStatus(simulationId: string, taskId?: string | null) {
  return requestMiroFish<RemotePrepareStatus>('/api/simulation/prepare/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      simulation_id: simulationId,
      task_id: taskId ?? undefined,
    }),
  })
}

async function startRemoteSimulation(simulationId: string, maxRounds?: number | null) {
  return requestMiroFish<Record<string, unknown>>('/api/simulation/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      simulation_id: simulationId,
      platform: 'parallel',
      max_rounds: maxRounds ?? undefined,
      enable_graph_memory_update: false,
      force: false,
    }),
  })
}

async function getRemoteRunStatus(simulationId: string) {
  return requestMiroFish<RemoteRunStatus>(`/api/simulation/${simulationId}/run-status`, undefined, { allow404: true })
}

async function getRemoteReportBySimulation(simulationId: string) {
  return requestMiroFish<RemoteReport>(`/api/report/by-simulation/${simulationId}`, undefined, { allow404: true })
}

async function generateRemoteReport(simulationId: string) {
  return requestMiroFish<{
    simulation_id: string
    report_id?: string
    task_id?: string
    status?: string
    already_generated?: boolean
  }>('/api/report/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      simulation_id: simulationId,
      force_regenerate: false,
    }),
  })
}

async function getRemoteReportStatus(simulationId: string, taskId?: string | null) {
  return requestMiroFish<RemoteReportStatus>('/api/report/generate/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      simulation_id: simulationId,
      task_id: taskId ?? undefined,
    }),
  })
}

async function getRemoteReport(reportId: string) {
  return requestMiroFish<RemoteReport>(`/api/report/${reportId}`, undefined, { allow404: true })
}

async function fetchScenarioRunRow(runId: string): Promise<ScenarioRow | null> {
  const { data, error } = await db
    .from('mirofish_scenario_runs')
    .select('*')
    .eq('id', runId)
    .maybeSingle()

  if (error) {
    throw new Error(`No se pudo leer la corrida MiroFish ${runId}: ${error.message}`)
  }

  return (data as ScenarioRow | null) ?? null
}

async function updateScenarioRunRow(runId: string, patch: ScenarioSyncPatch): Promise<MiroFishScenarioRun> {
  const current = await fetchScenarioRunRow(runId)
  if (!current) {
    throw new Error(`Corrida MiroFish no encontrada: ${runId}`)
  }

  const mergedRemoteStatus = {
    ...(current.remote_status_payload ?? {}),
    ...(patch.remote_status_payload ?? {}),
  }

  const nextPatch: Record<string, unknown> = {
    ...patch,
    remote_status_payload: mergedRemoteStatus,
    updated_at: new Date().toISOString(),
  }

  if (!patch.last_synced_at) {
    nextPatch.last_synced_at = new Date().toISOString()
  }

  if ((patch.status === 'completed' || patch.status === 'failed') && !current.completed_at) {
    nextPatch.completed_at = new Date().toISOString()
  }

  const { data, error } = await db
    .from('mirofish_scenario_runs')
    .update(nextPatch)
    .eq('id', runId)
    .select('*')
    .single()

  if (error) {
    throw new Error(`No se pudo actualizar la corrida MiroFish ${runId}: ${error.message}`)
  }

  return mapScenarioRow(data as ScenarioRow)
}

async function failScenarioRun(runId: string, error: unknown, remoteStatusPayload?: Record<string, unknown>) {
  const message = error instanceof Error ? error.message : 'Error no identificado en corrida MiroFish.'
  return updateScenarioRunRow(runId, {
    status: 'failed',
    last_error: message,
    remote_status_payload: remoteStatusPayload,
  })
}

function getDesiredMaxRounds(run: MiroFishScenarioRun): number | null {
  const userOptions = toJsonObject(run.source_payload.user_options)
  const maxRounds = userOptions.max_rounds
  return typeof maxRounds === 'number' && Number.isFinite(maxRounds) && maxRounds > 0
    ? Math.round(maxRounds)
    : null
}

async function syncScenarioRunOnce(run: MiroFishScenarioRun): Promise<{ run: MiroFishScenarioRun; progressed: boolean }> {
  const projectId = run.remote_project_id
  if (!projectId) {
    return {
      run: await failScenarioRun(run.id, new Error('La corrida no tiene remote_project_id.')),
      progressed: true,
    }
  }

  const project = await getRemoteProject(projectId)
  if (!project) {
    return {
      run: await failScenarioRun(run.id, new Error(`MiroFish no encontro el proyecto ${projectId}.`)),
      progressed: true,
    }
  }

  if (project.error || project.status === 'failed') {
    return {
      run: await failScenarioRun(run.id, new Error(project.error ?? 'Proyecto MiroFish en estado failed.'), { project }),
      progressed: true,
    }
  }

  if (!project.graph_id) {
    const graphTask = run.remote_graph_task_id ? await getRemoteTask(run.remote_graph_task_id) : null
    if (graphTask?.status === 'failed') {
      return {
        run: await failScenarioRun(run.id, new Error(graphTask.message ?? 'Fallo la construccion del grafo MiroFish.'), {
          project,
          graph_task: graphTask,
        }),
        progressed: true,
      }
    }

    const updated = await updateScenarioRunRow(run.id, {
      status: 'running',
      phase: 'graph_building',
      remote_status_payload: {
        project,
        graph_task: graphTask ?? null,
      },
      last_error: null,
    })

    return { run: updated, progressed: false }
  }

  if (!run.remote_graph_id) {
    const updated = await updateScenarioRunRow(run.id, {
      status: 'running',
      phase: 'graph_ready',
      remote_graph_id: project.graph_id,
      remote_status_payload: { project },
      last_error: null,
    })
    return { run: updated, progressed: true }
  }

  if (!run.remote_simulation_id) {
    const simulation = await createRemoteSimulation(projectId, project.graph_id)
    if (!simulation?.simulation_id) {
      return {
        run: await failScenarioRun(run.id, new Error('MiroFish no devolvio simulation_id al crear la simulacion.'), {
          project,
          simulation: simulation ?? null,
        }),
        progressed: true,
      }
    }

    const updated = await updateScenarioRunRow(run.id, {
      status: 'running',
      phase: 'simulation_created',
      remote_simulation_id: simulation.simulation_id,
      remote_status_payload: {
        project,
        simulation,
      },
      last_error: null,
    })
    return { run: updated, progressed: true }
  }

  const simulation = await getRemoteSimulation(run.remote_simulation_id)
  if (!simulation) {
    return {
      run: await failScenarioRun(run.id, new Error(`MiroFish no encontro la simulacion ${run.remote_simulation_id}.`), {
        project,
      }),
      progressed: true,
    }
  }

  if (simulation.error || simulation.status === 'failed') {
    return {
      run: await failScenarioRun(run.id, new Error(simulation.error ?? 'Simulacion MiroFish en estado failed.'), {
        project,
        simulation,
      }),
      progressed: true,
    }
  }

  if (simulation.status !== 'ready') {
    if (!run.remote_prepare_task_id) {
      const prepare = await prepareRemoteSimulation(run.remote_simulation_id)
      const updated = await updateScenarioRunRow(run.id, {
        status: 'running',
        phase: prepare?.status === 'ready' || prepare?.already_prepared ? 'simulation_ready' : 'simulation_preparing',
        remote_prepare_task_id: prepare?.task_id ?? null,
        remote_status_payload: {
          project,
          simulation,
          prepare_status: prepare ?? null,
        },
        last_error: null,
      })
      return { run: updated, progressed: true }
    }

    const prepareStatus = await getRemotePrepareStatus(run.remote_simulation_id, run.remote_prepare_task_id)
    if (prepareStatus?.status === 'failed') {
      return {
        run: await failScenarioRun(run.id, new Error(prepareStatus.message ?? 'Fallo el prepare de MiroFish.'), {
          project,
          simulation,
          prepare_status: prepareStatus,
        }),
        progressed: true,
      }
    }

    if (prepareStatus?.status === 'ready' || prepareStatus?.already_prepared) {
      const updated = await updateScenarioRunRow(run.id, {
        status: 'running',
        phase: 'simulation_ready',
        remote_status_payload: {
          project,
          simulation: {
            ...simulation,
            status: 'ready',
          },
          prepare_status: prepareStatus,
        },
        last_error: null,
      })
      return { run: updated, progressed: true }
    }

    const updated = await updateScenarioRunRow(run.id, {
      status: 'running',
      phase: 'simulation_preparing',
      remote_status_payload: {
        project,
        simulation,
        prepare_status: prepareStatus ?? null,
      },
      last_error: null,
    })
    return { run: updated, progressed: false }
  }

  const runStatus = await getRemoteRunStatus(run.remote_simulation_id)
  if (!runStatus || runStatus.runner_status === 'idle') {
    const startResult = await startRemoteSimulation(run.remote_simulation_id, getDesiredMaxRounds(run))
    const updated = await updateScenarioRunRow(run.id, {
      status: 'running',
      phase: 'simulation_running',
      remote_status_payload: {
        project,
        simulation,
        run_status: {
          runner_status: 'running',
        },
        simulation_start: startResult ?? null,
      },
      last_error: null,
    })
    return { run: updated, progressed: true }
  }

  if (runStatus.runner_status === 'running') {
    const updated = await updateScenarioRunRow(run.id, {
      status: 'running',
      phase: 'simulation_running',
      remote_status_payload: {
        project,
        simulation,
        run_status: runStatus,
      },
      last_error: null,
    })
    return { run: updated, progressed: false }
  }

  if (runStatus.runner_status !== 'completed' && runStatus.runner_status !== 'stopped') {
    const updated = await updateScenarioRunRow(run.id, {
      status: 'running',
      phase: 'simulation_running',
      remote_status_payload: {
        project,
        simulation,
        run_status: runStatus,
      },
      last_error: null,
    })
    return { run: updated, progressed: false }
  }

  const existingReport = await getRemoteReportBySimulation(run.remote_simulation_id)
  if (existingReport?.report_id && existingReport.status === 'completed') {
    const markdown = existingReport.markdown_content ?? null
    const updated = await updateScenarioRunRow(run.id, {
      status: 'completed',
      phase: 'report_ready',
      remote_report_id: existingReport.report_id,
      report_markdown: markdown,
      report_summary: cleanMarkdownSnippet(markdown),
      remote_status_payload: {
        project,
        simulation,
        run_status: runStatus,
        report: existingReport,
      },
      last_error: null,
    })
    return { run: updated, progressed: true }
  }

  if (!run.remote_report_task_id) {
    const generateReport = await generateRemoteReport(run.remote_simulation_id)
    const updated = await updateScenarioRunRow(run.id, {
      status: generateReport?.already_generated ? 'completed' : 'running',
      phase: generateReport?.already_generated ? 'report_ready' : 'report_generating',
      remote_report_task_id: generateReport?.task_id ?? null,
      remote_report_id: generateReport?.report_id ?? null,
      remote_status_payload: {
        project,
        simulation,
        run_status: runStatus,
        report_generation: generateReport ?? null,
      },
      last_error: null,
    })
    return { run: updated, progressed: true }
  }

  const reportStatus = await getRemoteReportStatus(run.remote_simulation_id, run.remote_report_task_id)
  if (reportStatus?.status === 'failed') {
    return {
      run: await failScenarioRun(run.id, new Error(reportStatus.message ?? 'Fallo la generacion del reporte MiroFish.'), {
        project,
        simulation,
        run_status: runStatus,
        report_status: reportStatus,
      }),
      progressed: true,
    }
  }

  const reportId = reportStatus?.report_id ?? run.remote_report_id
  if (reportId && (reportStatus?.status === 'completed' || reportStatus?.already_completed)) {
    const report = await getRemoteReport(reportId)
    const markdown = report?.markdown_content ?? null
    const updated = await updateScenarioRunRow(run.id, {
      status: 'completed',
      phase: 'report_ready',
      remote_report_id: reportId,
      report_markdown: markdown,
      report_summary: cleanMarkdownSnippet(markdown),
      remote_status_payload: {
        project,
        simulation,
        run_status: runStatus,
        report_status: reportStatus,
        report: report ?? null,
      },
      last_error: null,
    })
    return { run: updated, progressed: true }
  }

  const updated = await updateScenarioRunRow(run.id, {
    status: 'running',
    phase: 'report_generating',
    remote_status_payload: {
      project,
      simulation,
      run_status: runStatus,
      report_status: reportStatus ?? null,
    },
    last_error: null,
  })
  return { run: updated, progressed: false }
}

export async function listMiroFishScenarioRuns(limit = 20): Promise<MiroFishScenarioRun[]> {
  const { data, error } = await db
    .from('mirofish_scenario_runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    throw new Error(`No se pudo listar corridas MiroFish: ${error.message}`)
  }

  return toArray(data as ScenarioRow[]).map(mapScenarioRow)
}

export async function getMiroFishScenarioRun(runId: string): Promise<MiroFishScenarioRun | null> {
  const row = await fetchScenarioRunRow(runId)
  return row ? mapScenarioRow(row) : null
}

export async function startMiroFishScenarioRun(
  input: MiroFishScenarioStartRequest,
  userId?: string
): Promise<MiroFishScenarioRun> {
  ensureMiroFishConfigured()

  const title = compactText(input.title)
  const hypothesis = compactText(input.hypothesis)
  if (!title) throw new Error('title es requerido para iniciar la corrida MiroFish.')
  if (!hypothesis) throw new Error('hypothesis es requerida para iniciar la corrida MiroFish.')

  const pack = await buildScenarioPack({
    ...input,
    title,
    hypothesis,
  })

  const { data, error } = await db
    .from('mirofish_scenario_runs')
    .insert({
      title,
      scenario_scope: input.scope ?? 'commercial_brain',
      status: 'draft',
      phase: 'pack_built',
      simulation_requirement: pack.simulationRequirement,
      hypothesis,
      additional_context: compactText(input.additional_context),
      scenario_pack_markdown: pack.markdown,
      source_payload: pack.sourcePayload,
      created_by: userId ?? null,
      started_at: new Date().toISOString(),
    })
    .select('*')
    .single()

  if (error) {
    throw new Error(`No se pudo crear la corrida MiroFish local: ${error.message}`)
  }

  const run = mapScenarioRow(data as ScenarioRow)

  try {
    const project = await createRemoteProject(pack)
    if (!project?.project_id) {
      throw new Error('MiroFish no devolvio project_id al generar la ontologia.')
    }

    const graphBuild = await buildRemoteGraph(project.project_id, title)
    if (!graphBuild?.task_id) {
      throw new Error('MiroFish no devolvio task_id para la construccion del grafo.')
    }

    return updateScenarioRunRow(run.id, {
      status: 'running',
      phase: 'graph_building',
      remote_project_id: project.project_id,
      remote_graph_task_id: graphBuild.task_id,
      remote_status_payload: {
        project,
        graph_build: graphBuild,
      },
      last_error: null,
    })
  } catch (startError) {
    await failScenarioRun(run.id, startError)
    throw startError
  }
}

export async function syncMiroFishScenarioRun(runId: string): Promise<MiroFishScenarioRun> {
  const initial = await getMiroFishScenarioRun(runId)
  if (!initial) {
    throw new Error(`Corrida MiroFish no encontrada: ${runId}`)
  }

  if (initial.status === 'completed' || initial.status === 'failed') {
    return initial
  }

  let current = initial
  let remainingSteps = 8

  while (remainingSteps > 0) {
    remainingSteps -= 1

    try {
      const result = await syncScenarioRunOnce(current)
      current = result.run
      if (!result.progressed || current.status === 'completed' || current.status === 'failed') {
        break
      }
    } catch (syncError) {
      current = await failScenarioRun(current.id, syncError)
      break
    }
  }

  return current
}

export async function syncPendingMiroFishScenarioRuns(limit = DEFAULT_SYNC_BATCH): Promise<MiroFishScenarioRun[]> {
  const { data, error } = await db
    .from('mirofish_scenario_runs')
    .select('*')
    .eq('status', 'running')
    .order('last_synced_at', { ascending: true, nullsFirst: true })
    .limit(limit)

  if (error) {
    throw new Error(`No se pudieron leer corridas MiroFish pendientes: ${error.message}`)
  }

  const runs = toArray(data as ScenarioRow[]).map(mapScenarioRow)
  const synced: MiroFishScenarioRun[] = []

  for (const run of runs) {
    synced.push(await syncMiroFishScenarioRun(run.id))
  }

  return synced
}
