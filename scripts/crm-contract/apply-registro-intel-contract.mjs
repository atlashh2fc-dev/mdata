import fs from 'fs'
import { Client } from 'pg'

function loadEnvFile(path) {
  const env = {}
  if (!fs.existsSync(path)) return env

  for (const raw of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const separator = line.indexOf('=')
    const key = line.slice(0, separator)
    let value = line.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }

  return env
}

const fileEnv = loadEnvFile(process.env.REGISTRO_INTEL_ENV_FILE || '.env.production')
const env = { ...fileEnv, ...process.env }

const connectionString = env.POSTGRES_URL_NON_POOLING || env.POSTGRES_URL
if (!connectionString) {
  throw new Error('Falta POSTGRES_URL_NON_POOLING o POSTGRES_URL para aplicar el contrato remoto.')
}

const sql = `
create extension if not exists pgcrypto;

create or replace function public.normalize_brain_rut(value text)
returns text
language sql
immutable
as $$
  with cleaned as (
    select upper(regexp_replace(coalesce(value, ''), '[^0-9Kk]', '', 'g')) as compact
  )
  select nullif(regexp_replace(compact, '^0+', ''), '')
  from cleaned
$$;

create or replace view public.crm_feedback_export_v1 as
select
  c.id::text as external_event_id,
  c.id::text as source_record_id,
  'call'::text as external_record_type,
  greatest(
    coalesce(c.last_telephony_event_at, c.telephony_ended_at, c.ended_at, c.started_at, c.created_at),
    coalesce(q.updated_at, '-infinity'::timestamptz),
    coalesce(bm.updated_at, '-infinity'::timestamptz)
  ) as source_updated_at,
  coalesce(c.started_at, c.created_at) as managed_at,
  public.normalize_brain_rut(ct.rut) as rutid,
  public.normalize_brain_rut(ct.rut) as matched_rutid,
  coalesce(nullif(c.phone_number, ''), nullif(ct.phone_mobile, ''), nullif(ct.phone_contact, ''), nullif(ct.phone_normalized, '')) as contact_phone,
  nullif(ct.email, '') as contact_email,
  coalesce(nullif(lower(cp.campaign_channel), ''), 'phone') as channel,
  case
    when lower(coalesce(c.outcome, '')) = 'sale' then 'sale'
    when lower(coalesce(c.outcome, '')) = 'interested' then 'interested'
    when lower(coalesce(c.outcome, '')) = 'callback' then 'callback'
    when lower(coalesce(c.outcome, '')) = 'not_interested' then 'rejected'
    when lower(coalesce(c.status, '')) in ('connected') then 'contacted'
    when lower(coalesce(c.status, '')) in ('no_answer', 'voicemail', 'busy', 'out_of_service') then 'no_contact'
    else 'unknown'
  end as outcome,
  c.outcome as outcome_subtype,
  c.reason as outcome_reason,
  lower(coalesce(c.direction, 'outbound')) as direction,
  coalesce(
    c.telephony_duration_seconds,
    case
      when c.ended_at is not null and c.started_at is not null then extract(epoch from (c.ended_at - c.started_at))::integer
      else null
    end
  ) as duration_seconds,
  p.full_name as agent_name,
  cp.name as campaign_name,
  null::timestamptz as opened_at,
  null::timestamptz as clicked_at,
  case
    when lower(coalesce(c.outcome, '')) = 'callback' then c.next_action_at
    else null
  end as callback_at,
  null::timestamptz as responded_at,
  case
    when lower(coalesce(c.outcome, '')) = 'sale' then coalesce(c.ended_at, c.started_at, c.created_at)
    else null
  end as sold_at,
  null::numeric as value_amount,
  false as mail_opened,
  false as clicked,
  lower(coalesce(c.outcome, '')) = 'callback' as callback_requested,
  lower(coalesce(c.outcome, '')) = 'interested' as interested,
  lower(coalesce(c.status, '')) = 'connected'
    or lower(coalesce(c.outcome, '')) in ('interested', 'callback', 'sale', 'not_interested', 'other') as contacted,
  lower(coalesce(c.status, '')) = 'connected'
    or lower(coalesce(c.outcome, '')) in ('interested', 'callback', 'sale', 'not_interested', 'other') as effective_contact,
  lower(coalesce(c.outcome, '')) = 'sale' as sale,
  bm.best_call_id = c.id as is_best_management
from public.calls c
left join public.contacts ct
  on ct.id = c.contact_id
left join public.campaigns cp
  on cp.id = c.campaign_id
left join public.profiles p
  on p.user_id = c.agent_id
left join public.campaign_contact_queue q
  on q.campaign_id = c.campaign_id and q.contact_id = c.contact_id
left join public.campaign_contact_best_management bm
  on bm.campaign_id = c.campaign_id and bm.contact_id = c.contact_id;

create or replace view public.commercial_brain_active_targets_v1 as
select
  bl.id as lead_id,
  bl.contact_id,
  bl.campaign_id,
  public.normalize_brain_rut(ct.rut) as rutid,
  cp.name as campaign_name,
  coalesce(bl.priority_score, q.priority_score, 0)::numeric as current_priority_score,
  coalesce(bl.priority_bucket, q.priority_bucket, 4)::integer as current_priority_bucket,
  bl.assignment_status,
  bl.workflow_status,
  greatest(
    coalesce(bl.updated_at, '-infinity'::timestamptz),
    coalesce(q.updated_at, '-infinity'::timestamptz)
  ) as updated_at
from public.campaign_base_leads bl
join public.contacts ct
  on ct.id = bl.contact_id
left join public.campaigns cp
  on cp.id = bl.campaign_id
left join public.campaign_base_lead_queue q
  on q.lead_id = bl.id and q.campaign_id = bl.campaign_id
where public.normalize_brain_rut(ct.rut) is not null
  and bl.assignment_status in ('pending', 'assigned', 'in_progress')
  and bl.workflow_status in ('pending', 'callback', 'active');

create table if not exists public.commercial_brain_action_runs (
  id uuid primary key default gen_random_uuid(),
  source_system text not null,
  generated_at timestamptz not null,
  portfolio_status jsonb not null default '{}'::jsonb,
  executive_summary text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.commercial_brain_campaign_actions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.commercial_brain_action_runs(id) on delete cascade,
  campaign_name text not null,
  severity text not null,
  health_score numeric(6,2) not null default 0,
  underperformance_hours integer not null default 0,
  recommended_action text not null,
  recommended_adjustments jsonb not null default '[]'::jsonb,
  best_next_window text,
  top_channel text,
  probable_causes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_commercial_brain_campaign_actions_run_id
  on public.commercial_brain_campaign_actions(run_id);

create index if not exists idx_commercial_brain_campaign_actions_campaign
  on public.commercial_brain_campaign_actions(campaign_name, created_at desc);

create table if not exists public.commercial_brain_lead_actions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.commercial_brain_action_runs(id) on delete cascade,
  rutid text not null,
  campaign_name text,
  dynamic_priority_score numeric(6,2) not null default 0,
  contact_probability numeric(6,2) not null default 0,
  conversion_probability numeric(6,2) not null default 0,
  fatigue_score numeric(6,2) not null default 0,
  optimal_window text,
  recommended_channel text,
  next_best_action text,
  reason_tags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_commercial_brain_lead_actions_run_id
  on public.commercial_brain_lead_actions(run_id);

create index if not exists idx_commercial_brain_lead_actions_rut
  on public.commercial_brain_lead_actions(rutid, created_at desc);

create or replace function public.apply_commercial_brain_run(p_run_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_updated_leads integer := 0;
  v_updated_queue integer := 0;
begin
  with action_rows as (
    select
      la.run_id,
      la.rutid,
      public.normalize_brain_rut(la.rutid) as normalized_rutid,
      la.campaign_name,
      la.dynamic_priority_score,
      case
        when la.dynamic_priority_score >= 80 then 1
        when la.dynamic_priority_score >= 60 then 2
        when la.dynamic_priority_score >= 40 then 3
        else 4
      end as priority_bucket,
      c.id as campaign_id,
      ct.id as contact_id
    from public.commercial_brain_lead_actions la
    join public.contacts ct
      on public.normalize_brain_rut(ct.rut) = public.normalize_brain_rut(la.rutid)
    left join public.campaigns c
      on c.name = la.campaign_name
    where la.run_id = p_run_id
  ),
  target_leads as (
    select
      bl.id as lead_id,
      bl.campaign_id,
      bl.contact_id,
      ar.dynamic_priority_score,
      ar.priority_bucket
    from public.campaign_base_leads bl
    join action_rows ar
      on bl.contact_id = ar.contact_id
     and (ar.campaign_id is null or bl.campaign_id = ar.campaign_id or ar.campaign_name is null)
    where bl.assignment_status in ('pending', 'assigned', 'in_progress')
      and bl.workflow_status in ('pending', 'callback', 'active')
    union
    select
      bl.id as lead_id,
      bl.campaign_id,
      bl.contact_id,
      ar.dynamic_priority_score,
      ar.priority_bucket
    from public.campaign_base_leads bl
    join action_rows ar
      on bl.contact_id = ar.contact_id
    where ar.campaign_id is not null
      and not exists (
        select 1
        from public.campaign_base_leads bl2
        where bl2.contact_id = ar.contact_id
          and bl2.campaign_id = ar.campaign_id
          and bl2.assignment_status in ('pending', 'assigned', 'in_progress')
          and bl2.workflow_status in ('pending', 'callback', 'active')
      )
      and bl.assignment_status in ('pending', 'assigned', 'in_progress')
      and bl.workflow_status in ('pending', 'callback', 'active')
  ),
  updated_leads as (
    update public.campaign_base_leads bl
    set
      priority_score = tl.dynamic_priority_score,
      priority_bucket = tl.priority_bucket,
      updated_at = now()
    from target_leads tl
    where bl.id = tl.lead_id
    returning bl.id
  )
  select count(*) into v_updated_leads from updated_leads;

  with action_rows as (
    select
      la.run_id,
      la.rutid,
      public.normalize_brain_rut(la.rutid) as normalized_rutid,
      la.campaign_name,
      la.dynamic_priority_score,
      case
        when la.dynamic_priority_score >= 80 then 1
        when la.dynamic_priority_score >= 60 then 2
        when la.dynamic_priority_score >= 40 then 3
        else 4
      end as priority_bucket,
      c.id as campaign_id,
      ct.id as contact_id
    from public.commercial_brain_lead_actions la
    join public.contacts ct
      on public.normalize_brain_rut(ct.rut) = public.normalize_brain_rut(la.rutid)
    left join public.campaigns c
      on c.name = la.campaign_name
    where la.run_id = p_run_id
  ),
  target_leads as (
    select
      bl.id as lead_id,
      bl.campaign_id,
      bl.contact_id,
      ar.dynamic_priority_score,
      ar.priority_bucket
    from public.campaign_base_leads bl
    join action_rows ar
      on bl.contact_id = ar.contact_id
     and (ar.campaign_id is null or bl.campaign_id = ar.campaign_id or ar.campaign_name is null)
    where bl.assignment_status in ('pending', 'assigned', 'in_progress')
      and bl.workflow_status in ('pending', 'callback', 'active')
    union
    select
      bl.id as lead_id,
      bl.campaign_id,
      bl.contact_id,
      ar.dynamic_priority_score,
      ar.priority_bucket
    from public.campaign_base_leads bl
    join action_rows ar
      on bl.contact_id = ar.contact_id
    where ar.campaign_id is not null
      and not exists (
        select 1
        from public.campaign_base_leads bl2
        where bl2.contact_id = ar.contact_id
          and bl2.campaign_id = ar.campaign_id
          and bl2.assignment_status in ('pending', 'assigned', 'in_progress')
          and bl2.workflow_status in ('pending', 'callback', 'active')
      )
      and bl.assignment_status in ('pending', 'assigned', 'in_progress')
      and bl.workflow_status in ('pending', 'callback', 'active')
  ),
  updated_queue as (
    update public.campaign_base_lead_queue q
    set
      priority_score = tl.dynamic_priority_score,
      priority_bucket = tl.priority_bucket,
      updated_at = now()
    from target_leads tl
    where q.campaign_id = tl.campaign_id
      and q.lead_id = tl.lead_id
      and q.assignment_status in ('pending', 'assigned', 'in_progress')
      and q.workflow_status in ('pending', 'callback', 'active')
    returning q.lead_id
  )
  select count(*) into v_updated_queue from updated_queue;

  return jsonb_build_object(
    'run_id', p_run_id,
    'updated_base_leads', v_updated_leads,
    'updated_base_lead_queue', v_updated_queue
  );
end;
$$;
`

const client = new Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
})

async function main() {
  await client.connect()
  await client.query(sql)
  console.log(JSON.stringify({
    ok: true,
    applied_at: new Date().toISOString(),
    objects: [
      'crm_feedback_export_v1',
      'commercial_brain_active_targets_v1',
      'commercial_brain_action_runs',
      'commercial_brain_campaign_actions',
      'commercial_brain_lead_actions',
      'apply_commercial_brain_run',
    ],
  }, null, 2))
  await client.end()
}

main().catch(async error => {
  console.error(error)
  try {
    await client.end()
  } catch {}
  process.exit(1)
})
