begin;

create table public.customer_360_companies (
  rutid text primary key,
  razon_social text,
  company_segment text,
  tipo_contribuyente text,
  subtipo_contribuyente text,
  rubro_economico text,
  subrubro_economico text,
  actividad_economica text,
  region text,
  comuna text,
  direccion text,
  sii_active boolean,
  sales_band_2024 integer,
  latest_sales_band integer,
  workers_2024 integer,
  sales_trend text,
  primary_phone text,
  primary_email text,
  primary_contact_name text,
  should_contact boolean,
  master_priority_score integer,
  is_equifax_customer boolean,
  is_wom_customer boolean,
  interaction_count bigint not null default 0,
  effective_contact_count bigint not null default 0,
  interested_count bigint not null default 0,
  callback_count bigint not null default 0,
  sale_count bigint not null default 0,
  email_open_count bigint not null default 0,
  email_click_count bigint not null default 0,
  do_not_contact boolean not null default false,
  last_feedback_at timestamptz,
  last_feedback_updated_at timestamptz,
  last_feedback_event_id text,
  last_feedback_source text,
  last_channel text,
  last_outcome text,
  last_status text,
  last_reason text,
  last_campaign_key text,
  last_agent_name text,
  next_action_at timestamptz,
  decision_campaign_key text,
  decision_priority_rank integer,
  dynamic_priority_score numeric,
  priority_reason text,
  recommended_channel text,
  optimal_window text,
  decision_version text,
  last_decision_at timestamptz,
  last_decision_event_id text,
  in_empresas_master boolean not null default false,
  in_empresas_comercial_unificada boolean not null default false,
  base_refreshed_at timestamptz,
  feedback_refreshed_at timestamptz,
  decision_refreshed_at timestamptz,
  projection_version bigint not null default 1,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_360_rutid_normalized check (rutid ~ '^[0-9]{9}[0-9K]$'),
  constraint customer_360_priority_rank_valid check (decision_priority_rank is null or decision_priority_rank between 1 and 100)
);

create index customer_360_last_feedback_idx
  on public.customer_360_companies (last_feedback_at desc nulls last, rutid);
create index customer_360_campaign_idx
  on public.customer_360_companies (last_campaign_key, last_feedback_at desc nulls last);
create index customer_360_decision_campaign_idx
  on public.customer_360_companies (decision_campaign_key, decision_priority_rank, rutid);
create index customer_360_region_comuna_idx
  on public.customer_360_companies (region, comuna, rutid);
create index customer_360_should_contact_idx
  on public.customer_360_companies (master_priority_score desc nulls last, rutid)
  where should_contact is true and do_not_contact is false;

create table public.customer_360_pending (
  rutid text primary key,
  reason text not null,
  source_watermark_at timestamptz not null,
  source_watermark_id text not null,
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_until timestamptz,
  locked_by text,
  last_error text,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_360_pending_rutid_normalized check (rutid ~ '^[0-9]{9}[0-9K]$')
);

create index customer_360_pending_claim_idx
  on public.customer_360_pending (available_at, source_watermark_at, source_watermark_id, rutid);
create index customer_360_pending_stale_lock_idx
  on public.customer_360_pending (locked_until)
  where locked_until is not null;

