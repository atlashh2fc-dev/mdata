-- Base Contact dataset
-- Contactos ALO/validos del contact center sincronizados desde Registro Intel.

drop materialized view if exists public.base_contact;

create materialized view public.base_contact as
with alo_feedback as (
  select
    f.*,
    coalesce(f.matched_rutid, f.rutid) as entity_rutid,
    nullif(btrim(f.raw_payload->>'contact_name'), '') as raw_contact_name,
    nullif(btrim(f.raw_payload->>'company_name'), '') as raw_company_name,
    nullif(btrim(f.metadata->>'source_updated_at'), '') as source_updated_at_text
  from public.contact_center_feedback f
  where f.channel = 'phone'
    and f.effective_contact = true
    and f.outcome in ('contacted', 'interested', 'callback', 'rejected', 'sale')
    and coalesce(f.outcome_reason, '') !~* 'numero erroneo|n[uú]mero err[oó]neo|no corresponde|telefono fuera|tel[eé]fono fuera|fuera de servicio|no se encuentra la numeraci[oó]n|sin direcci[oó]n|direcci[oó]n no creada|no se logra'
    and coalesce(f.matched_rutid, f.rutid) is not null
),
ranked as (
  select
    f.*,
    row_number() over (
      partition by f.entity_rutid
      order by
        f.is_best_management desc,
        case f.outcome
          when 'sale' then 1
          when 'callback' then 2
          when 'interested' then 3
          when 'contacted' then 4
          when 'rejected' then 5
          else 9
        end,
        f.managed_at desc,
        f.id
    ) as contact_rank
  from alo_feedback f
),
phone_choice as (
  select distinct on (pcp.rutid)
    pcp.rutid,
    pcp.contact_value as best_phone,
    pcp.quality_score as best_phone_quality,
    pcp.last_feedback_at as best_phone_feedback_at
  from public.persona_contact_points pcp
  where pcp.contact_type = 'phone'
  order by pcp.rutid, pcp.is_verified desc, pcp.is_primary desc, pcp.quality_score desc, pcp.last_seen_at desc
),
email_choice as (
  select distinct on (pcp.rutid)
    pcp.rutid,
    pcp.contact_value as best_email,
    pcp.quality_score as best_email_quality,
    pcp.last_feedback_at as best_email_feedback_at
  from public.persona_contact_points pcp
  where pcp.contact_type = 'email'
  order by pcp.rutid, pcp.is_verified desc, pcp.is_primary desc, pcp.quality_score desc, pcp.last_seen_at desc
)
select
  r.external_event_id as contact_event_id,
  r.id as feedback_id,
  r.external_source,
  r.external_record_type,
  r.entity_rutid as rutid,
  case
    when length(regexp_replace(r.entity_rutid, '[^0-9Kk]', '', 'g')) >= 2 then
      concat(
        regexp_replace(left(regexp_replace(r.entity_rutid, '[^0-9Kk]', '', 'g'), -1), '^0+', ''),
        '-',
        right(regexp_replace(r.entity_rutid, '[^0-9Kk]', '', 'g'), 1)
      )
    else r.entity_rutid
  end as rut_formateado,
  case
    when ecu.rutid is not null or pm.razon_social_empresa is not null then 'empresa'
    when pm.rutid is not null then 'persona'
    else 'sin_match'
  end as entity_type,
  coalesce(
    r.raw_contact_name,
    nullif(concat_ws(' ', pm.nombres, pm.paterno, pm.materno), ''),
    nullif(r.raw_payload->>'contact_full_name', '')
  ) as contact_name,
  coalesce(ecu.razon_social, r.raw_company_name, pm.razon_social_empresa) as company_name,
  coalesce(ecu.razon_social, r.raw_company_name, nullif(concat_ws(' ', pm.nombres, pm.paterno, pm.materno), ''), pm.razon_social_empresa) as display_name,
  r.contact_phone,
  r.phone_normalized,
  r.contact_email,
  r.email_normalized,
  coalesce(phone_choice.best_phone, r.contact_phone) as best_phone,
  phone_choice.best_phone_quality,
  coalesce(email_choice.best_email, r.contact_email) as best_email,
  email_choice.best_email_quality,
  r.channel::text as channel,
  r.managed_at,
  r.outcome::text as outcome,
  r.outcome_subtype,
  r.outcome_reason,
  case
    when r.sale then 'venta'
    when r.callback_requested or r.outcome = 'callback' then 'rellamar'
    when r.interested or r.outcome = 'interested' then 'interesado'
    when r.outcome = 'rejected' then 'rechazo_contactado'
    else 'contactado'
  end as valid_contact_label,
  r.direction,
  r.duration_seconds,
  r.talk_seconds,
  r.wait_seconds,
  r.agent_id,
  r.agent_name,
  r.campaign_id,
  r.campaign_name,
  r.callback_at,
  r.sold_at,
  r.value_amount,
  r.interested,
  r.callback_requested,
  r.sale,
  r.is_best_management,
  r.contact_rank = 1 as is_best_contact_for_rut,
  ps.contactability_score,
  ps.purchase_propensity_score,
  ps.priority_score,
  ps.best_channel::text as scoring_best_channel,
  ps.best_contact_hour,
  ps.next_best_action,
  ps.action_priority,
  ps.should_contact,
  ps.total_interactions,
  ps.effective_contacts,
  ps.interest_events,
  ps.callback_events,
  ps.sales_events,
  ps.known_phone_count,
  ps.known_email_count,
  ps.last_feedback_at,
  ecu.segmento_tamano_empresa,
  ecu.es_pyme,
  ecu.es_gran_empresa,
  ecu.tipo_contribuyente_ultimo,
  ecu.subtipo_contribuyente_ultimo,
  ecu.rubro_economico_ultimo,
  ecu.subrubro_economico_ultimo,
  ecu.actividad_economica_ultima,
  ecu.tramo_ventas_2024,
  ecu.ultimo_tramo_ventas,
  ecu.trabajadores_2024,
  ecu.resultado_tendencia,
  ecu.region,
  ecu.comuna,
  ecu.domicilio_direccion,
  ecu.n_autos,
  ecu.n_bienes_raices,
  ecu.totalavaluos,
  ecu.score_patrimonial,
  ecu.cobertura_pct,
  pm.nombres as persona_nombres,
  pm.paterno as persona_paterno,
  pm.materno as persona_materno,
  pm.comuna_part as persona_comuna,
  pm.region_part as persona_region,
  coalesce(nullif(r.source_updated_at_text, '')::timestamptz, r.updated_at) as source_updated_at,
  now() as dataset_refreshed_at,
  r.raw_payload
