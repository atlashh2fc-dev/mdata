export {}

import pg from 'pg'

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.local')

const { Pool } = pg

type QueueJob = {
  id: string
  rutid: string
  company_name: string
  normalized_name: string
  needs_email: boolean
  needs_phone: boolean
}

type InternalLayerContacts = {
  emails: string[]
  phones: string[]
  sourceUrls: string[]
  evidence: Record<string, unknown>
}

type Args = {
  enqueue: boolean
  process: boolean
  progress: boolean
  dryRun: boolean
  retryFailed: boolean
  forceRefresh: boolean
  limit: number
  batchSize: number
  maxAttempts: number
  need: 'any' | 'both' | 'email' | 'phone'
  worker: string
}

function parseArgs(argv: string[]): Args {
  const read = (name: string) => argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
  const has = (name: string) => argv.includes(`--${name}`)
  const need = String(read('need') ?? 'any').toLowerCase()

  if (!['any', 'both', 'email', 'phone'].includes(need)) {
    throw new Error('--need debe ser any, both, email o phone.')
  }

  return {
    enqueue: has('enqueue'),
    process: has('process'),
    progress: has('progress'),
    dryRun: has('dry-run'),
    retryFailed: has('retry-failed'),
    forceRefresh: has('force-refresh'),
    limit: Number(read('limit') ?? 5000),
    batchSize: Number(read('batch-size') ?? 50),
    maxAttempts: Number(read('max-attempts') ?? 3),
    need: need as Args['need'],
    worker: read('worker') ?? `web-enrichment-${Date.now()}`,
  }
}

function postgresConnectionString() {
  const raw = process.env.POSTGRES_URL_NON_POOLING
    ?? process.env.POSTGRES_URL
    ?? process.env.DATABASE_URL
    ?? process.env.SUPABASE_DB_URL

  if (!raw) throw new Error('Falta POSTGRES_URL_NON_POOLING/POSTGRES_URL/DATABASE_URL.')

  const url = new URL(raw)
  url.searchParams.delete('sslmode')
  return url.toString()
}

function createPool() {
  return new Pool({
    connectionString: postgresConnectionString(),
    max: 2,
    ssl: { rejectUnauthorized: false },
  })
}

function normalizeCompanyNameLocal(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(sa|spa|ltda|limitada|eirl|s a|s p a)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function uniq(values: Array<string | null | undefined>) {
  return [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))]
}

function needPredicate(need: Args['need']) {
  if (need === 'both') {
    return "nullif(btrim(email), '') is null and nullif(btrim(fono_cel), '') is null"
  }
  if (need === 'email') return "nullif(btrim(email), '') is null"
  if (need === 'phone') return "nullif(btrim(fono_cel), '') is null"
  return "(nullif(btrim(email), '') is null or nullif(btrim(fono_cel), '') is null)"
}

async function ensureSchema(pool: pg.Pool) {
  await pool.query(`
    alter table if exists public.company_contact_enrichment_cache
      add column if not exists rutid varchar(20);

    create sequence if not exists public.company_web_enrichment_queue_id_seq;

    create table if not exists public.company_web_enrichment_queue (
      id bigint primary key default nextval('public.company_web_enrichment_queue_id_seq'),
      rutid text not null unique,
      company_name text not null,
      normalized_name text not null,
      needs_email boolean not null default true,
      needs_phone boolean not null default true,
      existing_email text,
      existing_phone text,
      status text not null default 'queued',
      priority integer not null default 100,
      attempts integer not null default 0,
      locked_at timestamptz,
      locked_by text,
      completed_at timestamptz,
      last_error text,
      source text not null default 'empresas_comercial_unificada',
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists public.company_web_enrichment_results (
      rutid text primary key,
      match_key text not null,
      company_name text not null,
      website text,
      emails text[] not null default '{}'::text[],
      phones text[] not null default '{}'::text[],
      source_urls jsonb not null default '[]'::jsonb,
      enrichment_source text not null default 'none',
      search_provider text not null default 'none',
      status text not null default 'none',
      promoted_to_master boolean not null default false,
      first_found_at timestamptz,
      searched_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      raw jsonb not null default '{}'::jsonb
    );

    alter sequence public.company_web_enrichment_queue_id_seq
      owned by public.company_web_enrichment_queue.id;

    create index if not exists idx_company_web_enrichment_queue_status_priority
      on public.company_web_enrichment_queue (status, priority, created_at);

    create index if not exists idx_company_web_enrichment_results_status
      on public.company_web_enrichment_results (status, searched_at desc);

    create or replace view public.company_web_enrichment_progress as
    select
      count(*)::bigint as queued_total,
      count(*) filter (where status = 'queued')::bigint as queued,
      count(*) filter (where status = 'processing')::bigint as processing,
      count(*) filter (where status = 'completed')::bigint as completed,
      count(*) filter (where status = 'no_result')::bigint as no_result,
      count(*) filter (where status = 'failed')::bigint as failed,
      count(*) filter (where status = 'skipped')::bigint as skipped,
      count(*) filter (where needs_email)::bigint as needing_email,
      count(*) filter (where needs_phone)::bigint as needing_phone,
      max(updated_at) as last_queue_update
    from public.company_web_enrichment_queue;
  `)
}

