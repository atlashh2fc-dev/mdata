# Customer 360 incremental

`public.customer_360_companies` es la proyección comercial canónica de Bigdata: una fila por RUT normalizado, lista para que APIs, segmentadores y operaciones comerciales consulten una sola tabla.

## Fuentes consolidadas

- `empresas_master`: identidad, actividad, ubicación, tamaño, contactos preferentes y señales CRM.
- Universo de `empresas_comercial_unificada`: se reproduce desde su fuente indexada `empresas_ventas_tendencia`, evitando recalcular la vista pesada.
- `contact_center_feedback`: agregados y última interacción recibida desde Atlas2, Atlas Lead y Registro Intel.
- `commercial_outbox`: última decisión `intelligence.decision.v1`, prioridad y recomendación publicada a Atlas2.

No hay FDW, joins remotos ni `REFRESH MATERIALIZED VIEW`. Los joins ocurren dentro del mismo PostgreSQL y solo para RUTs acotados por lote.

## Flujo incremental

1. Los triggers de `contact_center_feedback` y `commercial_outbox` solo encolan el RUT en `customer_360_pending`; no hacen agregaciones dentro de la ingestión.
2. `process_customer_360_pending` reclama hasta 1.000 RUTs con `FOR UPDATE SKIP LOCKED`, lease y backoff.
3. `refresh_customer_360_rutids` recalcula únicamente esos RUTs y hace `UPSERT` idempotente.
4. `reconcile_customer_360_events` recorre feedback y outbox mediante checkpoints `(updated_at,id)` monotónicos para reparar eventos que no hayan quedado en cola.
5. `reconcile_customer_360_base` recorre `empresas_master` y `empresas_ventas_tendencia` por keyset de RUT. El checkpoint global es `(cycle_count,cursor_id)`: cuando termina una vuelta incrementa el ciclo y comienza la siguiente, sin un refresh completo.

## Operación

Vercel llama `GET /api/customer-360/run` con `Authorization: Bearer $CRON_SECRET`:

- `mode=micro`, cada 10 minutos: pending 500, eventos 1.000 por fuente y base 1.000 por fuente.
- `mode=daily`, 18:15 UTC: reconciliación adicional acotada a 5.000 filas por fuente, después del refresh CRM de `empresas_master`.

Los límites del micro-batch pueden reducirse mediante:

```env
CUSTOMER_360_WORKER=mdata-customer-360
CUSTOMER_360_PENDING_BATCH_SIZE=500
CUSTOMER_360_EVENT_BATCH_SIZE=1000
CUSTOMER_360_MICRO_BASE_BATCH_SIZE=1000
```

El servidor aplica máximos duros aunque una variable de entorno intente superarlos.

## Seguridad y consumo

- `customer_360_companies`: lectura para `authenticated` y `service_role`; sin acceso `anon`.
- `customer_360_pending` y `customer_360_checkpoints`: solo `service_role`.
- RLS está habilitado en las tres tablas.
- Las funciones privilegiadas usan `search_path=''`, relaciones calificadas y ejecución revocada a `public`, `anon` y `authenticated`.

Consulta recomendada:

```sql
select *
from public.customer_360_companies
where rutid = public.normalize_feedback_rutid('76.123.456-7');
```

## Verificación

`supabase/tests/customer_360_incremental.sql` valida trigger, cola, UPSERT, agregados de feedback, decisión comercial, idempotencia, reconciliadores y bloqueo para `anon` dentro de una transacción que termina en `ROLLBACK`.
