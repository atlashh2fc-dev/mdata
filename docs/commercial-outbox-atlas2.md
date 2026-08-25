# Transporte comercial mdata → Atlas 2.0

La publicación de decisiones usa outbox durable y entrega al menos una vez. Atlas 2.0 debe deduplicar por `event_id`/`idempotency_key` antes de aplicar cualquier efecto.

## Operación

1. Aplicar la migración `20260825193436_commercial_outbox_delivery.sql`.
2. Generar decisiones y encolarlas:

   ```bash
   npm run ops:outbox:enqueue
   ```

3. Drenar hasta 250 eventos por worker:

   ```bash
   npm run ops:outbox:publish
   ```

En Vercel, `GET /api/commercial-outbox/run` exige `Authorization: Bearer $CRON_SECRET`. El cron `mode=generate` corre a las 12:15 UTC en días hábiles, después del pipeline Equifax de las 11:00 UTC, genera el feed una sola vez y drena un lote. `mode=drain` corre cada diez minutos y solo reclama/publica hasta 250 filas: no vuelve a ejecutar el cerebro comercial.

El publicador arma lotes de máximo 250 eventos y 1 MiB, firma `timestamp.body` con HMAC-SHA256 y solo marca una fila entregada si Atlas 2.0 devuelve ACK explícito:

```json
{
  "acknowledged": true,
  "accepted_event_ids": ["mdata:sha256..."]
}
```

Los `3xx` (redirect deshabilitado), errores `408`, `425`, `429`, `5xx`, red y ACK incompleto reintentan con backoff y jitter. Un `4xx` permanente va a `commercial_dead_letters`. Tras cinco fallas transitorias consecutivas, el circuito se abre cinco minutos y luego permite una prueba `half_open`.

## Contrato `intelligence.decision.v1`

El publicador llama exclusivamente `POST /api/integrations/v2/batches`, agrupa por `campaign_key` y envía solo prioridades de leads:

```json
{
  "campaign_key": "Nombre real de campaña",
  "items": [{
    "event_id": "mdata:sha256...",
    "event_type": "intelligence.decision.v1",
    "external_key": "000123456K",
    "occurred_at": "2026-08-25T12:00:00.000Z",
    "payload": {
      "priority_rank": 12,
      "priority_reason": "contactar",
      "decision_version": "sha256..."
    }
  }]
}
```

`campaign_key` proviene de `campaign_name` y `external_key` del RUT normalizado. Atlas 2.0 resuelve la campaña mediante `integration_campaign_mappings`; Bigdata no conoce UUID internos. Si falta campaña, RUT o prioridad, la decisión se registra como `unmapped` en la DLQ local. Portfolio y recomendaciones de campaña no se publican a este receptor.

La versión es un hash estable del contenido, por lo que recalcular exactamente la misma decisión no crea otra fila. Los headers son `x-atlas-source: bigdata`, `x-atlas-timestamp` UNIX, `idempotency-key` y `x-atlas-signature = HMAC_SHA256(secret, timestamp + '.' + rawBody)`.

## Contratos entrantes

Atlas 2.0 envía feedback operacional a `POST /api/commercial-intelligence/atlas-bridge` con `x-atlas-source: atlas2`, `x-atlas-timestamp` UNIX, `idempotency-key` y la misma firma HMAC de `timestamp.body`:

```json
{
  "schema_version": "1",
  "items": [{
    "event_id": "atlas2:operation:123",
    "event_type": "operation.feedback.v1",
    "occurred_at": "2026-08-25T12:00:00.000Z",
    "payload": {
      "campaign_key": "Equifax agosto",
      "external_key": "000123456K",
      "ended_at": "2026-08-25T12:04:00.000Z",
      "duration_seconds": 240,
      "status": "completed",
      "outcome": "interested",
      "reason": "Solicita propuesta",
      "next_action_at": "2026-08-26T15:00:00.000Z"
    }
  }]
}
```

El receptor usa exclusivamente `ATLAS2_FEEDBACK_BRIDGE_SECRET` para este contrato: el bearer/shared secret está deshabilitado y no se reutiliza `ATLAS_LEAD_BRIDGE_SECRET`. Exige RUT y campaña, rechaza IDs repetidos dentro del lote, persiste idempotentemente por `(external_source, external_event_id)`, responde `acknowledged:true` más `accepted_event_ids` y usa `refreshScores:false`. El scoring queda para el pipeline incremental posterior.

El bridge conserva además el payload legacy y `engagement.v1` para compatibilidad bajo `ATLAS_LEAD_BRIDGE_SECRET`. `engagement.v1` acepta un evento o un envelope `{ "events": [...] }` de hasta 250 eventos/1 MiB:

```json
{
  "schema_version": "1.0",
  "event_type": "engagement.v1",
  "event_id": "atlas2:message-1:clicked",
  "occurred_at": "2026-08-25T12:00:00.000Z",
  "source": { "system": "atlas2" },
  "engagement": {
    "kind": "clicked",
    "channel": "email",
    "campaign": {
      "sourceCampaignId": "campaign-1",
      "sourceCampaignName": "Equifax",
      "sourceCampaignType": "dicom_equifax"
    },
    "outreach": { "messageId": "message-1" },
    "lead": { "email": "persona@empresa.cl", "companyName": "Empresa SpA" }
  }
}
```

También exige `event_id` estable y responde `accepted_event_ids`.

## Checkpoints Registro Intel

Los sincronizadores guardan el checkpoint compuesto `(timestamp,id)` sin restarle el lookback. El lookback solo define el inicio de lectura; la paginación posterior es keyset y el checkpoint se publica al finalizar ingestón y scoring. Una corrida vacía o fallida nunca mueve el checkpoint hacia atrás.