create table public.customer_360_checkpoints (
  source_name text primary key,
  cursor_at timestamptz not null default '1970-01-01 00:00:00+00'::timestamptz,
  cursor_id text not null default '',
  cycle_count bigint not null default 0 check (cycle_count >= 0),
  rows_processed bigint not null default 0 check (rows_processed >= 0),
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.customer_360_checkpoints (source_name)
values
  ('contact_center_feedback'),
  ('commercial_outbox'),
  ('empresas_master'),
  ('empresas_comercial_unificada')
on conflict (source_name) do nothing;

create index if not exists contact_center_feedback_customer_360_cursor_idx
  on public.contact_center_feedback (updated_at, id);
create index if not exists commercial_outbox_customer_360_cursor_idx
  on public.commercial_outbox (updated_at, id);
create index if not exists commercial_outbox_customer_360_lead_idx
  on public.commercial_outbox (aggregate_id, created_at desc, id desc)
  where aggregate_type = 'lead' and event_name = 'intelligence.decision.v1' and status <> 'dead';

alter table public.customer_360_companies enable row level security;
alter table public.customer_360_pending enable row level security;
alter table public.customer_360_checkpoints enable row level security;

revoke all on table public.customer_360_companies from public, anon, authenticated;
revoke all on table public.customer_360_pending from public, anon, authenticated;
revoke all on table public.customer_360_checkpoints from public, anon, authenticated;

grant select on table public.customer_360_companies to authenticated, service_role;
grant insert, update, delete on table public.customer_360_companies to service_role;
grant select, insert, update, delete on table public.customer_360_pending to service_role;
grant select, insert, update, delete on table public.customer_360_checkpoints to service_role;

create policy customer_360_authenticated_read
  on public.customer_360_companies
  for select
  to authenticated
  using (true);

create or replace function public.refresh_customer_360_rutids(p_rutids text[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  with keys as materialized (
    select distinct normalized_rutid as rutid
    from (
      select public.normalize_feedback_rutid(value) as normalized_rutid
      from unnest(coalesce(p_rutids, '{}'::text[])) as values_in(value)
    ) normalized
    where normalized_rutid ~ '^[0-9]{9}[0-9K]$'
  ), feedback_rows as materialized (
    select
      k.rutid as customer_rutid,
      f.*
    from keys k
    join public.contact_center_feedback f
      on coalesce(f.matched_rutid, f.rutid) = k.rutid
  ), feedback_stats as (
    select
      customer_rutid as rutid,
      count(*)::bigint as interaction_count,
      count(*) filter (where effective_contact)::bigint as effective_contact_count,
      count(*) filter (where interested)::bigint as interested_count,
      count(*) filter (where callback_requested)::bigint as callback_count,
      count(*) filter (where sale)::bigint as sale_count,
      count(*) filter (where mail_opened)::bigint as email_open_count,
      count(*) filter (where clicked)::bigint as email_click_count,
      bool_or(outcome::text = 'do_not_contact') as do_not_contact,
      max(updated_at) as feedback_refreshed_at
    from feedback_rows
    group by customer_rutid
  ), latest_feedback as (
    select distinct on (customer_rutid)
      customer_rutid as rutid,
      managed_at,
      updated_at,
      external_event_id,
      external_source,
      channel::text as channel,
      outcome::text as outcome,
      outcome_subtype,
      outcome_reason,
      campaign_name,
      agent_name,
      callback_at,
      contact_phone,
      contact_email,
      metadata
    from feedback_rows
    order by customer_rutid, managed_at desc, updated_at desc, id desc
  ), latest_decision as (
    select distinct on (k.rutid)
      k.rutid,
      o.created_at,
      o.idempotency_key,
      o.payload
    from keys k
    join public.commercial_outbox o
      on o.aggregate_id = k.rutid
    where o.aggregate_type = 'lead'
      and o.event_name = 'intelligence.decision.v1'
      and o.status <> 'dead'
    order by k.rutid, o.created_at desc, o.id desc
  ), source_rows as (
    select
      k.rutid,
      em.rutid is not null as in_empresas_master,
      (evt.rutid is not null and evt.anio_ultimo = 2024 and evt.fecha_termino_giro_ultima is null) as in_empresas_comercial_unificada,
      coalesce(nullif(em.razon_social, ''), nullif(evt.razon_social_ultima, ''), nullif(lf.metadata->>'company_name', '')) as razon_social,
      coalesce(nullif(em.tamano_empresas, ''), case
        when evt.ultimo_tramo_ventas is null then null
        when evt.ultimo_tramo_ventas <= 5 then 'micro'
        when evt.ultimo_tramo_ventas <= 7 then 'pequena'
        when evt.ultimo_tramo_ventas <= 9 then 'mediana'
        when evt.ultimo_tramo_ventas <= 12 then 'gran_empresa'
        else 'corporacion' end) as company_segment,
      coalesce(nullif(em.tipo_contribuyente_ultimo, ''), nullif(evt.tipo_contribuyente_ultimo, '')) as tipo_contribuyente,
      coalesce(nullif(em.subtipo_contribuyente_ultimo, ''), nullif(evt.subtipo_contribuyente_ultimo, '')) as subtipo_contribuyente,
      coalesce(nullif(em.rubro_economico_ultimo, ''), nullif(evt.rubro_economico_ultimo, '')) as rubro_economico,
      coalesce(nullif(em.subrubro_economico_ultimo, ''), nullif(evt.subrubro_economico_ultimo, '')) as subrubro_economico,
      coalesce(nullif(em.actividad_economica_ultima, ''), nullif(evt.actividad_economica_ultima, '')) as actividad_economica,
      coalesce(nullif(em.region, ''), nullif(evt.region_ultima, '')) as region,
      coalesce(nullif(em.comuna, ''), nullif(evt.comuna_ultima, '')) as comuna,
      nullif(em.direccion, '') as direccion,
      coalesce(em.sii_activa_sin_termino_giro, evt.anio_ultimo = 2024 and evt.fecha_termino_giro_ultima is null, false) as sii_active,
      coalesce(em.tramo_ventas_2024, evt.tramo_ventas_2024) as sales_band_2024,
      coalesce(em.ultimo_tramo_ventas, evt.ultimo_tramo_ventas) as latest_sales_band,
      coalesce(em.trabajadores_2024, evt.trabajadores_2024) as workers_2024,
      coalesce(nullif(em.resultado_tendencia, ''), nullif(evt.resultado_tendencia, '')) as sales_trend,
      coalesce(nullif(em.mejor_fono, ''), nullif(lf.contact_phone, '')) as primary_phone,
      coalesce(nullif(em.mejor_email, ''), nullif(lf.contact_email, '')) as primary_email,
      coalesce(nullif(em.crm_contact_name, ''), nullif(lf.metadata->>'contact_name', '')) as primary_contact_name,
      em.crm_should_contact as should_contact,
      em.crm_priority_score as master_priority_score,
      em.es_cliente_equifax as is_equifax_customer,
      em.es_cliente_wom as is_wom_customer,
      coalesce(fs.interaction_count, 0) as interaction_count,
      coalesce(fs.effective_contact_count, 0) as effective_contact_count,
      coalesce(fs.interested_count, 0) as interested_count,
      coalesce(fs.callback_count, 0) as callback_count,
      coalesce(fs.sale_count, 0) as sale_count,
      coalesce(fs.email_open_count, 0) as email_open_count,
      coalesce(fs.email_click_count, 0) as email_click_count,
      coalesce(fs.do_not_contact, false) as do_not_contact,
      lf.managed_at as last_feedback_at,
      lf.updated_at as last_feedback_updated_at,
      lf.external_event_id as last_feedback_event_id,
      lf.external_source as last_feedback_source,
      lf.channel as last_channel,
      lf.outcome as last_outcome,
      lf.outcome_subtype as last_status,
      lf.outcome_reason as last_reason,
      lf.campaign_name as last_campaign_key,
      lf.agent_name as last_agent_name,
      lf.callback_at as next_action_at,
      ld.payload->>'campaign_key' as decision_campaign_key,
      case when jsonb_typeof(ld.payload#>'{item,payload,priority_rank}') = 'number'
        then (ld.payload#>>'{item,payload,priority_rank}')::integer end as decision_priority_rank,
      case when jsonb_typeof(ld.payload#>'{item,payload,dynamic_priority_score}') = 'number'
        then (ld.payload#>>'{item,payload,dynamic_priority_score}')::numeric end as dynamic_priority_score,
      ld.payload#>>'{item,payload,priority_reason}' as priority_reason,
      ld.payload#>>'{item,payload,recommended_channel}' as recommended_channel,
      ld.payload#>>'{item,payload,optimal_window}' as optimal_window,
      ld.payload#>>'{item,payload,decision_version}' as decision_version,
      ld.created_at as last_decision_at,
      ld.idempotency_key as last_decision_event_id,
      fs.feedback_refreshed_at,
      jsonb_strip_nulls(jsonb_build_object(
        'equifax_sales_count', em.equifax_n_ventas,
        'equifax_last_sale_at', em.equifax_ultima_venta,
        'equifax_total_value', em.equifax_valor_total,
        'wom_lines', em.wom_lineas,
        'source_count', em.n_fuentes,
        'master_build_at', em.build_at,
        'master_crm_synced_at', em.crm_synced_at
      )) as attributes
    from keys k
    left join public.empresas_master em on em.rutid = k.rutid
    left join public.empresas_ventas_tendencia evt
      on evt.rutid = ltrim(k.rutid, '0')
    left join feedback_stats fs on fs.rutid = k.rutid
    left join latest_feedback lf on lf.rutid = k.rutid
    left join latest_decision ld on ld.rutid = k.rutid
  ), upserted as (
    insert into public.customer_360_companies as c360 (
      rutid, razon_social, company_segment, tipo_contribuyente, subtipo_contribuyente,
      rubro_economico, subrubro_economico, actividad_economica, region, comuna, direccion,
      sii_active, sales_band_2024, latest_sales_band, workers_2024, sales_trend,
      primary_phone, primary_email, primary_contact_name, should_contact, master_priority_score,
      is_equifax_customer, is_wom_customer, interaction_count, effective_contact_count,
      interested_count, callback_count, sale_count, email_open_count, email_click_count,
      do_not_contact, last_feedback_at, last_feedback_updated_at, last_feedback_event_id,
      last_feedback_source, last_channel, last_outcome, last_status, last_reason,
      last_campaign_key, last_agent_name, next_action_at, decision_campaign_key,
      decision_priority_rank, dynamic_priority_score, priority_reason, recommended_channel,
      optimal_window, decision_version, last_decision_at, last_decision_event_id,
      in_empresas_master, in_empresas_comercial_unificada, base_refreshed_at,
      feedback_refreshed_at, decision_refreshed_at, attributes
    )
    select
      rutid, razon_social, company_segment, tipo_contribuyente, subtipo_contribuyente,
      rubro_economico, subrubro_economico, actividad_economica, region, comuna, direccion,
      sii_active, sales_band_2024, latest_sales_band, workers_2024, sales_trend,
      primary_phone, primary_email, primary_contact_name, should_contact, master_priority_score,
      is_equifax_customer, is_wom_customer, interaction_count, effective_contact_count,
      interested_count, callback_count, sale_count, email_open_count, email_click_count,
      do_not_contact, last_feedback_at, last_feedback_updated_at, last_feedback_event_id,
      last_feedback_source, last_channel, last_outcome, last_status, last_reason,
      last_campaign_key, last_agent_name, next_action_at, decision_campaign_key,
      decision_priority_rank, dynamic_priority_score, priority_reason, recommended_channel,
      optimal_window, decision_version, last_decision_at, last_decision_event_id,
      in_empresas_master, in_empresas_comercial_unificada, now(), feedback_refreshed_at,
      case when last_decision_at is null then null else now() end, attributes
    from source_rows
    on conflict (rutid) do update set
      razon_social = excluded.razon_social,
      company_segment = excluded.company_segment,
      tipo_contribuyente = excluded.tipo_contribuyente,
      subtipo_contribuyente = excluded.subtipo_contribuyente,
      rubro_economico = excluded.rubro_economico,
      subrubro_economico = excluded.subrubro_economico,
      actividad_economica = excluded.actividad_economica,
      region = excluded.region,
      comuna = excluded.comuna,
      direccion = excluded.direccion,
      sii_active = excluded.sii_active,
      sales_band_2024 = excluded.sales_band_2024,
      latest_sales_band = excluded.latest_sales_band,
      workers_2024 = excluded.workers_2024,
      sales_trend = excluded.sales_trend,
      primary_phone = excluded.primary_phone,
      primary_email = excluded.primary_email,
      primary_contact_name = excluded.primary_contact_name,
      should_contact = excluded.should_contact,
      master_priority_score = excluded.master_priority_score,
      is_equifax_customer = excluded.is_equifax_customer,
      is_wom_customer = excluded.is_wom_customer,
      interaction_count = excluded.interaction_count,
      effective_contact_count = excluded.effective_contact_count,
      interested_count = excluded.interested_count,
      callback_count = excluded.callback_count,
      sale_count = excluded.sale_count,
      email_open_count = excluded.email_open_count,
      email_click_count = excluded.email_click_count,
      do_not_contact = excluded.do_not_contact,
      last_feedback_at = excluded.last_feedback_at,
      last_feedback_updated_at = excluded.last_feedback_updated_at,
      last_feedback_event_id = excluded.last_feedback_event_id,
      last_feedback_source = excluded.last_feedback_source,
      last_channel = excluded.last_channel,
      last_outcome = excluded.last_outcome,
      last_status = excluded.last_status,
      last_reason = excluded.last_reason,
      last_campaign_key = excluded.last_campaign_key,
      last_agent_name = excluded.last_agent_name,
      next_action_at = excluded.next_action_at,
      decision_campaign_key = excluded.decision_campaign_key,
      decision_priority_rank = excluded.decision_priority_rank,
      dynamic_priority_score = excluded.dynamic_priority_score,
      priority_reason = excluded.priority_reason,
      recommended_channel = excluded.recommended_channel,
      optimal_window = excluded.optimal_window,
      decision_version = excluded.decision_version,
      last_decision_at = excluded.last_decision_at,
      last_decision_event_id = excluded.last_decision_event_id,
      in_empresas_master = excluded.in_empresas_master,
      in_empresas_comercial_unificada = excluded.in_empresas_comercial_unificada,
      base_refreshed_at = excluded.base_refreshed_at,
      feedback_refreshed_at = excluded.feedback_refreshed_at,
      decision_refreshed_at = excluded.decision_refreshed_at,
      attributes = excluded.attributes,
      projection_version = c360.projection_version + 1,
      updated_at = now()
    returning 1
  )
  select count(*)::integer into v_count from upserted;

  return v_count;
end;
$$;

create or replace function public.enqueue_customer_360_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rutid text;
  v_at timestamptz;
  v_id text;
  v_reason text;
begin
  if tg_table_name = 'contact_center_feedback' then
    v_rutid := public.normalize_feedback_rutid(coalesce(new.matched_rutid, new.rutid));
    v_at := new.updated_at;
    v_id := new.id::text;
    v_reason := 'feedback:' || new.external_source;
  elsif tg_table_name = 'commercial_outbox' then
    if new.aggregate_type <> 'lead' or new.event_name <> 'intelligence.decision.v1' then return new; end if;
    v_rutid := public.normalize_feedback_rutid(new.aggregate_id);
    v_at := new.updated_at;
    v_id := new.id::text;
    v_reason := 'decision:' || new.status;
  else
    return new;
  end if;

  if v_rutid is null or v_rutid !~ '^[0-9]{9}[0-9K]$' then return new; end if;

  insert into public.customer_360_pending as pending (
    rutid, reason, source_watermark_at, source_watermark_id, available_at
  ) values (
    v_rutid, v_reason, v_at, v_id, now()
  )
  on conflict (rutid) do update set
    reason = excluded.reason,
    source_watermark_at = case
      when (excluded.source_watermark_at, excluded.source_watermark_id) >=
           (pending.source_watermark_at, pending.source_watermark_id)
      then excluded.source_watermark_at else pending.source_watermark_at end,
    source_watermark_id = case
      when (excluded.source_watermark_at, excluded.source_watermark_id) >=
           (pending.source_watermark_at, pending.source_watermark_id)
      then excluded.source_watermark_id else pending.source_watermark_id end,
    available_at = least(pending.available_at, now()),
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists contact_center_feedback_customer_360_enqueue on public.contact_center_feedback;
create trigger contact_center_feedback_customer_360_enqueue
after insert or update on public.contact_center_feedback
for each row execute function public.enqueue_customer_360_change();

drop trigger if exists commercial_outbox_customer_360_enqueue on public.commercial_outbox;
create trigger commercial_outbox_customer_360_enqueue
after insert or update on public.commercial_outbox
for each row execute function public.enqueue_customer_360_change();

create or replace function public.process_customer_360_pending(
  p_worker text,
  p_limit integer default 500,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rutids text[];
  v_refreshed integer := 0;
  v_error text;
begin
  if nullif(btrim(coalesce(p_worker, '')), '') is null then
    raise exception 'worker es obligatorio';
  end if;

  with picked as (
    select p.rutid
    from public.customer_360_pending p
    where p.available_at <= now()
      and (p.locked_until is null or p.locked_until <= now())
    order by p.source_watermark_at, p.source_watermark_id, p.rutid
    limit least(greatest(coalesce(p_limit, 500), 1), 1000)
    for update skip locked
  ), claimed as (
    update public.customer_360_pending p
    set locked_at = now(),
        locked_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 15), 900)),
        locked_by = p_worker,
        attempts = p.attempts + 1,
        last_error = null,
        updated_at = now()
    from picked
    where p.rutid = picked.rutid
    returning p.rutid
  )
  select array_agg(rutid order by rutid) into v_rutids from claimed;

  if coalesce(cardinality(v_rutids), 0) = 0 then
    return jsonb_build_object('ok', true, 'claimed', 0, 'refreshed', 0);
  end if;

  begin
    v_refreshed := public.refresh_customer_360_rutids(v_rutids);
    delete from public.customer_360_pending p
    where p.rutid = any(v_rutids) and p.locked_by = p_worker;
    return jsonb_build_object('ok', true, 'claimed', cardinality(v_rutids), 'refreshed', v_refreshed);
  exception when others then
    v_error := sqlerrm;
    update public.customer_360_pending p
    set locked_at = null,
        locked_until = null,
        locked_by = null,
        available_at = now() + make_interval(secs => least(3600, (power(2, least(p.attempts, 10)) * 5)::integer)),
        last_error = left(v_error, 2000),
        updated_at = now()
    where p.rutid = any(v_rutids) and p.locked_by = p_worker;
    return jsonb_build_object('ok', false, 'claimed', cardinality(v_rutids), 'refreshed', 0, 'error', v_error);
  end;
end;
$$;

create or replace function public.reconcile_customer_360_events(p_limit_per_source integer default 1000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit_per_source, 1000), 1), 5000);
  v_feedback_rutids text[] := '{}';
  v_outbox_rutids text[] := '{}';
  v_all_rutids text[] := '{}';
  v_feedback_count integer := 0;
  v_outbox_count integer := 0;
  v_feedback_at timestamptz;
  v_feedback_id uuid;
  v_outbox_at timestamptz;
  v_outbox_id uuid;
  v_checkpoint public.customer_360_checkpoints%rowtype;
  v_refreshed integer := 0;
begin
  select * into v_checkpoint
  from public.customer_360_checkpoints
  where source_name = 'contact_center_feedback'
  for update;

  with page as materialized (
    select f.id, f.updated_at, public.normalize_feedback_rutid(coalesce(f.matched_rutid, f.rutid)) as rutid
    from public.contact_center_feedback f
    where f.updated_at > v_checkpoint.cursor_at
       or (f.updated_at = v_checkpoint.cursor_at and f.id > coalesce(nullif(v_checkpoint.cursor_id, '')::uuid, '00000000-0000-0000-0000-000000000000'::uuid))
    order by f.updated_at, f.id
    limit v_limit
  )
  select
    coalesce(array_agg(distinct rutid) filter (where rutid is not null), '{}'),
    count(*)::integer,
    (array_agg(updated_at order by updated_at desc, id desc))[1],
    (array_agg(id order by updated_at desc, id desc))[1]
  into v_feedback_rutids, v_feedback_count, v_feedback_at, v_feedback_id
  from page;

  if v_feedback_count > 0 then
    update public.customer_360_checkpoints
    set cursor_at = v_feedback_at,
        cursor_id = v_feedback_id::text,
        rows_processed = rows_processed + v_feedback_count,
        last_run_at = now(),
        last_success_at = now(),
        last_error = null,
        updated_at = now()
    where source_name = 'contact_center_feedback';
  else
    update public.customer_360_checkpoints set last_run_at = now(), updated_at = now()
    where source_name = 'contact_center_feedback';
  end if;

  select * into v_checkpoint
  from public.customer_360_checkpoints
  where source_name = 'commercial_outbox'
  for update;

  with page as materialized (
    select o.id, o.updated_at, public.normalize_feedback_rutid(o.aggregate_id) as rutid
    from public.commercial_outbox o
    where o.aggregate_type = 'lead'
      and o.event_name = 'intelligence.decision.v1'
      and (
        o.updated_at > v_checkpoint.cursor_at
        or (o.updated_at = v_checkpoint.cursor_at and o.id > coalesce(nullif(v_checkpoint.cursor_id, '')::uuid, '00000000-0000-0000-0000-000000000000'::uuid))
      )
    order by o.updated_at, o.id
    limit v_limit
  )
  select
    coalesce(array_agg(distinct rutid) filter (where rutid is not null), '{}'),
    count(*)::integer,
    (array_agg(updated_at order by updated_at desc, id desc))[1],
    (array_agg(id order by updated_at desc, id desc))[1]
  into v_outbox_rutids, v_outbox_count, v_outbox_at, v_outbox_id
  from page;

  if v_outbox_count > 0 then
    update public.customer_360_checkpoints
    set cursor_at = v_outbox_at,
        cursor_id = v_outbox_id::text,
        rows_processed = rows_processed + v_outbox_count,
        last_run_at = now(),
        last_success_at = now(),
        last_error = null,
        updated_at = now()
    where source_name = 'commercial_outbox';
  else
    update public.customer_360_checkpoints set last_run_at = now(), updated_at = now()
    where source_name = 'commercial_outbox';
  end if;

  select coalesce(array_agg(distinct rutid), '{}') into v_all_rutids
  from unnest(v_feedback_rutids || v_outbox_rutids) as combined(rutid);

  if cardinality(v_all_rutids) > 0 then
    v_refreshed := public.refresh_customer_360_rutids(v_all_rutids);
  end if;

  return jsonb_build_object(
    'ok', true,
    'feedback_events', v_feedback_count,
    'outbox_events', v_outbox_count,
    'affected_ruts', cardinality(v_all_rutids),
    'refreshed', v_refreshed
  );
end;
$$;

create or replace function public.reconcile_customer_360_base(p_limit_per_source integer default 2500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit_per_source, 2500), 1), 5000);
  v_master_rutids text[] := '{}';
  v_ecu_rutids text[] := '{}';
  v_all_rutids text[] := '{}';
  v_master_count integer := 0;
  v_ecu_count integer := 0;
  v_master_last text;
  v_ecu_last text;
  v_checkpoint public.customer_360_checkpoints%rowtype;
  v_refreshed integer := 0;
begin
  select * into v_checkpoint from public.customer_360_checkpoints
  where source_name = 'empresas_master' for update;

  with page as materialized (
    select em.rutid
    from public.empresas_master em
    where em.rutid > v_checkpoint.cursor_id
    order by em.rutid
    limit v_limit
  )
  select coalesce(array_agg(rutid order by rutid), '{}'), count(*)::integer, max(rutid)
  into v_master_rutids, v_master_count, v_master_last from page;

  update public.customer_360_checkpoints
  set cursor_id = case when v_master_count = 0 then '' else v_master_last end,
      cycle_count = cycle_count + case when v_master_count = 0 then 1 else 0 end,
      rows_processed = rows_processed + v_master_count,
      last_run_at = now(),
      last_success_at = now(),
      last_error = null,
      updated_at = now()
  where source_name = 'empresas_master';

  select * into v_checkpoint from public.customer_360_checkpoints
  where source_name = 'empresas_comercial_unificada' for update;

  with page as materialized (
    select evt.rutid
    from public.empresas_ventas_tendencia evt
    where evt.anio_ultimo = 2024
      and evt.fecha_termino_giro_ultima is null
      and evt.rutid > v_checkpoint.cursor_id
    order by evt.rutid
    limit v_limit
  )
  select coalesce(array_agg(rutid order by rutid), '{}'), count(*)::integer, max(rutid)
  into v_ecu_rutids, v_ecu_count, v_ecu_last from page;

  update public.customer_360_checkpoints
  set cursor_id = case when v_ecu_count = 0 then '' else v_ecu_last end,
      cycle_count = cycle_count + case when v_ecu_count = 0 then 1 else 0 end,
      rows_processed = rows_processed + v_ecu_count,
      last_run_at = now(),
      last_success_at = now(),
      last_error = null,
      updated_at = now()
  where source_name = 'empresas_comercial_unificada';

  select coalesce(array_agg(distinct normalized_rutid) filter (where normalized_rutid is not null), '{}')
  into v_all_rutids
  from (
    select public.normalize_feedback_rutid(rutid) as normalized_rutid
    from unnest(v_master_rutids || v_ecu_rutids) as combined(rutid)
  ) normalized;

  if cardinality(v_all_rutids) > 0 then
    v_refreshed := public.refresh_customer_360_rutids(v_all_rutids);
  end if;

  return jsonb_build_object(
    'ok', true,
    'master_rows', v_master_count,
    'commercial_view_rows', v_ecu_count,
    'affected_ruts', cardinality(v_all_rutids),
    'refreshed', v_refreshed
  );
end;
$$;

revoke all on function public.refresh_customer_360_rutids(text[]) from public, anon, authenticated;
revoke all on function public.enqueue_customer_360_change() from public, anon, authenticated;
revoke all on function public.process_customer_360_pending(text, integer, integer) from public, anon, authenticated;
revoke all on function public.reconcile_customer_360_events(integer) from public, anon, authenticated;
revoke all on function public.reconcile_customer_360_base(integer) from public, anon, authenticated;

grant execute on function public.refresh_customer_360_rutids(text[]) to service_role;
grant execute on function public.process_customer_360_pending(text, integer, integer) to service_role;
grant execute on function public.reconcile_customer_360_events(integer) to service_role;
grant execute on function public.reconcile_customer_360_base(integer) to service_role;

commit;
