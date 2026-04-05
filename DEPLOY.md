# RUT Intelligence Platform — Guía de Deployment

## Prerequisitos

- Node.js 18+
- Cuenta Supabase (https://supabase.com)
- API Key de Inception AI

---

## 1. Configuración Supabase

### 1.1 Crear proyecto
1. Ir a https://app.supabase.com → Nuevo proyecto
2. Guardar URL y API keys (anon + service_role)

### 1.2 Ejecutar schema
En Supabase SQL Editor, ejecutar en orden:
1. `supabase/schema.sql`
2. `supabase/migrations.sql`

### 1.3 Habilitar autenticación
- Authentication → Settings → Email confirmations: OFF (para ambiente interno)

---

## 2. Variables de entorno

Copiar `.env.local.example` a `.env.local` y configurar:

```bash
cp .env.local.example .env.local
```

Llenar:
```
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
INCEPTION_API_KEY=sk-...
```

---

## 3. Migración desde MySQL

Para migrar los datos de `master_test` a Supabase, hay dos opciones:

### Opción A: Via script Node.js
```bash
# Instalar driver MySQL
npm install mysql2

# Ejecutar script de migración
node scripts/migrate-mysql.js
```

### Opción B: Via CSV export + ingesta
1. Exportar cada tabla como CSV desde MySQL:
   ```sql
   SELECT * FROM master_personas INTO OUTFILE '/tmp/master_personas.csv'
   FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"' LINES TERMINATED BY '\n';
   ```
2. Usar el módulo de Ingesta de la plataforma para cargar cada CSV
3. Configurar mappings correspondientes

---

## 4. Instalación y ejecución

```bash
# Instalar dependencias
npm install

# Desarrollo
npm run dev

# Producción
npm run build
npm run start
```

---

## 5. Primer usuario

En Supabase Dashboard → Authentication → Users → Invite user

O via SQL:
```sql
-- Esto es solo para testing, usar el dashboard en producción
SELECT auth.create_user(
  '{"email": "admin@empresa.cl", "password": "TuPassword123!", "email_confirm": true}'::jsonb
);
```

---

## 6. Refresh de estadísticas

Las estadísticas del dashboard están en una vista materializada.
Refrescar manualmente desde el dashboard o configurar un cron:

```sql
SELECT refresh_all_stats();
```

---

## 7. Performance con 9.5M registros

- Todos los índices están creados en el schema
- Las consultas usan `LIMIT` + `OFFSET` para paginación
- La vista `master_personas_view` usa LEFT JOINs optimizados
- `dashboard_stats` es una vista materializada (no recalcula en cada request)
- Supabase Postgres soporta millones de filas nativamente

---

## Stack de producción recomendado

- Supabase Pro (o Self-hosted en VPS con Postgres 16)
- Vercel o Railway para Next.js
- Vercel Edge para el middleware de auth