async function enqueueCandidates(pool: pg.Pool, args: Args) {
  const whereNeed = needPredicate(args.need)

  if (args.dryRun) {
    const { rows } = await pool.query(`
      select
        count(*)::bigint as candidates,
        count(*) filter (where nullif(btrim(email), '') is null)::bigint as missing_email,
        count(*) filter (where nullif(btrim(fono_cel), '') is null)::bigint as missing_phone
      from public.empresas_comercial_unificada
      where coalesce(es_universo_operativo_ventas, true) = true
        and nullif(btrim(razon_social), '') is not null
        and coalesce(rubro_economico_ultimo, '') !~* 'ADMINISTRACION PUBLICA|DEFENSA|SEGURIDAD SOCIAL'
        and ${whereNeed}
    `)
    return { dry_run: true, ...rows[0] }
  }

  const result = await pool.query(`
    with candidates as (
      select
        rutid::text,
        razon_social::text as company_name,
        lower(regexp_replace(coalesce(razon_social, ''), '[^a-zA-Z0-9]+', ' ', 'g')) as normalized_name,
        (nullif(btrim(email), '') is null) as needs_email,
        (nullif(btrim(fono_cel), '') is null) as needs_phone,
        nullif(btrim(email), '') as existing_email,
        nullif(btrim(fono_cel), '') as existing_phone,
        (
          case when nullif(btrim(email), '') is null and nullif(btrim(fono_cel), '') is null then 10 else 50 end
          + case when coalesce(es_pyme, false) then 0 else 20 end
          + case
              when coalesce(rubro_economico_ultimo, '') ~* 'COMERCIO|MANUFACTURA|CONSTRUCCION|TRANSPORTE|PROFESIONALES|ALOJAMIENTO|COMIDAS' then -20
              when coalesce(rubro_economico_ultimo, '') ~* 'INMOBILIARIAS|RELIGIOSAS|FUNDACIONES|ASOCIACIONES' then 30
              else 0
            end
          + greatest(0, 10 - coalesce(cobertura_pct, 0) / 10)
        )::integer as priority,
        jsonb_build_object(
          'segmento_tamano_empresa', segmento_tamano_empresa,
          'region', region,
          'comuna', comuna,
          'rubro', rubro_economico_ultimo,
          'actividad', actividad_economica_ultima,
          'cobertura_pct', cobertura_pct,
          'score_patrimonial', score_patrimonial
        ) as metadata
      from public.empresas_comercial_unificada
      where coalesce(es_universo_operativo_ventas, true) = true
        and nullif(btrim(razon_social), '') is not null
        and coalesce(rubro_economico_ultimo, '') !~* 'ADMINISTRACION PUBLICA|DEFENSA|SEGURIDAD SOCIAL'
        and ${whereNeed}
      order by priority asc, coalesce(score_patrimonial, 0) desc, rutid
      limit $1
    )
    insert into public.company_web_enrichment_queue (
      rutid,
      company_name,
      normalized_name,
      needs_email,
      needs_phone,
      existing_email,
      existing_phone,
      priority,
      metadata,
      updated_at
    )
    select
      rutid,
      company_name,
      normalized_name,
      needs_email,
      needs_phone,
      existing_email,
      existing_phone,
      priority,
      metadata,
      now()
    from candidates
    on conflict (rutid) do update
    set
      company_name = excluded.company_name,
      normalized_name = excluded.normalized_name,
      needs_email = excluded.needs_email,
      needs_phone = excluded.needs_phone,
      existing_email = excluded.existing_email,
      existing_phone = excluded.existing_phone,
      priority = excluded.priority,
      metadata = excluded.metadata,
      updated_at = now()
    where company_web_enrichment_queue.status in ('queued', 'failed', 'no_result')
  `, [args.limit])

  return {
    inserted_or_updated: (result as unknown as { rowCount?: number | null }).rowCount ?? 0,
    limit: args.limit,
    need: args.need,
  }
}

