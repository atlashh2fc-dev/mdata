-- La lista negra se puede consultar por número sin recorrer todo el feedback.
--
-- `contact_blacklist` arma dos ramas (teléfonos y correos) sobre el mismo CTE
-- `feedback_signals`. Al usarse dos veces, Postgres lo materializaba: cualquier
-- consulta, aunque pidiera un solo número, calculaba `signal_text` (con el
-- raw_payload entero) para las ~77 mil filas de contact_center_feedback. Unos
-- 2 s por consulta, y creciendo.
--
-- Con NOT MATERIALIZED el filtro por normalized_value (o por rutid) baja a cada
-- rama y usa idx_feedback_phone / idx_feedback_email / idx_feedback_rutid:
-- 2 ms para la ficha por RUT que pide Atlas 2.0. El recuento completo también
-- mejora (6,2 s → 3,0 s medido el 25-09-2026) y devuelve las mismas filas.
--
-- Mismas columnas y misma lógica que la vista en producción; solo cambia el
-- plan. Se repite security_invoker porque CREATE OR REPLACE VIEW reemplaza las
-- opciones de la vista. Los permisos se conservan.

create or replace view public.contact_blacklist
with (security_invoker = true)
as
 WITH feedback_signals AS NOT MATERIALIZED (
         SELECT f.id,
            f.external_source,
            f.external_event_id,
            f.external_record_type,
            f.rutid,
            f.matched_rutid,
            f.match_method,
            f.contact_phone,
            f.phone_normalized,
            f.contact_email,
            f.email_normalized,
            f.channel,
            f.managed_at,
            f.outcome,
            f.outcome_subtype,
            f.outcome_reason,
            f.direction,
            f.duration_seconds,
            f.talk_seconds,
            f.wait_seconds,
            f.agent_id,
            f.agent_name,
            f.campaign_id,
            f.campaign_name,
            f.opened_at,
            f.clicked_at,
            f.callback_at,
            f.responded_at,
            f.sold_at,
            f.value_amount,
            f.mail_opened,
            f.clicked,
            f.callback_requested,
            f.interested,
            f.contacted,
            f.effective_contact,
            f.sale,
            f.is_best_management,
            f.raw_payload,
            f.metadata,
            f.created_at,
            f.updated_at,
            lower(concat_ws(' '::text, f.outcome::text, f.outcome_subtype, f.outcome_reason, f.metadata::text, f.raw_payload::text)) AS signal_text
           FROM contact_center_feedback f
        ), blacklist_events AS (
         SELECT 'phone'::text AS contact_type,
            f.contact_phone AS contact_value,
            f.phone_normalized AS normalized_value,
            'telefono_erroneo_crm'::text AS blacklist_reason,
                CASE
                    WHEN f.external_source = 'vocal'::text THEN 'Vocal'::text
                    ELSE 'CRM'::text
                END AS source_label,
            f.external_source,
            f.external_event_id,
            f.rutid,
            f.matched_rutid,
            f.channel::text AS channel,
            f.outcome::text AS outcome,
            f.outcome_subtype,
            f.outcome_reason,
            f.agent_name,
            f.campaign_name,
            f.managed_at,
            f.created_at,
            f.updated_at,
            f.metadata
           FROM feedback_signals f
          WHERE f.phone_normalized IS NOT NULL AND (COALESCE(f.external_source, ''::text) <> ALL (ARRAY['atlas_lead_engine'::text, 'atlas_lead_engine_bridge'::text])) AND (f.signal_text ~ '(n[uú]mero|numero|tel[eé]fono|telefono|fono|phone).*(equivocado|err[oó]neo|erroneo|incorrecto|inv[aá]lido|invalido|no existe|no corresponde|fuera de servicio|sin servicio|wrong|invalid)'::text OR f.signal_text ~ '(equivocado|err[oó]neo|erroneo|incorrecto|inv[aá]lido|invalido|no existe|no corresponde|fuera de servicio|sin servicio|wrong|invalid).*(n[uú]mero|numero|tel[eé]fono|telefono|fono|phone)'::text)
        UNION ALL
         SELECT 'email'::text AS contact_type,
            f.contact_email AS contact_value,
            f.email_normalized AS normalized_value,
            'email_rebotado_atlas'::text AS blacklist_reason,
            'Atlas Lead'::text AS source_label,
            f.external_source,
            f.external_event_id,
            f.rutid,
            f.matched_rutid,
            f.channel::text AS channel,
            f.outcome::text AS outcome,
            f.outcome_subtype,
            f.outcome_reason,
            f.agent_name,
            f.campaign_name,
            f.managed_at,
            f.created_at,
            f.updated_at,
            f.metadata
           FROM feedback_signals f
          WHERE f.email_normalized IS NOT NULL AND ((f.external_source = ANY (ARRAY['atlas_lead_engine'::text, 'atlas_lead_engine_bridge'::text])) OR (f.metadata ->> 'bridge_source'::text) = 'atlas_lead_engine'::text) AND (f.outcome = 'bounced'::feedback_outcome OR f.signal_text ~ '(bounce|bounced|rebote|rebotado|rebotad[ao]|undeliverable|delivery failed)'::text)
        ), ranked_events AS (
         SELECT be.contact_type,
            be.contact_value,
            be.normalized_value,
            be.blacklist_reason,
            be.source_label,
            be.external_source,
            be.external_event_id,
            be.rutid,
            be.matched_rutid,
            be.channel,
            be.outcome,
            be.outcome_subtype,
            be.outcome_reason,
            be.agent_name,
            be.campaign_name,
            be.managed_at,
            be.created_at,
            be.updated_at,
            be.metadata,
            row_number() OVER (PARTITION BY be.contact_type, be.normalized_value ORDER BY be.managed_at DESC, be.updated_at DESC, be.external_event_id DESC) AS event_rank,
            count(*) OVER (PARTITION BY be.contact_type, be.normalized_value) AS event_count,
            min(be.managed_at) OVER (PARTITION BY be.contact_type, be.normalized_value) AS first_seen_at,
            max(be.managed_at) OVER (PARTITION BY be.contact_type, be.normalized_value) AS last_seen_at
           FROM blacklist_events be
        )
 SELECT md5(concat_ws('|'::text, contact_type, normalized_value)) AS blacklist_key,
    contact_type,
    contact_value,
    normalized_value,
    blacklist_reason,
    source_label,
    external_source,
    external_event_id AS latest_external_event_id,
    COALESCE(matched_rutid, rutid) AS rutid,
    matched_rutid,
    channel,
    outcome,
    outcome_subtype,
    outcome_reason,
    agent_name,
    campaign_name,
    event_count,
    first_seen_at,
    last_seen_at,
    managed_at AS latest_event_at,
    metadata
   FROM ranked_events
  WHERE event_rank = 1;
