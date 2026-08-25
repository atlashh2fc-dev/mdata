# Integración comercial v2: seguridad, orden y operación

## Contrato compatible

El transporte HTTP conserva el batch actual. `schema_version: "2"` agrega a cada item:

- `event_id`, `event_type`, `event_source`, `subject`, `occurred_at` y `data_schema`.
- `tenant_id` (`geimser` por defecto), `entity_version` entero positivo.
- `correlation_id`, `causation_id` nullable, `external_key` y `payload`.

La idempotencia persistente es `(event_source,event_id)`. El orden es
`(tenant_id,subject,entity_version)`: un duplicado o una versión menor se ACKea
como `ignored` y nunca sobrescribe una versión mayor. Los contratos legacy,
`engagement.v1` y `operation.feedback.v1` con `schema_version: "1"` permanecen
aceptados durante la transición.

Atlas Lead puede enviar un único `engagement.event.v1` v2 mínimo. El servidor lo
transforma a un record interno antes de invocar `ingest_integration_feedback_v2`;
no necesita teléfono, país, web ni metadata legacy.

## Doorbell y fallback

- Bigdata genera decisiones y drena el outbox en la misma corrida de aplicación.
- Después de persistir feedback, el bridge intenta procesar inmediatamente hasta
  250 RUTs pendientes de Customer 360. Una falla de doorbell no revierte ni hace
  fallar el ACK ya persistido.
- No se realiza ninguna llamada de red remota desde una transacción PostgreSQL.
- Los crons de outbox y Customer 360 cada 10 minutos son el fallback durable.

## SLO y observabilidad

`/api/integration-health/run`, protegido por `CRON_SECRET`, corre cada hora:

- snapshot de backlog, edad de outbox/Customer 360, DLQ y conexiones;
- canary local de enqueue → claim → ACK sobre destino `synthetic_canary`;
- retención: snapshots 30 días y canaries/outbox sintético 90 días.

SLO inicial:

- outbox más antiguo: hasta 600 segundos;
- Customer 360 pendiente más antiguo: hasta 1.200 segundos;
- conexiones: hasta 80% de `max_connections`.

El canary es deliberadamente **local a la base y al worker**, no una certificación
E2E de Atlas2/Atlas Lead. `integration.canary.v1` se registra y ACKea sin crear
leads, correos, llamadas ni feedback comercial.

## Evidencia live del 25-08-2026

- Base: 41.900.461.203 bytes (~39 GiB), PostgreSQL 17.6.
- Conexiones: 7-8 de 60; no existe presión que justifique una réplica hoy.
- Mayores relaciones: `personas_master` ~9,7 GiB, `persona_scores` ~8,5 GiB,
  `bbrr_propiedades` ~4,5 GiB y `empresas_master` ~1,3 GiB.
- `empresas_master` tenía ~225.586 dead tuples. Se recomienda mantenimiento
  controlado fuera del horario activo, no `VACUUM FULL` automático.
- `REFRESH MATERIALIZED VIEW base_contact`: 28 llamadas, media ~105 s.
- `build_empresa_telefonos_socios_chunk`: media ~89 s.
- `refresh_empresas_master_crm`: media ~33,5 s.
- búsquedas `ILIKE` por `empresas_master.razon_social`: media ~8,6 s.
  `EXPLAIN` mostró `Parallel Seq Scan` y no existía índice para esa columna; por
  eso se incorpora únicamente el GIN trigram `empresas_master_razon_social_trgm_idx`.
- No se agregaron a ciegas PK/FK/índices sugeridos sólo como INFO. Las tablas de
  staging sin PK y los FK sin carga observada quedan para una medición posterior.

## Decisiones de capacidad

- **PGMQ:** no se incorpora. El outbox actual ya entrega claim con `SKIP LOCKED`,
  leases, retry, DLQ, idempotencia y circuit breaker. Evaluar PGMQ si el backlog
  sostenido supera 100.000 eventos, se requieren más de 8 workers concurrentes o
  el claim p95 supera 100 ms durante 7 días.
- **Partición:** no se incorpora. Evaluarla para feedback/outbox al superar 10
  millones de filas o 50 GiB por tabla, o si la retención/borrado consume más de
  20% del tiempo de mantenimiento.
- **Réplica de lectura:** no se incorpora con 7-8/60 conexiones. Evaluarla si la
  utilización supera 70% o el lag de consultas OLTP p95 supera 500 ms durante una
  semana por carga analítica comprobada.

Customer 360 sigue siendo una proyección reconstruible; no se convierte en una
cuarta fuente de verdad.

## Seguridad y coexistencia Forum

El baseline del Security Advisor era 59 ERROR: 49 tablas Bigdata/HH sin RLS y 10
views con semántica de definer. Las tablas Bigdata quedan server-only mediante
`service_role`; las siete tablas HH conservan lectura sólo para el operador ya
autorizado por la UI. Las views usan `security_invoker`.

Las tablas ITSM compartidas no forman parte de esos 59 ERROR. La función Forum
`create_tenant_api_key` se excluye expresamente: no se cambian permisos sin una
prueba autenticada del consumidor ITSM.

## Pruebas y recuperación

`supabase/tests/integration_contract_v2.sql` cubre:

- duplicado, out-of-order y prevención de overwrite stale;
- destino caído/retry hasta DLQ y replay;
- recuperación de lease después de worker crash;
- hard cap de 250 bajo 10x carga;
- canary sin efecto comercial y RLS para `anon`.

Replay controlado:

```sql
select public.replay_commercial_dead_letter('<outbox_uuid>'::uuid);
```

Sólo `service_role` puede ejecutar esta RPC.
