import { createClient } from '@supabase/supabase-js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const LOCAL_API_URL = process.env.RUT_INTELLIGENCE_API_URL || process.env.NEXT_PUBLIC_APP_URL
const LOCAL_SYNC_TOKEN = process.env.CRM_FEEDBACK_INGEST_TOKEN
const LOCAL_ACTIONS_PATH = process.env.RUT_INTELLIGENCE_ACTIONS_PATH || '/api/commercial-intelligence?section=actions'

const CRM_SUPABASE_URL = process.env.REGISTRO_INTEL_SUPABASE_URL
const CRM_SERVICE_ROLE_KEY =
  process.env.REGISTRO_INTEL_SERVICE_ROLE_KEY ||
  process.env.REGISTRO_INTEL_SUPABASE_SERVICE_ROLE_KEY

if (!LOCAL_API_URL) {
  throw new Error('Falta RUT_INTELLIGENCE_API_URL o NEXT_PUBLIC_APP_URL para leer acciones locales.')
}

if (!LOCAL_SYNC_TOKEN) {
  throw new Error('Falta CRM_FEEDBACK_INGEST_TOKEN para autenticarse contra el API local.')
}

if (!CRM_SUPABASE_URL || !CRM_SERVICE_ROLE_KEY) {
  throw new Error('Faltan REGISTRO_INTEL_SUPABASE_URL o REGISTRO_INTEL_SERVICE_ROLE_KEY para publicar acciones al CRM.')
}

const crm = createClient(CRM_SUPABASE_URL, CRM_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const execFileAsync = promisify(execFile)

function buildUrl(base, path) {
  return new URL(path, base).toString()
}

async function fetchLocalActions() {
  if (!LOCAL_API_URL) {
    throw new Error('No hay URL API local configurada')
  }

  const response = await fetch(buildUrl(LOCAL_API_URL, LOCAL_ACTIONS_PATH), {
    headers: {
      'x-crm-sync-secret': LOCAL_SYNC_TOKEN,
    },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Error leyendo feed local de acciones: ${response.status} ${text}`)
  }

  const json = await response.json()
  if (!json?.success || !json?.data) {
    throw new Error('La respuesta local no trajo un payload de acciones válido.')
  }

  return json.data
}

async function generateActionsFromCode() {
  const { stdout } = await execFileAsync(
    'npx',
    ['--yes', 'tsx', 'scripts/crm-actions-sync/generate-action-feed.ts'],
    {
      env: process.env,
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
    }
  )

  const parsed = JSON.parse(stdout)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('La generación local del feed no devolvió un JSON válido.')
  }

  return parsed
}

async function getActionsPayload() {
  try {
    return await generateActionsFromCode()
  } catch (error) {
    console.warn('[push-registro-intel] fallback a feed HTTP:', error instanceof Error ? error.message : error)
    return fetchLocalActions()
  }
}

async function insertRun(actions) {
  const { data, error } = await crm
    .from('commercial_brain_action_runs')
    .insert({
      source_system: actions.source_system,
      generated_at: actions.generated_at,
      portfolio_status: actions.portfolio_status ?? {},
      executive_summary: actions.executive_summary ?? null,
      metadata: {
        recommendations: actions.recommendations?.length ?? 0,
        campaign_instructions: actions.campaign_instructions?.length ?? 0,
        lead_instructions: actions.lead_instructions?.length ?? 0,
      },
    })
    .select('id')
    .single()

  if (error || !data?.id) {
    throw new Error(`No pude crear commercial_brain_action_run: ${error?.message ?? 'sin id'}`)
  }

  return data.id
}

async function insertCampaignActions(runId, actions) {
  const rows = (actions.campaign_instructions ?? []).map(item => ({
    run_id: runId,
    campaign_name: item.campaign_name,
    severity: item.severity,
    health_score: item.health_score,
    underperformance_hours: item.underperformance_hours,
    recommended_action: item.recommended_action,
    recommended_adjustments: item.recommended_adjustments ?? [],
    best_next_window: item.best_next_window ?? null,
    top_channel: item.top_channel ?? null,
    probable_causes: item.probable_causes ?? [],
  }))

  if (!rows.length) return 0

  const { error } = await crm
    .from('commercial_brain_campaign_actions')
    .insert(rows)

  if (error) {
    throw new Error(`No pude insertar campaign actions: ${error.message}`)
  }

  return rows.length
}

async function insertLeadActions(runId, actions) {
  const rows = (actions.lead_instructions ?? []).map(item => ({
    run_id: runId,
    rutid: item.rutid,
    campaign_name: item.campaign_name ?? null,
    dynamic_priority_score: item.dynamic_priority_score,
    contact_probability: item.contact_probability,
    conversion_probability: item.conversion_probability,
    fatigue_score: item.fatigue_score,
    optimal_window: item.optimal_window ?? null,
    recommended_channel: item.recommended_channel ?? null,
    next_best_action: item.next_best_action ?? null,
    reason_tags: item.reason_tags ?? [],
  }))

  if (!rows.length) return 0

  const { error } = await crm
    .from('commercial_brain_lead_actions')
    .insert(rows)

  if (error) {
    throw new Error(`No pude insertar lead actions: ${error.message}`)
  }

  return rows.length
}

async function applyRun(runId) {
  const { data, error } = await crm.rpc('apply_commercial_brain_run', {
    p_run_id: runId,
  })

  if (error) {
    throw new Error(`No pude aplicar el run al CRM: ${error.message}`)
  }

  return data
}

async function main() {
  const actions = await getActionsPayload()
  const runId = await insertRun(actions)
  const campaignCount = await insertCampaignActions(runId, actions)
  const leadCount = await insertLeadActions(runId, actions)
  const applyResult = await applyRun(runId)

  console.log(JSON.stringify({
    ok: true,
    run_id: runId,
    pushed_at: new Date().toISOString(),
    campaign_instructions: campaignCount,
    lead_instructions: leadCount,
    apply_result: applyResult,
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
