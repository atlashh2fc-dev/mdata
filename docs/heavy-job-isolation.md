# Aislamiento de cargas pesadas de Bigdata

## Objetivo

Evitar que los refrescos de Bigdata compitan entre sí o presionen la base
compartida con Forum. El control es global para las tres cargas registradas:

- `base_contact_pipeline`
- `equifax_bdd_rebuild`
- `bbrr_rollup`

El lock es de sesión. `claim`, trabajo y `finish` deben ejecutarse en el mismo
`pg.Client` persistente; no se debe reemplazar esta secuencia por llamadas RPC o
PostgREST independientes.

## Garantías

- Concurrencia global 1 mediante advisory lock no bloqueante.
- Ventana por defecto `20:00-07:00 America/Santiago`.
- `lock_timeout` de 5 segundos para no esperar locks operacionales.
- `statement_timeout` de 135 segundos para Base Contact y 9 minutos para los
  runners persistentes.
- Presupuesto de 270 segundos para la ruta Vercel, bajo su `maxDuration=300`.
- Kill switch en base y en ambiente.
- Telemetría `running/succeeded/failed/skipped` con duración y motivo.
- Comprobación del kill switch entre lotes/pasos.

## Única agenda de Base Contact

La ingesta externa sigue entrando por `/api/base-contact/refresh`, a las
`05:15 UTC` (01:15 o 02:15 en Santiago según horario estacional). La migración
retira los cron DB `refresh-base-contact-matview` y
`refresh-empresas-master-crm`, porque duplicaban el trabajo sin traer la fuente
externa.

La migración y el despliegue deben promoverse en la misma ventana controlada.
No se debe dejar la aplicación nueva apuntando a una base sin `mdata_ops`.

## Kill switch

Detener nuevos trabajos de un job:

```sql
update mdata_ops.heavy_job_control
set kill_switch = true,
    updated_at = now(),
    updated_by = 'operacion'
where job_name = 'base_contact_pipeline';
```

Reactivar:

```sql
update mdata_ops.heavy_job_control
set kill_switch = false,
    updated_at = now(),
    updated_by = 'operacion'
where job_name = 'base_contact_pipeline';
```

El kill switch de emergencia del runner es `MDATA_HEAVY_JOBS_DISABLED=1`. No
cancela una sentencia SQL que ya está ejecutándose; el timeout la limita y el
runner consulta nuevamente el switch antes del paso siguiente.

## Observación

```sql
select job_name, status, reason, started_at, completed_at, elapsed_ms, error_message
from mdata_ops.heavy_job_runs
order by started_at desc
limit 50;
```

```sql
select job_name, enabled, kill_switch, allowed_start, allowed_end,
       timezone_name, statement_timeout_ms, lock_timeout_ms
from mdata_ops.heavy_job_control
order by job_name;
```

## Cache BBRR

`get_bbrr_dashboard_usage_stats()` ya no recorre cerca de cinco millones de
filas por cada dashboard. Lee una fila privada y el runner BBRR actualiza el
cache al terminar. El seed de la migración hace un único scan pesado y por eso
la migración debe aplicarse dentro de la ventana nocturna.

## Secuencia de promoción

1. Build y tests de aplicación.
2. Aplicar la migración en ventana nocturna y ejecutar
   `supabase/tests/heavy_job_isolation.sql`.
3. Desplegar la aplicación con el cron nocturno.
4. Confirmar que no quedan los dos cron DB antiguos.
5. Ejecutar un canary forzado controlado y comprobar `heavy_job_runs`.
6. Revisar advisors y métricas de CPU, IO, conexiones y locks.

No se ejecuta el rebuild Equifax completo como canary: contiene `truncate` y
debe reservarse para una reconstrucción operacional autorizada.