async function claimJobs(pool: pg.Pool, args: Args): Promise<QueueJob[]> {
  const statuses = args.retryFailed ? ['queued', 'failed'] : ['queued']
  const client = await pool.connect()

  try {
    await client.query('begin')
    const { rows } = await client.query<QueueJob>(`
      with picked as (
        select id
        from public.company_web_enrichment_queue
        where status = any($2::text[])
          and attempts < $3
        order by priority asc, created_at asc
        limit $1
        for update skip locked
      )
      update public.company_web_enrichment_queue q
      set
        status = 'processing',
        attempts = q.attempts + 1,
        locked_at = now(),
        locked_by = $4,
        last_error = null,
        updated_at = now()
      from picked
      where q.id = picked.id
      returning q.id::text, q.rutid, q.company_name, q.normalized_name, q.needs_email, q.needs_phone
    `, [args.batchSize, statuses, args.maxAttempts, args.worker])
    await client.query('commit')
    return rows
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

async function markFailed(pool: pg.Pool, jobs: QueueJob[], error: unknown) {
  if (jobs.length === 0) return
  const message = error instanceof Error ? error.message : String(error)
  await pool.query(`
    update public.company_web_enrichment_queue
    set status = 'failed',
        last_error = $2,
        locked_at = null,
        locked_by = null,
        updated_at = now()
    where id = any($1::bigint[])
  `, [jobs.map(job => job.id), message.slice(0, 1000)])
}

async function collectInternalLayerContacts(
  pool: pg.Pool,
  jobs: QueueJob[]
): Promise<Map<string, InternalLayerContacts>> {
  const rutids = jobs.map(job => job.rutid)
  const out = new Map<string, InternalLayerContacts>()
  if (rutids.length === 0) return out

  const { rows } = await pool.query<{
    rutid: string
    emails: string[] | null
    phones: string[] | null
    source_names: string[] | null
    evidence: Record<string, unknown> | null
  }>(`
    with input as (
      select unnest($1::text[]) as rutid
    ),
    contact_points as (
      select
        i.rutid,
        array_remove(array_agg(distinct pcp.contact_value) filter (
          where pcp.contact_type = 'email'
            and nullif(btrim(pcp.contact_value), '') is not null
        ), null) as emails,
        array_remove(array_agg(distinct pcp.contact_value) filter (
          where pcp.contact_type = 'phone'
            and nullif(btrim(pcp.contact_value), '') is not null
        ), null) as phones,
        array_remove(array_agg(distinct pcp.source_name), null) as sources
      from input i
      left join public.persona_contact_points pcp
        on pcp.rutid = i.rutid
      group by i.rutid
    ),
    exec_contacts as (
      select
        i.rutid,
        array_remove(array_agg(distinct e.email) filter (
          where nullif(btrim(e.email), '') is not null
        ), null) as emails,
        array_remove(array_agg(distinct nullif(btrim(concat_ws('', e.fono_area_cel, e.fono_numero_cel)), '')), null)
          || array_remove(array_agg(distinct nullif(btrim(concat_ws('', e.fono_area_comer, e.fono_numero_comer)), '')), null) as phones
      from input i
      left join public.ejecutivos e
        on e.rutid = i.rutid
      group by i.rutid
    ),
    bbrr_contacts as (
      select
        i.rutid,
        array_remove(array_agg(distinct b.email) filter (
          where nullif(btrim(b.email), '') is not null
        ), null) as emails,
        array_remove(array_agg(distinct nullif(btrim(concat_ws('', b.fono_area_cel, b.fono_numero_cel)), '')), null)
          || array_remove(array_agg(distinct nullif(btrim(concat_ws('', b.fono_area_comer, b.fono_numero_comer)), '')), null)
          || array_remove(array_agg(distinct nullif(btrim(concat_ws('', b.fono_area_part, b.fono_numero_part)), '')), null) as phones
      from input i
      left join public.bbrr_propiedades b
        on b.rutid = i.rutid
      group by i.rutid
    ),
    base_contact_layer as (
      select
        i.rutid,
        array_remove(array_agg(distinct coalesce(nullif(bc.best_email, ''), nullif(bc.contact_email, ''), nullif(bc.email_normalized, ''))), null) as emails,
        array_remove(array_agg(distinct coalesce(nullif(bc.best_phone, ''), nullif(bc.contact_phone, ''), nullif(bc.phone_normalized, ''))), null) as phones
      from input i
      left join public.base_contact bc
        on bc.rutid = i.rutid
      group by i.rutid
    )
    select
      i.rutid,
      array(
        select distinct value
        from unnest(
          coalesce(cp.emails, '{}'::text[])
          || coalesce(ec.emails, '{}'::text[])
          || coalesce(bb.emails, '{}'::text[])
          || coalesce(bc.emails, '{}'::text[])
        ) value
        where nullif(btrim(value), '') is not null
      ) as emails,
      array(
        select distinct value
        from unnest(
          coalesce(cp.phones, '{}'::text[])
          || coalesce(ec.phones, '{}'::text[])
          || coalesce(bb.phones, '{}'::text[])
          || coalesce(bc.phones, '{}'::text[])
        ) value
        where nullif(btrim(value), '') is not null
      ) as phones,
      coalesce(cp.sources, '{}'::text[]) as source_names,
      jsonb_build_object(
        'persona_contact_points_sources', coalesce(cp.sources, '{}'::text[]),
        'ejecutivos_email_count', cardinality(coalesce(ec.emails, '{}'::text[])),
        'ejecutivos_phone_count', cardinality(coalesce(ec.phones, '{}'::text[])),
        'bbrr_email_count', cardinality(coalesce(bb.emails, '{}'::text[])),
        'bbrr_phone_count', cardinality(coalesce(bb.phones, '{}'::text[])),
        'base_contact_email_count', cardinality(coalesce(bc.emails, '{}'::text[])),
        'base_contact_phone_count', cardinality(coalesce(bc.phones, '{}'::text[]))
      ) as evidence
    from input i
    left join contact_points cp on cp.rutid = i.rutid
    left join exec_contacts ec on ec.rutid = i.rutid
    left join bbrr_contacts bb on bb.rutid = i.rutid
    left join base_contact_layer bc on bc.rutid = i.rutid
  `, [rutids])

  for (const row of rows) {
    const emails = uniq(row.emails ?? [])
    const phones = uniq(row.phones ?? [])
    if (emails.length === 0 && phones.length === 0) continue

    out.set(row.rutid, {
      emails,
      phones,
      sourceUrls: uniq([...(row.source_names ?? []), 'ejecutivos', 'bbrr_propiedades', 'base_contact'])
        .map(source => `internal:${source}`),
      evidence: row.evidence ?? {},
    })
  }

  return out
}

async function processBatch(pool: pg.Pool, args: Args) {
  const jobs = await claimJobs(pool, args)
  if (jobs.length === 0) return { claimed: 0, found: 0, no_result: 0, failed: 0 }

  if (args.dryRun) {
    await pool.query(`
      update public.company_web_enrichment_queue
      set status = 'queued',
          attempts = greatest(attempts - 1, 0),
          locked_at = null,
          locked_by = null,
          updated_at = now()
      where id = any($1::bigint[])
    `, [jobs.map(job => job.id)])
    return { dry_run: true, claimed: jobs.length, sample: jobs.slice(0, 5) }
  }

  try {
    if (args.forceRefresh) {
      process.env.COMPANY_CONTACT_ENRICH_FORCE_REFRESH = 'true'
    }

    const { enrichCompanyContacts } = await import('@/lib/services/company-contact-enrichment')
    const internalContacts = await collectInternalLayerContacts(pool, jobs)
    const jobsNeedingWeb = jobs.filter(job => {
      const internal = internalContacts.get(job.rutid)
      const hasNeededEmail = !job.needs_email || (internal?.emails.length ?? 0) > 0
      const hasNeededPhone = !job.needs_phone || (internal?.phones.length ?? 0) > 0
      return !hasNeededEmail || !hasNeededPhone
    })
    const enrichment = await enrichCompanyContacts(
      jobsNeedingWeb.map(job => ({ companyName: job.company_name, rutid: job.rutid }))
    )

    let found = 0
    let noResult = 0
    let failed = 0
    let internalFound = 0

    for (const job of jobs) {
      const matchKey = normalizeCompanyNameLocal(job.company_name)
      const item = enrichment.items.get(matchKey)
      const internal = internalContacts.get(job.rutid)
      const emails = uniq([...(internal?.emails ?? []), ...(item?.emails ?? [])])
      const phones = uniq([...(internal?.phones ?? []), ...(item?.phones ?? [])])
      const sourceUrls = uniq([...(internal?.sourceUrls ?? []), ...(item?.sourceUrls ?? [])])
      const hasContact = emails.length > 0 || phones.length > 0
      const status = item?.source === 'error' ? 'error' : hasContact ? 'found' : 'none'
      const queueStatus = status === 'error' ? 'failed' : hasContact ? 'completed' : 'no_result'

      if (status === 'found') {
        found += 1
        if (internal) internalFound += 1
      }
      else if (status === 'error') failed += 1
      else noResult += 1

      await pool.query(`
        insert into public.company_web_enrichment_results (
          rutid,
          match_key,
          company_name,
          website,
          emails,
          phones,
          source_urls,
          enrichment_source,
          search_provider,
          status,
          promoted_to_master,
          first_found_at,
          searched_at,
          updated_at,
          raw
        )
        values (
          $1, $2, $3, $4, $5::text[], $6::text[], $7::jsonb, $8, $9, $10,
          $11, case when $10 = 'found' then coalesce((select first_found_at from public.company_web_enrichment_results where rutid = $1), now()) else null end,
          now(), now(), $12::jsonb
        )
        on conflict (rutid) do update
        set
          match_key = excluded.match_key,
          company_name = excluded.company_name,
          website = excluded.website,
          emails = excluded.emails,
          phones = excluded.phones,
          source_urls = excluded.source_urls,
          enrichment_source = excluded.enrichment_source,
          search_provider = excluded.search_provider,
          status = excluded.status,
          promoted_to_master = excluded.promoted_to_master,
          first_found_at = coalesce(company_web_enrichment_results.first_found_at, excluded.first_found_at),
          searched_at = excluded.searched_at,
          updated_at = now(),
          raw = excluded.raw
      `, [
        job.rutid,
        item?.matchKey ?? matchKey,
        item?.companyName ?? job.company_name,
        item?.website ?? null,
        emails,
        phones,
        JSON.stringify(sourceUrls),
        internal && item?.source && item.source !== 'none' ? `internal_layers+${item.source}` : internal ? 'internal_layers' : item?.source ?? 'none',
        item?.searchProvider ?? (internal ? 'internal' : 'none'),
        status,
        hasContact,
        JSON.stringify({ internal: internal?.evidence ?? null, web: item ?? null }),
      ])

      await pool.query(`
        update public.company_web_enrichment_queue
        set status = $2,
            completed_at = case when $2 in ('completed', 'no_result') then now() else completed_at end,
            last_error = case when $2 = 'failed' then 'web enrichment returned error' else null end,
            locked_at = null,
            locked_by = null,
            updated_at = now()
        where id = $1::bigint
      `, [job.id, queueStatus])
    }

    return {
      claimed: jobs.length,
      found,
      internal_found: internalFound,
      no_result: noResult,
      failed,
      web_attempted: jobsNeedingWeb.length,
      providers: enrichment.providers,
      limited_by_service_batch: enrichment.limited,
    }
  } catch (error) {
    await markFailed(pool, jobs, error)
    throw error
  }
}

async function getProgress(pool: pg.Pool) {
  const { rows } = await pool.query(`
    select * from public.company_web_enrichment_progress
  `)
  const { rows: results } = await pool.query(`
    select
      count(*)::bigint as result_total,
      count(*) filter (where status = 'found')::bigint as found,
      count(*) filter (where status = 'none')::bigint as none,
      count(*) filter (where status = 'error')::bigint as error,
      count(*) filter (where cardinality(emails) > 0)::bigint as with_email,
      count(*) filter (where cardinality(phones) > 0)::bigint as with_phone,
      max(searched_at) as last_search
    from public.company_web_enrichment_results
  `)

  return { queue: rows[0] ?? null, results: results[0] ?? null }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.enqueue && !args.process && !args.progress) {
    throw new Error('Uso: --enqueue, --process o --progress. Opcional: --limit=5000 --batch-size=50 --need=any --dry-run.')
  }

  if (!Number.isFinite(args.limit) || args.limit < 1) throw new Error('--limit invalido.')
  if (!Number.isFinite(args.batchSize) || args.batchSize < 1 || args.batchSize > 200) {
    throw new Error('--batch-size debe estar entre 1 y 200.')
  }

  const pool = createPool()
  await ensureSchema(pool)

  try {
    const output: Record<string, unknown> = { ok: true }
    if (args.enqueue) output.enqueue = await enqueueCandidates(pool, args)
    if (args.process) output.process = await processBatch(pool, args)
    if (args.progress) output.progress = await getProgress(pool)
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  } finally {
    await pool.end()
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
