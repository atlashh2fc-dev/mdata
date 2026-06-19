-- Enrich Base Contact with callable contact names.
-- Priority: CRM/person master explicit names, best executive contact, strict personal email inference.

drop materialized view if exists public.base_contact;

create materialized view public.base_contact as
with alo_feedback as (
  select
    f.*,
    coalesce(f.matched_rutid, f.rutid) as entity_rutid,
    nullif(btrim(f.raw_payload->>'contact_name'), '') as raw_contact_name,
    nullif(btrim(f.raw_payload->>'contact_full_name'), '') as raw_contact_full_name,
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
  contact_resolution.contact_name,
  contact_resolution.contact_name_source,
  exec.rutid_ejecutivo as contact_rutid,
  exec.cargo as contact_role,
  coalesce(ecu.razon_social, r.raw_company_name, pm.razon_social_empresa) as company_name,
  coalesce(ecu.razon_social, r.raw_company_name, contact_resolution.contact_name, pm.razon_social_empresa) as display_name,
  r.contact_phone,
  r.phone_normalized,
  r.contact_email,
  r.email_normalized,
  coalesce(phone_choice.best_phone, exec.mejor_telefono, r.contact_phone) as best_phone,
  phone_choice.best_phone_quality,
  coalesce(email_choice.best_email, exec.email, r.contact_email) as best_email,
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
left join public.company_best_executive_contact exec
  on lpad(regexp_replace(exec.rutid::text, '[^0-9Kk]', '', 'g'), 10, '0') = lpad(regexp_replace(r.entity_rutid::text, '[^0-9Kk]', '', 'g'), 10, '0')
left join lateral (
  select
    lower(split_part(coalesce(r.contact_email, email_choice.best_email, exec.email, ''), '@', 1)) as email_user
) email_seed on true
left join lateral (
  select
    regexp_split_to_array(
      regexp_replace(regexp_replace(email_seed.email_user, '[0-9]+$', ''), '[._-]+', ' ', 'g'),
      ' '
    ) as tokens
) email_tokens on true
left join lateral (
  select initcap(array_to_string(email_tokens.tokens, ' ')) as email_contact_name
  where email_seed.email_user ~ '^[a-záéíóúñ]+([._-][a-záéíóúñ]+)+[0-9]*$'
    and email_seed.email_user !~ '(^|[._-])(contacto|ventas|venta|comercial|administracion|admin|info|facturacion|contabilidad|finanzas|recepcion|secretaria|gerencia|rrhh|recursoshumanos|soporte|servicio|clientes|pagos|cobranza|reservas|operaciones|oficina|empresa|mail|correo|postulaciones|licitaciones)($|[._-])'
    and (
      select count(*)
      from unnest(email_tokens.tokens) token
      where length(token) >= 3
    ) >= 2
) email_inferred on true
left join lateral (
  select
    coalesce(
      r.raw_contact_name,
      nullif(concat_ws(' ', pm.nombres, pm.paterno, pm.materno), ''),
      r.raw_contact_full_name,
      nullif(btrim(exec.nombre_ejecutivo), ''),
      email_inferred.email_contact_name
    ) as contact_name,
    case
      when r.raw_contact_name is not null then 'crm_contact_name'
      when nullif(concat_ws(' ', pm.nombres, pm.paterno, pm.materno), '') is not null then 'personas_master'
      when r.raw_contact_full_name is not null then 'crm_contact_full_name'
      when nullif(btrim(exec.nombre_ejecutivo), '') is not null then 'company_best_executive_contact'
      when email_inferred.email_contact_name is not null then 'email_local_part_inferred'
      else null
    end as contact_name_source
) contact_resolution on true
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

create index if not exists idx_base_contact_contact_name
  on public.base_contact (contact_name)
  where contact_name is not null;

grant select on public.base_contact to authenticated, service_role;

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
  v_contact_names bigint := 0;
  v_contact_name_sources jsonb := '{}'::jsonb;
begin
  refresh materialized view public.base_contact;

  select
    count(*),
    count(distinct rutid),
    count(*) filter (where is_best_contact_for_rut),
    count(*) filter (where nullif(btrim(contact_name), '') is not null)
  into v_record_count, v_unique_ruts, v_best_contacts, v_contact_names
  from public.base_contact;

  select coalesce(jsonb_object_agg(contact_name_source, source_count), '{}'::jsonb)
  into v_contact_name_sources
  from (
    select contact_name_source, count(*) as source_count
    from public.base_contact
    where contact_name_source is not null
    group by contact_name_source
  ) sources;

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
    'Contactos ALO validos del contact center sincronizados desde CRM, enriquecidos con empresa, persona, scoring, mejores datos de contacto y nombre callable del contacto.',
    'postgres',
    'base_contact',
    'contact_center_feedback',
    'contact_event_id',
    true,
    v_record_count,
    case when v_record_count > 0 then round((v_contact_names::numeric / v_record_count::numeric) * 100, 2) else null end,
    now(),
    'completed',
    null,
    true,
    jsonb_build_object(
      'refresh_schedule', 'Diario 12:00 America/Santiago',
      'source', 'registro_intel.crm_feedback_export_v1',
      'unique_ruts', v_unique_ruts,
      'best_contacts', v_best_contacts,
      'contact_names', v_contact_names,
      'contact_name_sources', v_contact_name_sources,
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
    'Refresh automatico de Base Contact desde contact_center_feedback con enriquecimiento de nombres de contacto.',
    jsonb_build_object(
      'unique_ruts', v_unique_ruts,
      'best_contacts', v_best_contacts,
      'contact_names', v_contact_names,
      'contact_name_sources', v_contact_name_sources
    )
  );

  return jsonb_build_object(
    'ok', true,
    'record_count', v_record_count,
    'unique_ruts', v_unique_ruts,
    'best_contacts', v_best_contacts,
    'contact_names', v_contact_names,
    'contact_name_coverage_pct', case when v_record_count > 0 then round((v_contact_names::numeric / v_record_count::numeric) * 100, 2) else null end,
    'contact_name_sources', v_contact_name_sources,
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
