import { createClient } from '@supabase/supabase-js'

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.production')

const CRM_SUPABASE_URL = process.env.REGISTRO_INTEL_SUPABASE_URL
const CRM_SERVICE_ROLE_KEY =
  process.env.REGISTRO_INTEL_SERVICE_ROLE_KEY ||
  process.env.REGISTRO_INTEL_SUPABASE_SERVICE_ROLE_KEY

const CHUNK_SIZE = Number(process.env.CRM_DEDUPE_CHUNK_SIZE || 1000)
const UPDATE_CHUNK_SIZE = Number(process.env.CRM_DEDUPE_UPDATE_CHUNK_SIZE || 100)
const ACTIVE_ASSIGNMENT_STATUSES = ['pending', 'assigned', 'in_progress', 'managed']
const ACTIVE_WORKFLOW_STATUSES = ['pending', 'callback', 'active', 'managed']
const DUPLICATE_ASSIGNMENT_STATUS = 'exception'
const DUPLICATE_WORKFLOW_STATUS = 'exception'
const DUPLICATE_REASON = 'DUPLICATE_ACTIVE_LEAD_SUPPRESSED'

const dryRun = process.argv.includes('--dry-run')
const campaignNameFilter = readFlag('campaign-name')
const contactIdFilter = readFlag('contact-id')
const rutFilter = normalizeRut(readFlag('rut'))

if (!CRM_SUPABASE_URL || !CRM_SERVICE_ROLE_KEY) {
  throw new Error('Faltan REGISTRO_INTEL_SUPABASE_URL o REGISTRO_INTEL_SERVICE_ROLE_KEY.')
}

