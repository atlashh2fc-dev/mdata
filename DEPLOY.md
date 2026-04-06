# RUT Intelligence Platform - Deployment y Operacion

## Estado real del repo

El proyecto ya incluye:

- Next.js App Router + TypeScript
- Auth con Supabase
- Buscador, perfil 360, dashboard, datasets, ingesta, segmentos y exportacion
- Integracion backend con Inception AI
- Schema inicial para producto y metadata operativa

Lo que faltaba para operar con datos reales era:

- cerrar el schema de produccion para cargas grandes
- dejar scripts reales de sincronizacion MySQL -> Postgres/Supabase
- endurecer consultas y segmentos
- alinear la documentacion con lo que existe en el repo

---

## 1. Variables de entorno

Copiar `.env.local.example` a `.env.local`:

```bash
cp .env.local.example .env.local
```

Variables requeridas:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_DB_URL=postgresql://postgres:password@db.xxxx.supabase.co:5432/postgres
DATABASE_URL=postgresql://postgres:password@db.xxxx.supabase.co:5432/postgres
INCEPTION_API_KEY=...
```

Para sincronizar desde MySQL local:

```bash
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_DATABASE=master_test
MYSQL_USER=root
MYSQL_PASSWORD=...
```

---

## 2. Migraciones de Supabase

Ruta recomendada:

```bash
supabase link --project-ref <project-ref>
supabase db push --include-all
```

Las migraciones reales quedaron versionadas en:

1. [supabase/migrations/20260406114600_initial_schema.sql](/Users/hh/Documents/Claude/Projects/Master%20Base/rut-intelligence/supabase/migrations/20260406114600_initial_schema.sql)
2. [supabase/migrations/20260406114700_analytics_and_audit.sql](/Users/hh/Documents/Claude/Projects/Master%20Base/rut-intelligence/supabase/migrations/20260406114700_analytics_and_audit.sql)
3. [supabase/migrations/20260406114800_production_upgrade.sql](/Users/hh/Documents/Claude/Projects/Master%20Base/rut-intelligence/supabase/migrations/20260406114800_production_upgrade.sql)

Los archivos base siguen quedando como referencia o fallback manual:

1. [supabase/schema.sql](/Users/hh/Documents/Claude/Projects/Master%20Base/rut-intelligence/supabase/schema.sql)
2. [supabase/migrations.sql](/Users/hh/Documents/Claude/Projects/Master%20Base/rut-intelligence/supabase/migrations.sql)
3. [supabase/production_upgrade.sql](/Users/hh/Documents/Claude/Projects/Master%20Base/rut-intelligence/supabase/production_upgrade.sql)

El upgrade agrega:

- `master_personas_current` como capa canonica
- metadata operativa (`source_versions`, `dataset_overview`)
- seeds de las fuentes reales
- indices y unicidad por `rutid` en tablas resumen 1:1

---

## 3. Estrategia correcta para cargar la base maestra

No usar navegador para la carga inicial. La ruta correcta para este tamano es:

1. leer desde MySQL local
2. exportar por tabla resumen a CSV canonico
3. hacer `COPY` a Postgres/Supabase
4. hacer merge/upsert por `rutid`
5. registrar metadata de version de fuente
6. refrescar stats materializadas

El repo ahora trae un script real para esto:

```bash
pnpm ops:sync:master
```

Modo inicial full refresh:

```bash
pnpm ops:sync:master:replace
```

Opciones:

```bash
node scripts/master-sync/sync-master-data.mjs --tables=master_personas,pernat_resumen
node scripts/master-sync/sync-master-data.mjs --mode=upsert
node scripts/master-sync/sync-master-data.mjs --mode=replace --export-dir=./tmp/master-sync
```

Tablas reales soportadas por el sync:

- `master_personas`
- `pernat_resumen`
- `autos_resumen`
- `empresa_resumen`
- `domicilio_resumen`
- `acumulado_resumen`

Notas:

- `replace` exige sincronizar el set completo canonico.
- `upsert` es la ruta para cargas incrementales futuras.
- el script intenta resolver alias como `RUT` / `RUTID` para normalizar a `rutid`.

---

## 4. Operacion incremental futura

Hay dos flujos distintos y complementarios:

### 4.1 Flujo bulk serio

Usar `scripts/master-sync/sync-master-data.mjs` cuando actualices tus tablas resumen desde MySQL local.

Esto es lo correcto para:

- millones de filas
- refrescos masivos
- sincronizacion operacional controlada

### 4.2 Flujo UI de ingesta

La pantalla de ingesta queda para:

- CSV/XLSX pequenos o medianos
- validacion/mapeo manual
- cargas incrementales puntuales
- trazabilidad de jobs

No es la ruta recomendada para la carga inicial de 9.5M+ filas.

---

## 5. Auth y primer usuario

Crear usuarios en:

- Supabase -> Authentication -> Users

Requisitos:

- Email provider habilitado
- dominio Vercel agregado en Authentication -> URL Configuration

---

## 6. Verificacion operativa

Antes de considerar el sistema listo:

1. login funcional contra Supabase Auth
2. `/dashboard` con `dashboard_stats`
3. `/buscar` devolviendo datos reales por `rutid`
4. `/segmentos` creando y ejecutando filtros reales
5. `/exportar` descargando CSV server-side
6. `/datasets` mostrando metadata y ultima carga

---

## 7. Stack recomendado

- Supabase Pro o superior para la base productiva
- Vercel para el frontend
- sincronizacion bulk desde una maquina con acceso a MySQL local
- cargas incrementales grandes via script, no via browser
