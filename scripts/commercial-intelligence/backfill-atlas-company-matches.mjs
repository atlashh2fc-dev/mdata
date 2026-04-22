import pg from 'pg'

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.production')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? '0'

const { Client } = pg
const dryRun = process.argv.includes('--dry-run')
const connectionString = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL

if (!connectionString) {
  console.error('POSTGRES_URL_NON_POOLING o POSTGRES_URL no esta configurado.')
  process.exit(1)
}

const client = new Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
})

const matchSql = `
with atlas as (
  select
    f.id,
    f.rutid,
    f.matched_rutid,
    coalesce(f.metadata->>'company_name', f.raw_payload->'lead'->>'companyName') as company_name,
    public.normalize_company_name(coalesce(f.metadata->>'company_name', f.raw_payload->'lead'->>'companyName')) as match_key
  from public.contact_center_feedback f
  where f.external_source = 'atlas_lead_engine'
    and f.channel = 'email'
    and coalesce(f.metadata->>'company_name', f.raw_payload->'lead'->>'companyName') is not null
), candidate_matches as (
  select
    atlas.id,
    atlas.rutid,
    atlas.matched_rutid,
    atlas.company_name,
    atlas.match_key,
    lookup.rutid as company_rutid,
    lookup.razon_social_empresa,
    count(*) over (partition by atlas.id) as match_count
  from atlas
  join public.company_name_lookup lookup
    on lookup.match_key = atlas.match_key
), unique_matches as (
  select *
  from candidate_matches
  where match_count = 1
)
select
  count(*)::int as matched_events,
  count(distinct company_rutid)::int as matched_companies,
  count(*) filter (where company_rutid is distinct from matched_rutid)::int as remappable_events
from unique_matches;
`

const updateSql = `
with atlas as (
  select
    f.id,
    f.rutid,
    f.matched_rutid,
    coalesce(f.metadata->>'company_name', f.raw_payload->'lead'->>'companyName') as company_name,
    public.normalize_company_name(coalesce(f.metadata->>'company_name', f.raw_payload->'lead'->>'companyName')) as match_key
  from public.contact_center_feedback f
  where f.external_source = 'atlas_lead_engine'
    and f.channel = 'email'
    and coalesce(f.metadata->>'company_name', f.raw_payload->'lead'->>'companyName') is not null
), candidate_matches as (
  select
    atlas.id,
    atlas.rutid,
    atlas.matched_rutid,
    atlas.company_name,
    atlas.match_key,
    lookup.rutid as company_rutid,
    lookup.razon_social_empresa,
    count(*) over (partition by atlas.id) as match_count
  from atlas
  join public.company_name_lookup lookup
    on lookup.match_key = atlas.match_key
), unique_matches as (
  select *
  from candidate_matches
  where match_count = 1
), updated as (
  update public.contact_center_feedback feedback
  set
    matched_rutid = unique_matches.company_rutid,
    match_method = 'atlas_company_name_exact',
    metadata = coalesce(feedback.metadata, '{}'::jsonb) || jsonb_build_object(
      'atlas_original_rutid', feedback.rutid,
      'atlas_original_matched_rutid', feedback.matched_rutid,
      'atlas_company_match_key', unique_matches.match_key,
      'atlas_company_match_status', 'matched',
      'atlas_company_match_name', unique_matches.razon_social_empresa,
      'atlas_company_backfilled_at', now()
    )
  from unique_matches
  where feedback.id = unique_matches.id
    and unique_matches.company_rutid is distinct from feedback.matched_rutid
  returning feedback.id, feedback.matched_rutid
)
select
  count(*)::int as updated_events,
  count(distinct matched_rutid)::int as updated_companies
from updated;
`

try {
  await client.connect()
  const before = await client.query(matchSql)

  if (dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dry_run: true,
      before: before.rows[0],
    }, null, 2))
    process.exit(0)
  }

  const updated = await client.query(updateSql)
  console.log(JSON.stringify({
    ok: true,
    before: before.rows[0],
    updated: updated.rows[0],
  }, null, 2))
} catch (error) {
  console.error(error)
  process.exit(1)
} finally {
  await client.end().catch(() => {})
}
