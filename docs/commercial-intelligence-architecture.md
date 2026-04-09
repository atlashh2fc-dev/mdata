# Inteligencia Comercial Viva

## Postura implementada

`rut-intelligence` pasa a ser el plano de activación y scoring comercial, no un espejo completo del CRM. La operación real sigue viviendo en `registro-intel`, pero este repo ahora recibe un mirror incremental del feedback mínimo necesario para aprender y priorizar:

- `contact_center_feedback`: fact table cruda y trazable por evento
- `persona_contact_points`: consolidación local de teléfonos/emails aprendidos
- `external_sync_runs`: trazabilidad de sincronización incremental
- `persona_scores`: snapshot accionable por RUT
- `commercial_intelligence_overview`: capa lista para dashboard, segmentación y serving

## Patrón de integración elegido

Se implementó una arquitectura híbrida:

1. `registro-intel` expone un dataset canónico incremental de feedback operativo.
2. Un job batch seguro en este repo consume ese dataset y hace upsert local.
3. El scoring y la recomendación comercial se calculan localmente en Supabase A.

Esto evita dos problemas:

- lecturas cross-project en tiempo real sobre tablas operativas pesadas
- duplicación ciega de todo el CRM cuando solo necesitamos hechos para aprendizaje comercial

## Contrato recomendado para Proyecto B

Exponer una vista estable tipo `crm_feedback_export_v1` con al menos:

- `id` o `external_event_id`
- `managed_at` o `fecha_gestion`
- `rutid`
- `telefono` o `contact_phone`
- `email` o `contact_email`
- `channel`
- `outcome`
- `outcome_subtype`
- `effective_contact`
- `mail_opened`
- `clicked`
- `interested`
- `callback_requested`
- `sale`
- `value_amount`
- `duration_seconds`
- `agent_name`
- `campaign_name`

Si el CRM ya tiene nombres distintos, el job local trae alias para mapearlos sin romper el contrato lógico.

## Decisión cerrada

La integración queda cerrada con patrón `pull incremental` desde `registro-intel` hacia este proyecto:

1. `registro-intel` publica la vista versionada `crm_feedback_export_v1`
2. este repo corre `ops:sync:crm-feedback`
3. el worker hace upsert en:
   - `contact_center_feedback`
   - `persona_contact_points`
   - `external_sync_runs`
4. el worker refresca `persona_scores` por lotes de RUTs afectados

Variables requeridas en este proyecto:

- `REGISTRO_INTEL_SUPABASE_URL`
- `REGISTRO_INTEL_SERVICE_ROLE_KEY`
- opcional `REGISTRO_INTEL_FEEDBACK_VIEW` si el nombre real no es `crm_feedback_export_v1`
- opcional `REGISTRO_INTEL_CURSOR_COLUMN` si el cursor no es `source_updated_at`
- opcional `REGISTRO_INTEL_SOURCE_ID_COLUMN` si el id no es `external_event_id`

## Flujo operativo

1. Correr migración [20260408090000_commercial_intelligence.sql](/Users/hh/Documents/Claude/Projects/Master%20Base/rut-intelligence/supabase/migrations/20260408090000_commercial_intelligence.sql)
2. Configurar variables `REGISTRO_INTEL_*`
3. Ejecutar `npm run ops:sync:crm-feedback`
4. Consultar:
   - `/api/commercial-intelligence`
   - `/api/commercial-intelligence?rut=<rut>`
   - `/api/commercial-intelligence?rut=<rut>&section=explanation`
   - módulo `/inteligencia-comercial`

## Evolución prevista

- reemplazar fórmulas híbridas por modelo supervisado manteniendo la misma tabla `persona_scores`
- mover clasificación de outcomes ambiguos a IA antes del upsert
- entrenar con etiquetas de `best_management` y outcomes de venta reales
- publicar scores a motores de activación, bots y campañas salientes
