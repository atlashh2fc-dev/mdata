import fs from 'fs'
import { Client } from 'pg'

function loadEnvFile(path) {
  const env = {}
  if (!fs.existsSync(path)) return env

  for (const raw of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const index = line.indexOf('=')
    const key = line.slice(0, index)
    let value = line.slice(index + 1).trim()
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

const env = { ...loadEnvFile(process.env.MDATA_ENV_FILE || '.env.production'), ...process.env }
const connectionString = env.POSTGRES_URL_NON_POOLING || env.POSTGRES_URL

if (!connectionString) {
  throw new Error('Falta POSTGRES_URL_NON_POOLING o POSTGRES_URL para aplicar la capa comercial en mdata.')
}

const sql = `
do $$
begin
  if not exists (select 1 from pg_type where typname = 'feedback_channel') then
    create type feedback_channel as enum ('phone','email','whatsapp','sms','bot','web','in_person','other');
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'feedback_outcome') then
    create type feedback_outcome as enum ('contacted','no_contact','interested','callback','rejected','sale','opened','clicked','bounced','do_not_contact','unknown');
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'sync_run_status') then
    create type sync_run_status as enum ('running','completed','failed','partial');
  end if;
end $$;

create or replace function normalize_feedback_email(value text)
returns text language plpgsql immutable as $$
begin
  if value is null or btrim(value) = '' then return null; end if;
  return lower(btrim(value));
end;
$$;

create or replace function normalize_feedback_phone(value text)
returns text language plpgsql immutable as $$
declare digits text;
begin
  if value is null or btrim(value) = '' then return null; end if;
  digits := regexp_replace(value, '[^0-9]', '', 'g');
  if digits = '' then return null; end if;
  if length(digits) = 8 then return '+569' || digits; end if;
  if length(digits) = 9 and left(digits,1) = '9' then return '+56' || digits; end if;
  if length(digits) = 11 and left(digits,2) = '56' then return '+' || digits; end if;
  if left(digits,3) = '569' then return '+' || digits; end if;
  return '+' || digits;
end;
$$;

create or replace function normalize_feedback_rutid(value text)
returns varchar(20) language plpgsql immutable as $$
declare cleaned text;
begin
  if value is null or btrim(value) = '' then return null; end if;
  cleaned := upper(regexp_replace(value, '[.\\-\\s]', '', 'g'));
  if length(cleaned) < 2 then return null; end if;
  return lpad(cleaned, 10, '0');
end;
$$;

create table if not exists external_sync_runs (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  source_kind text not null default 'api',
  status sync_run_status not null default 'running',
  requested_from timestamptz,
  requested_to timestamptz,
  cursor_value text,
  records_fetched integer not null default 0,
  records_loaded integer not null default 0,
  affected_ruts integer not null default 0,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_external_sync_runs_source on external_sync_runs (source_name, started_at desc);
create index if not exists idx_external_sync_runs_status on external_sync_runs (status, started_at desc);

create table if not exists contact_center_feedback (
  id uuid primary key default gen_random_uuid(),
  external_source text not null default 'registro_intel',
  external_event_id text not null,
  external_record_type text,
  rutid varchar(20),
  matched_rutid varchar(20),
  match_method text,
  contact_phone text,
  phone_normalized text generated always as (normalize_feedback_phone(contact_phone)) stored,
  contact_email text,
  email_normalized text generated always as (normalize_feedback_email(contact_email)) stored,
  channel feedback_channel not null default 'other',
  managed_at timestamptz not null,
  outcome feedback_outcome not null default 'unknown',
  outcome_subtype text,
  outcome_reason text,
  direction text,
  duration_seconds integer,
  talk_seconds integer,
  wait_seconds integer,
  agent_id text,
  agent_name text,
  campaign_id text,
  campaign_name text,
  opened_at timestamptz,
  clicked_at timestamptz,
  callback_at timestamptz,
  responded_at timestamptz,
  sold_at timestamptz,
  value_amount numeric(18,2),
  mail_opened boolean not null default false,
  clicked boolean not null default false,
  callback_requested boolean not null default false,
  interested boolean not null default false,
  contacted boolean not null default false,
  effective_contact boolean not null default false,
  sale boolean not null default false,
  is_best_management boolean not null default false,
  raw_payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (external_source, external_event_id)
);

create index if not exists idx_feedback_rutid on contact_center_feedback (coalesce(matched_rutid, rutid), managed_at desc);
create index if not exists idx_feedback_channel on contact_center_feedback (channel, managed_at desc);
create index if not exists idx_feedback_campaign on contact_center_feedback (campaign_name, managed_at desc);
create index if not exists idx_feedback_email on contact_center_feedback (email_normalized);
create index if not exists idx_feedback_phone on contact_center_feedback (phone_normalized);

create table if not exists persona_contact_points (
  id uuid primary key default gen_random_uuid(),
  rutid varchar(20) not null references personas_master(rutid) on delete cascade,
  contact_type text not null check (contact_type in ('phone','email')),
  contact_value text not null,
  normalized_value text not null,
  source_name text not null,
  source_priority integer not null default 50,
  quality_score integer not null default 50,
  is_primary boolean not null default false,
  is_verified boolean not null default false,
  is_deliverable boolean,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_feedback_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rutid, contact_type, normalized_value)
);

create index if not exists idx_persona_contact_points_rutid on persona_contact_points (rutid, contact_type, is_primary desc, quality_score desc);
create index if not exists idx_persona_contact_points_normalized on persona_contact_points (contact_type, normalized_value);

create table if not exists persona_scores (
  rutid varchar(20) primary key references personas_master(rutid) on delete cascade,
  contactability_score integer not null default 0,
  purchase_propensity_score integer not null default 0,
  priority_score integer not null default 0,
  best_channel feedback_channel not null default 'other',
  best_contact_hour smallint,
  best_phone text,
  best_email text,
  next_best_action text not null default 'contactar',
  action_priority text not null default 'normal',
  should_contact boolean not null default true,
  total_interactions integer not null default 0,
  effective_contacts integer not null default 0,
  no_contact_events integer not null default 0,
  interest_events integer not null default 0,
  callback_events integer not null default 0,
  sales_events integer not null default 0,
  opened_events integer not null default 0,
  clicked_events integer not null default 0,
  best_management_events integer not null default 0,
  known_phone_count integer not null default 0,
  known_email_count integer not null default 0,
  last_contact_at timestamptz,
  last_sale_at timestamptz,
  last_feedback_at timestamptz,
  feedback_coverage boolean not null default false,
  signal_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_persona_scores_priority on persona_scores (priority_score desc, purchase_propensity_score desc, contactability_score desc);

create or replace function refresh_persona_scores(p_rutids varchar[] default null)
returns integer
language plpgsql
as $$
declare affected_count integer := 0;
begin
  with candidate_ruts as (
    select pm.rutid
    from personas_master pm
    where p_rutids is null or pm.rutid = any(p_rutids)
  ),
  feedback_agg as (
    select
      coalesce(f.matched_rutid, f.rutid) as rutid,
      count(*) as total_interactions,
      count(*) filter (where f.effective_contact) as effective_contacts,
      count(*) filter (where f.outcome = 'no_contact') as no_contact_events,
      count(*) filter (where f.interested or f.outcome = 'interested') as interest_events,
      count(*) filter (where f.callback_requested or f.outcome = 'callback') as callback_events,
      count(*) filter (where f.sale or f.outcome = 'sale') as sales_events,
      count(*) filter (where f.mail_opened or f.outcome = 'opened') as opened_events,
      count(*) filter (where f.clicked or f.outcome = 'clicked') as clicked_events,
      count(*) filter (where f.is_best_management) as best_management_events,
      max(f.managed_at) as last_contact_at,
      max(f.sold_at) as last_sale_at,
      max(f.managed_at) as last_feedback_at
    from contact_center_feedback f
    join candidate_ruts c on c.rutid = coalesce(f.matched_rutid, f.rutid)
    group by coalesce(f.matched_rutid, f.rutid)
  ),
  channel_ranked as (
    select distinct on (rutid)
      rutid, channel
    from (
      select
        coalesce(f.matched_rutid, f.rutid) as rutid,
        f.channel,
        (
          count(*) filter (where f.effective_contact) * 3 +
          count(*) filter (where f.sale or f.outcome = 'sale') * 6 +
          count(*) filter (where f.interested or f.outcome = 'interested') * 2 +
          count(*) filter (where f.callback_requested or f.outcome = 'callback') * 2 -
          count(*) filter (where f.outcome = 'no_contact')
        )::numeric / greatest(count(*), 1) as channel_score
      from contact_center_feedback f
      join candidate_ruts c on c.rutid = coalesce(f.matched_rutid, f.rutid)
      group by coalesce(f.matched_rutid, f.rutid), f.channel
    ) ranked
    order by rutid, channel_score desc, channel
  ),
  best_hour as (
    select distinct on (rutid)
      rutid, contact_hour
    from (
      select
        coalesce(f.matched_rutid, f.rutid) as rutid,
        extract(hour from f.managed_at)::smallint as contact_hour,
        (
          count(*) filter (where f.effective_contact) * 2 +
          count(*) filter (where f.sale or f.outcome = 'sale') * 4 +
          count(*) filter (where f.interested or f.outcome = 'interested')
        ) as hour_score
      from contact_center_feedback f
      join candidate_ruts c on c.rutid = coalesce(f.matched_rutid, f.rutid)
      group by coalesce(f.matched_rutid, f.rutid), extract(hour from f.managed_at)
    ) scored
    order by rutid, hour_score desc, contact_hour
  ),
  phone_choice as (
    select distinct on (pcp.rutid) pcp.rutid, pcp.contact_value as best_phone
    from persona_contact_points pcp
    join candidate_ruts c on c.rutid = pcp.rutid
    where pcp.contact_type = 'phone'
    order by pcp.rutid, pcp.is_primary desc, pcp.quality_score desc, pcp.last_seen_at desc
  ),
  email_choice as (
    select distinct on (pcp.rutid) pcp.rutid, pcp.contact_value as best_email
    from persona_contact_points pcp
    join candidate_ruts c on c.rutid = pcp.rutid
    where pcp.contact_type = 'email'
    order by pcp.rutid, pcp.is_primary desc, pcp.quality_score desc, pcp.last_seen_at desc
  ),
  contact_points_agg as (
    select
      pcp.rutid,
      count(*) filter (where pcp.contact_type = 'phone') as known_phone_count,
      count(*) filter (where pcp.contact_type = 'email') as known_email_count
    from persona_contact_points pcp
    join candidate_ruts c on c.rutid = pcp.rutid
    group by pcp.rutid
  ),
  score_rows as (
    select
      c.rutid,
      least(100, greatest(0, round((
        case when coalesce(cp.known_phone_count,0) > 0 or mpv.fono_cel is not null then 18 else 0 end +
        case when coalesce(cp.known_phone_count,0) > 1 then 8 else 0 end +
        case when coalesce(cp.known_email_count,0) > 0 or mpv.email is not null then 10 else 0 end +
        coalesce(mpv.cobertura_pct, 0) * 0.12 +
        case when coalesce(fa.total_interactions,0) > 0 then (fa.effective_contacts::numeric / fa.total_interactions) * 35 else 0 end +
        case when coalesce(fa.total_interactions,0) > 0 then (fa.opened_events::numeric / fa.total_interactions) * 10 else 0 end +
        case when coalesce(fa.total_interactions,0) > 0 then (fa.callback_events::numeric / fa.total_interactions) * 10 else 0 end -
        case when coalesce(fa.total_interactions,0) > 0 then (fa.no_contact_events::numeric / fa.total_interactions) * 18 else 0 end
      ), 0)::integer)) as contactability_score,
      least(100, greatest(0, round((
        coalesce(mpv.score_patrimonial, 0) * 0.42 +
        case when mpv.tiene_empresa then 8 else 0 end +
        case when mpv.tiene_bienes_raices then 8 else 0 end +
        case when mpv.tiene_autos then 5 else 0 end +
        case when coalesce(fa.total_interactions,0) > 0 then (fa.sales_events::numeric / fa.total_interactions) * 30 else 0 end +
        case when coalesce(fa.total_interactions,0) > 0 then (fa.interest_events::numeric / fa.total_interactions) * 18 else 0 end +
        case when coalesce(fa.total_interactions,0) > 0 then (fa.clicked_events::numeric / fa.total_interactions) * 12 else 0 end +
        case when coalesce(fa.total_interactions,0) > 0 then (fa.best_management_events::numeric / fa.total_interactions) * 8 else 0 end
      ), 0)::integer)) as purchase_propensity_score,
      coalesce(cr.channel, case
        when coalesce(cp.known_phone_count,0) > 0 or mpv.fono_cel is not null then 'phone'::feedback_channel
        when coalesce(cp.known_email_count,0) > 0 or mpv.email is not null then 'email'::feedback_channel
        else 'other'::feedback_channel
      end) as best_channel,
      coalesce(bh.contact_hour, 10) as best_contact_hour,
      coalesce(pc.best_phone, mpv.fono_cel) as best_phone,
      coalesce(ec.best_email, mpv.email) as best_email,
      coalesce(fa.total_interactions, 0) as total_interactions,
      coalesce(fa.effective_contacts, 0) as effective_contacts,
      coalesce(fa.no_contact_events, 0) as no_contact_events,
      coalesce(fa.interest_events, 0) as interest_events,
      coalesce(fa.callback_events, 0) as callback_events,
      coalesce(fa.sales_events, 0) as sales_events,
      coalesce(fa.opened_events, 0) as opened_events,
      coalesce(fa.clicked_events, 0) as clicked_events,
      coalesce(fa.best_management_events, 0) as best_management_events,
      coalesce(cp.known_phone_count, 0) + case when mpv.fono_cel is not null then 1 else 0 end as known_phone_count,
      coalesce(cp.known_email_count, 0) + case when mpv.email is not null then 1 else 0 end as known_email_count,
      fa.last_contact_at,
      fa.last_sale_at,
      fa.last_feedback_at,
      coalesce(fa.total_interactions, 0) > 0 as feedback_coverage,
      jsonb_strip_nulls(
        jsonb_build_object(
          'score_patrimonial', coalesce(mpv.score_patrimonial, 0),
          'cobertura_pct', coalesce(mpv.cobertura_pct, 0),
          'tiene_empresa', coalesce(mpv.tiene_empresa, false),
          'tiene_bienes_raices', coalesce(mpv.tiene_bienes_raices, false),
          'tiene_autos', coalesce(mpv.tiene_autos, false),
          'known_phone_count', coalesce(cp.known_phone_count, 0),
          'known_email_count', coalesce(cp.known_email_count, 0),
          'best_management_events', coalesce(fa.best_management_events, 0)
        )
      ) as signal_summary
    from candidate_ruts c
    left join master_personas_view mpv on mpv.rutid = c.rutid
    left join feedback_agg fa on fa.rutid = c.rutid
    left join channel_ranked cr on cr.rutid = c.rutid
    left join best_hour bh on bh.rutid = c.rutid
    left join contact_points_agg cp on cp.rutid = c.rutid
    left join phone_choice pc on pc.rutid = c.rutid
    left join email_choice ec on ec.rutid = c.rutid
  )
  insert into persona_scores (
    rutid, contactability_score, purchase_propensity_score, priority_score,
    best_channel, best_contact_hour, best_phone, best_email, next_best_action,
    action_priority, should_contact, total_interactions, effective_contacts,
    no_contact_events, interest_events, callback_events, sales_events, opened_events,
    clicked_events, best_management_events, known_phone_count, known_email_count,
    last_contact_at, last_sale_at, last_feedback_at, feedback_coverage, signal_summary, updated_at
  )
  select
    sr.rutid,
    sr.contactability_score,
    sr.purchase_propensity_score,
    least(100, round((sr.contactability_score * 0.45 + sr.purchase_propensity_score * 0.55), 0)::integer) as priority_score,
    sr.best_channel,
    sr.best_contact_hour,
    sr.best_phone,
    sr.best_email,
    case
      when sr.sales_events > 0 and sr.last_sale_at > now() - interval '45 days' then 'enfriar'
      when sr.interest_events > 0 and sr.callback_events > 0 then 'escalar'
      when sr.contactability_score >= 65 and sr.purchase_propensity_score >= 65 then 'insistir'
      when sr.no_contact_events >= 3 and sr.contactability_score < 35 then 'enfriar'
      when sr.contactability_score >= 50 then 'contactar'
      else 'enriquecer'
    end as next_best_action,
    case
      when (sr.contactability_score * 0.45 + sr.purchase_propensity_score * 0.55) >= 80 then 'alta'
      when (sr.contactability_score * 0.45 + sr.purchase_propensity_score * 0.55) >= 60 then 'media'
      else 'baja'
    end as action_priority,
    case
      when sr.sales_events > 0 and sr.last_sale_at > now() - interval '45 days' then false
      when sr.no_contact_events >= 5 and sr.contactability_score < 25 then false
      else true
    end as should_contact,
    sr.total_interactions,
    sr.effective_contacts,
    sr.no_contact_events,
    sr.interest_events,
    sr.callback_events,
    sr.sales_events,
    sr.opened_events,
    sr.clicked_events,
    sr.best_management_events,
    sr.known_phone_count,
    sr.known_email_count,
    sr.last_contact_at,
    sr.last_sale_at,
    sr.last_feedback_at,
    sr.feedback_coverage,
    sr.signal_summary,
    now()
  from score_rows sr
  on conflict (rutid) do update
  set
    contactability_score = excluded.contactability_score,
    purchase_propensity_score = excluded.purchase_propensity_score,
    priority_score = excluded.priority_score,
    best_channel = excluded.best_channel,
    best_contact_hour = excluded.best_contact_hour,
    best_phone = excluded.best_phone,
    best_email = excluded.best_email,
    next_best_action = excluded.next_best_action,
    action_priority = excluded.action_priority,
    should_contact = excluded.should_contact,
    total_interactions = excluded.total_interactions,
    effective_contacts = excluded.effective_contacts,
    no_contact_events = excluded.no_contact_events,
    interest_events = excluded.interest_events,
    callback_events = excluded.callback_events,
    sales_events = excluded.sales_events,
    opened_events = excluded.opened_events,
    clicked_events = excluded.clicked_events,
    best_management_events = excluded.best_management_events,
    known_phone_count = excluded.known_phone_count,
    known_email_count = excluded.known_email_count,
    last_contact_at = excluded.last_contact_at,
    last_sale_at = excluded.last_sale_at,
    last_feedback_at = excluded.last_feedback_at,
    feedback_coverage = excluded.feedback_coverage,
    signal_summary = excluded.signal_summary,
    updated_at = now();

  get diagnostics affected_count = row_count;
  return affected_count;
end;
$$;

create or replace view commercial_intelligence_overview as
select
  count(*) as total_scored_personas,
  count(*) filter (where feedback_coverage) as with_feedback,
  count(*) filter (where action_priority = 'alta') as high_priority_personas,
  count(*) filter (where best_channel = 'phone') as recommended_phone,
  count(*) filter (where best_channel = 'email') as recommended_email,
  round(avg(contactability_score)::numeric, 2) as avg_contactability_score,
  round(avg(purchase_propensity_score)::numeric, 2) as avg_purchase_propensity_score,
  round(avg(priority_score)::numeric, 2) as avg_priority_score,
  max(updated_at) as last_score_refresh,
  (select max(completed_at) from external_sync_runs where source_name = 'registro_intel' and status in ('completed', 'partial')) as last_feedback_sync
from persona_scores;
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
      'external_sync_runs',
      'contact_center_feedback',
      'persona_contact_points',
      'persona_scores',
      'refresh_persona_scores',
      'commercial_intelligence_overview',
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