const crm = createClient(CRM_SUPABASE_URL, CRM_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function readFlag(name) {
  const arg = process.argv.find(item => item.startsWith(`--${name}=`))
  if (!arg) return null
  return arg.split('=').slice(1).join('=').trim() || null
}

function normalizeRut(value) {
  const compact = String(value ?? '').toUpperCase().replace(/[^0-9K]/g, '')
  return compact || null
}

function activeKey(lead) {
  if (!lead.campaign_id || !lead.contact_id) return null
  return `${lead.campaign_id}:${lead.contact_id}`
}

function parseTime(value) {
  const parsed = value ? new Date(value).getTime() : 0
  return Number.isFinite(parsed) ? parsed : 0
}

function statusRank(status) {
  switch (status) {
    case 'managed':
      return 50
    case 'assigned':
      return 40
    case 'in_progress':
      return 35
    case 'pending':
      return 10
    default:
      return 0
  }
}

function keepScore(lead) {
  return (
    statusRank(lead.assignment_status) +
    statusRank(lead.workflow_status) +
    (lead.assigned_user_id ? 100 : 0) +
    (lead.last_call_id ? 80 : 0) +
    Math.min(Number(lead.attempts_count ?? 0), 10) * 8 +
    Math.min(Number(lead.priority_score ?? 0), 100) / 100 +
    parseTime(lead.updated_at) / 1e15
  )
}

function chooseKeeper(leads) {
  return [...leads].sort((left, right) => {
    const scoreDelta = keepScore(right) - keepScore(left)
    if (scoreDelta !== 0) return scoreDelta
    return parseTime(right.created_at) - parseTime(left.created_at)
  })[0]
}

function chunk(items, size = CHUNK_SIZE) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

async function fetchCampaignIdsByName(name) {
  if (!name) return null
  const { data, error } = await crm
    .from('campaigns')
    .select('id,name')
    .ilike('name', name)

  if (error) throw new Error(`No pude leer campañas: ${error.message}`)
  return new Set((data ?? []).map(row => row.id))
}

async function fetchContactsByRut(rut) {
  if (!rut) return null
  const variants = [...new Set([rut, rut.replace(/^0+/, ''), formatRut(rut)].filter(Boolean))]
  const contacts = new Map()

  for (const value of variants) {
    const { data, error } = await crm
      .from('contacts')
      .select('id,rut')
      .eq('rut', value)
      .limit(100)

    if (error) throw new Error(`No pude leer contactos por RUT: ${error.message}`)
    for (const row of data ?? []) contacts.set(row.id, row)
  }

  return new Set([...contacts.keys()])
}

function formatRut(value) {
  const compact = normalizeRut(value)
  if (!compact || compact.length < 2) return value ?? null
  return `${compact.slice(0, -1)}-${compact.slice(-1)}`
}

async function fetchActiveLeads() {
  const campaignIds = await fetchCampaignIdsByName(campaignNameFilter)
  const contactIds = contactIdFilter ? new Set([contactIdFilter]) : await fetchContactsByRut(rutFilter)
  const rows = []

  for (let from = 0; ; from += CHUNK_SIZE) {
    let query = crm
      .from('campaign_base_leads')
      .select([
        'id',
        'contact_id',
        'campaign_id',
        'assignment_status',
        'workflow_status',
        'assignment_rule',
        'assigned_user_id',
        'attempts_count',
        'last_call_id',
        'last_outcome',
        'tipificacion_actual',
        'exception_reason',
        'priority_score',
        'origin_raw',
        'rut_empresa',
        'nombre_cliente',
        'razon_social',
        'created_at',
        'updated_at',
      ].join(','))
      .in('assignment_status', ACTIVE_ASSIGNMENT_STATUSES)
      .in('workflow_status', ACTIVE_WORKFLOW_STATUSES)
      .order('id', { ascending: true })
      .range(from, from + CHUNK_SIZE - 1)

    if (campaignIds) query = query.in('campaign_id', [...campaignIds])
    if (contactIds) query = query.in('contact_id', [...contactIds])

    const { data, error } = await query
    if (error) throw new Error(`No pude leer campaign_base_leads: ${error.message}`)
    rows.push(...(data ?? []))
    if (!data || data.length < CHUNK_SIZE) break
  }

  return rows
}

function buildDuplicatePatch(keeper, duplicate) {
  return {
    assignment_status: DUPLICATE_ASSIGNMENT_STATUS,
    workflow_status: DUPLICATE_WORKFLOW_STATUS,
    exception_reason: DUPLICATE_REASON,
    observacion_actual: [
      DUPLICATE_REASON,
      `lead_vigente=${keeper.id}`,
      duplicate.exception_reason ? `prev_exception=${duplicate.exception_reason}` : null,
    ].filter(Boolean).join(' | '),
    updated_at: new Date().toISOString(),
  }
}

async function suppressDuplicates(duplicates) {
  if (dryRun || duplicates.length === 0) return { updated_leads: 0, updated_queue_rows: 0 }

  let updatedLeads = 0
  let updatedQueueRows = 0

  for (const batch of chunk(duplicates, UPDATE_CHUNK_SIZE)) {
    const duplicateLeadIds = batch.map(item => item.duplicate.id)

    const { error } = await crm
      .from('campaign_base_leads')
      .update({
        assignment_status: DUPLICATE_ASSIGNMENT_STATUS,
        workflow_status: DUPLICATE_WORKFLOW_STATUS,
        exception_reason: DUPLICATE_REASON,
        observacion_actual: DUPLICATE_REASON,
        updated_at: new Date().toISOString(),
      })
      .in('id', duplicateLeadIds)

    if (error) throw new Error(`No pude suprimir leads duplicados: ${JSON.stringify(error)}`)
    updatedLeads += duplicateLeadIds.length

    const { error: queueError } = await crm
      .from('campaign_base_lead_queue')
      .update({
        assignment_status: DUPLICATE_ASSIGNMENT_STATUS,
        workflow_status: DUPLICATE_WORKFLOW_STATUS,
        updated_at: new Date().toISOString(),
      })
      .in('lead_id', duplicateLeadIds)

    if (!queueError) updatedQueueRows += duplicateLeadIds.length
  }

  return { updated_leads: updatedLeads, updated_queue_rows: updatedQueueRows }
}

async function main() {
  const fetchedLeads = await fetchActiveLeads()
  const activeLeads = [...new Map(fetchedLeads.map(lead => [lead.id, lead])).values()]
  const grouped = new Map()

  for (const lead of activeLeads) {
    const key = activeKey(lead)
    if (!key) continue
    const bucket = grouped.get(key) ?? []
    bucket.push(lead)
    grouped.set(key, bucket)
  }

  const duplicateGroups = [...grouped.values()].filter(bucket => bucket.length > 1)
  const duplicates = []

  for (const bucket of duplicateGroups) {
    const keeper = chooseKeeper(bucket)
    for (const duplicate of bucket) {
      if (duplicate.id !== keeper.id) duplicates.push({ keeper, duplicate })
    }
  }

  const result = await suppressDuplicates(duplicates)

  console.log(JSON.stringify({
    ok: true,
    dry_run: dryRun,
    filters: {
      campaign_name: campaignNameFilter,
      contact_id: contactIdFilter,
      rut: rutFilter,
    },
    active_leads_fetched: fetchedLeads.length,
    active_leads_scanned: activeLeads.length,
    duplicate_groups: duplicateGroups.length,
    duplicates_to_suppress: duplicates.length,
    ...result,
    sample: duplicates.slice(0, 20).map(item => ({
      keep_lead_id: item.keeper.id,
      suppress_lead_id: item.duplicate.id,
      contact_id: item.duplicate.contact_id,
      campaign_id: item.duplicate.campaign_id,
      keep_status: item.keeper.assignment_status,
      suppress_status: item.duplicate.assignment_status,
      rut_empresa: item.duplicate.rut_empresa,
      nombre_cliente: item.duplicate.nombre_cliente,
    })),
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