from ranked r
left join public.personas_master_clasificada pm
  on pm.rutid = r.entity_rutid
left join public.empresas_comercial_unificada ecu
  on lpad(regexp_replace(ecu.rutid::text, '[^0-9Kk]', '', 'g'), 10, '0') = lpad(regexp_replace(r.entity_rutid::text, '[^0-9Kk]', '', 'g'), 10, '0')
left join public.persona_scores ps
  on ps.rutid = r.entity_rutid
left join phone_choice
  on phone_choice.rutid = r.entity_rutid
left join email_choice
  on email_choice.rutid = r.entity_rutid
where r.contact_rank = 1
with data;

create unique index if not exists idx_base_contact_event_id
  on public.base_contact (contact_event_id);

create index if not exists idx_base_contact_rutid
  on public.base_contact (rutid, managed_at desc);

create index if not exists idx_base_contact_best
  on public.base_contact (is_best_contact_for_rut, priority_score desc, managed_at desc)
  where is_best_contact_for_rut = true;

create index if not exists idx_base_contact_phone
  on public.base_contact (phone_normalized)
  where phone_normalized is not null;

create index if not exists idx_base_contact_email
  on public.base_contact (email_normalized)
  where email_normalized is not null;

grant select on public.base_contact to authenticated, service_role;

create table if not exists public.source_versions (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.data_sources(id) on delete cascade,
  version_label text not null,
  load_mode text not null default 'refresh',
  source_row_count bigint not null default 0,
  loaded_row_count bigint not null default 0,
  new_rows bigint not null default 0,
  updated_rows bigint not null default 0,
  failed_rows bigint not null default 0,
  checksum text,
  source_snapshot_at timestamptz,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running',
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_source_versions_source_id
  on public.source_versions (source_id, created_at desc);

create index if not exists idx_source_versions_status
  on public.source_versions (status);

create or replace view public.dataset_overview as
select
  ds.id,
  ds.name,
  ds.slug,
  ds.description,
  ds.source_type,
  ds.is_active,
  ds.config,
  ds.created_by,
  ds.created_at,
  ds.updated_at,
  ds.canonical_table,
  ds.source_table_name,
  ds.primary_key_column,
  ds.supports_incremental,
  ds.record_count,
  ds.coverage_pct,
  ds.last_loaded_at,
  ds.last_job_status,
  ds.last_error_message,
  sv.id as latest_version_id,
  sv.version_label as latest_version_label,
  sv.load_mode as latest_load_mode,
  sv.source_row_count as latest_source_row_count,
  sv.loaded_row_count as latest_loaded_row_count,
  sv.new_rows as latest_new_rows,
  sv.updated_rows as latest_updated_rows,
  sv.failed_rows as latest_failed_rows,
  sv.status as latest_version_status,
  sv.completed_at as latest_version_completed_at
from public.data_sources ds
left join lateral (
  select *
  from public.source_versions sv
  where sv.source_id = ds.id
  order by coalesce(sv.completed_at, sv.started_at, sv.created_at) desc, sv.created_at desc
  limit 1
) sv on true;

grant select on public.dataset_overview to authenticated, service_role;

create or replace function public.refresh_base_contact_dataset()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_id uuid;
  v_started_at timestamptz := now();
  v_record_count bigint := 0;
  v_unique_ruts bigint := 0;
  v_best_contacts bigint := 0;
begin
  refresh materialized view public.base_contact;

  select
    count(*),
    count(distinct rutid),
    count(*) filter (where is_best_contact_for_rut)
  into v_record_count, v_unique_ruts, v_best_contacts
  from public.base_contact;

  insert into public.data_sources (
    name,
    slug,
    description,
    source_type,
    canonical_table,
    source_table_name,
    primary_key_column,
    supports_incremental,
    record_count,
    coverage_pct,
    last_loaded_at,
    last_job_status,
    last_error_message,
    is_active,
    config
  )
  values (
    'Base Contact',
    'base_contact',
    'Contactos ALO validos del contact center sincronizados desde CRM, enriquecidos con empresa, persona, scoring y mejores datos de contacto.',
    'postgres',
    'base_contact',
    'contact_center_feedback',
    'contact_event_id',
    true,
    v_record_count,
    null,
    now(),
    'completed',
    null,
    true,
    jsonb_build_object(
      'refresh_schedule', 'Diario 12:00 America/Santiago',
      'source', 'registro_intel.crm_feedback_export_v1',
      'unique_ruts', v_unique_ruts,
      'best_contacts', v_best_contacts,
      'definition', 'phone + effective_contact + outcome contacted/interested/callback/rejected/sale, excluyendo telefonos invalidos/no corresponde'
    )
  )
  on conflict (slug) do update
  set
    name = excluded.name,
    description = excluded.description,
    source_type = excluded.source_type,
    canonical_table = excluded.canonical_table,
    source_table_name = excluded.source_table_name,
    primary_key_column = excluded.primary_key_column,
    supports_incremental = excluded.supports_incremental,
    record_count = excluded.record_count,
    coverage_pct = excluded.coverage_pct,
    last_loaded_at = excluded.last_loaded_at,
    last_job_status = excluded.last_job_status,
    last_error_message = excluded.last_error_message,
    is_active = excluded.is_active,
    config = excluded.config,
    updated_at = now()
  returning id into v_source_id;

  insert into public.source_versions (
    source_id,
    version_label,
    load_mode,
    source_row_count,
    loaded_row_count,
    new_rows,
    updated_rows,
    failed_rows,
    source_snapshot_at,
    started_at,
    completed_at,
    status,
    notes,
    metadata
  )
  values (
    v_source_id,
    to_char(now() at time zone 'America/Santiago', 'YYYY-MM-DD HH24:MI'),
    'refresh',
    v_record_count,
    v_record_count,
    0,
    v_record_count,
    0,
    now(),
    v_started_at,
    now(),
    'completed',
    'Refresh automatico de Base Contact desde contact_center_feedback.',
    jsonb_build_object(
      'unique_ruts', v_unique_ruts,
      'best_contacts', v_best_contacts
    )
  );

  return jsonb_build_object(
    'ok', true,
    'record_count', v_record_count,
    'unique_ruts', v_unique_ruts,
    'best_contacts', v_best_contacts,
    'refreshed_at', now()
  );
exception
  when others then
    update public.data_sources
    set last_job_status = 'failed',
        last_error_message = sqlerrm,
        updated_at = now()
    where slug = 'base_contact';
    raise;
end;
$$;

revoke all on function public.refresh_base_contact_dataset() from public;
grant execute on function public.refresh_base_contact_dataset() to service_role;

select public.refresh_base_contact_dataset();
