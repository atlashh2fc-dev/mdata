# RUT Intelligence

Plataforma de inteligencia comercial y enriquecimiento de datos para operar sobre una base consolidada de RUTs en Chile. La solucion combina busqueda 360, segmentacion, scoring, armado de bases, feedback CRM, modelos Equifax, analisis con IA y sincronizacion operativa con Supabase/Postgres.

El objetivo no es solo consultar datos: es transformar fuentes dispersas en universos accionables para ventas, contact center, analisis comercial y activacion hacia CRM.

## Que puede hacer la solucion

### 1. Dashboard ejecutivo

- Muestra KPIs generales de la base consolidada.
- Resume cobertura de datos por dimension: contacto, domicilio, autos, empresa, bienes raices y score.
- Visualiza distribucion de score patrimonial.
- Muestra estadisticas por region.
- Incluye feed de actividad reciente.
- Permite refrescar estadisticas materializadas desde la aplicacion.

### 2. Buscador / Perfil 360

- Busca personas o empresas por RUT.
- Permite busqueda por nombre, email o empresa.
- Aplica filtros avanzados por region, autos, empresa, bienes raices y rango de score.
- Muestra resultados paginados y ordenables.
- Abre ficha individual con informacion consolidada del RUT.
- Integra un panel de inteligencia comercial cuando existe score disponible.

### 3. Perfil comercial accionable

Para cada RUT con datos comerciales, la plataforma puede mostrar:

- contactability score
- purchase propensity score
- priority score
- siguiente mejor accion
- canal sugerido
- mejor horario de contacto
- mejor telefono y mejor email disponibles
- senales relevantes de feedback operacional
- historial resumido de gestiones
- puntos de contacto aprendidos desde CRM y datasets externos

### 4. Explorador de universos

- Explora volumenes en tiempo real sobre la matriz consolidada.
- Separa universos por tipo de entidad:
  - personas naturales
  - personas juridicas
  - indeterminados
  - RUTs recuperables
  - basura/no utilizables
- Cruza dimensiones como nombre, email, telefono, domicilio, autos, bienes raices y empresa.
- Permite incluir o excluir dimensiones para estimar tamanos de universos antes de exportar o activar campanas.

### 5. Segmentador visual

- Crea segmentos guardados con reglas visuales.
- Soporta operadores:
  - igual / distinto
  - mayor / menor
  - mayor o igual / menor o igual
  - entre
  - en lista
  - esta vacio / no esta vacio
  - contiene
- Permite ejecutar segmentos sobre la base completa.
- Muestra una muestra paginada de resultados del segmento.
- Permite eliminar segmentos guardados.
- Campos disponibles incluyen region, comuna, autos, empresa, bienes raices, total de avaluos, score patrimonial y cobertura.

### 6. Poblar Base

Modulo para cargar una lista propia y devolverla enriquecida.

Puede trabajar con:

- RUT directo
- razon social de empresa
- nombre de persona
- archivos CSV
- archivos XLSX
- columnas sin encabezado detectadas automaticamente

Capacidades principales:

- deteccion automatica de columna RUT, empresa o persona
- validacion de RUT chileno
- match contra la base consolidada
- seleccion de campos a enriquecer
- enriquecimiento de contactos faltantes via busqueda web cuando esta configurado
- incorporacion de datos CRM cuando existen
- exportacion en CSV, XLSX o JSON
- columnas comerciales para CRM: historial, ultima gestion, resultado, prioridad, canal sugerido, mejor hora, mejor telefono/email y ejecutivo asociado

### 7. Armado BDD Equifax

Modulo especializado para generar bases comerciales orientadas a productos Equifax.

Puede:

- cargar catalogo de productos
- importar ventas historicas desde archivos
- analizar descripciones o PDFs de productos
- previsualizar escenarios de leads
- generar bases priorizadas
- clasificar leads por temperatura verde, amarilla o roja
- filtrar por region, volumen, telefonos, emails y clientes existentes
- calcular score de fit Equifax, probabilidad de contacto, interes y compra
- exportar leads para contact center o CRM
- empujar runs seleccionados hacia CRM
- ejecutar pipeline de scoring en modo safe, dry-run o force

### 8. Inteligencia Comercial Viva

La plataforma aprende desde feedback operacional del CRM `registro-intel`.

Capacidades:

- sincronizacion incremental de gestiones, ventas, callbacks, aperturas, clicks y rechazos
- consolidacion local de puntos de contacto
- actualizacion de scores por RUT afectado
- calculo de prioridad comercial y proxima accion
- generacion de feeds de accion hacia CRM
- puente Atlas Lead Engine para recibir o publicar acciones accionables

Documentacion especifica: [docs/commercial-intelligence-architecture.md](docs/commercial-intelligence-architecture.md)

### 9. Cerebro de Negocios con IA

Integra Inception AI para analisis estructurado.

Tipos de analisis soportados:

- enrichment: inferencias sobre perfiles
- classification: clasificacion de perfiles en segmentos de negocio
- scoring: scoring patrimonial, empresarial y de contactabilidad
- dataset: analisis de calidad y valor de datasets
- campaign_strategy: recomendaciones de estrategia comercial

Los resultados se registran en logs de analisis cuando hay usuario autenticado.

### 10. Ingesta y datasets

- Carga datasets pequenos o medianos desde la UI.
- Permite previsualizar fuentes y exportarlas.
- Mantiene metadata operativa de fuentes.
- Registra jobs de ingesta y actividad.
- Complementa, pero no reemplaza, los scripts bulk para cargas masivas.

Para cargas iniciales o masivas, usar los scripts operativos descritos en [DEPLOY.md](DEPLOY.md).

### 11. Exportacion de bases

- Exporta resultados y segmentos a CSV desde backend.
- Permite preparar bases accionables con campos enriquecidos.
- Soporta flujos de exportacion para contact center, CRM y auditoria.
- Incluye exports Equifax versionados en `exports/equifax`.

### 12. Logs y trazabilidad

- Muestra actividad del sistema.
- Registra analisis IA.
- Registra corridas de sincronizacion externas.
- Registra jobs de ingesta.
- Mantiene metadata de versiones de fuentes y refrescos.

### 13. Puente MiroFish

Integra escenarios comerciales con MiroFish para simulacion y stress testing.

Puede:

- generar un dossier semilla desde el cerebro comercial
- iniciar una corrida multiagente en MiroFish
- sincronizar avances de corridas
- persistir reportes finales localmente
- evaluar hipotesis comerciales sin mover millones de filas crudas

Documentacion especifica: [docs/mirofish-bridge.md](docs/mirofish-bridge.md)

## Fuentes de datos soportadas

La solucion esta preparada para consolidar y operar sobre:

- master de personas
- PERNAT/personas naturales
- autos
- empresas
- domicilios
- bienes raices y avaluos
- telefonos desde GeoBPO/Access u otras fuentes externas
- Padron 2024
- automoviles 2025
- feedback de contact center
- catalogo y ventas Equifax
- fuentes cargadas por UI
- datos aprendidos por enriquecimiento web

## Stack tecnico

- Next.js 15 App Router
- React 18
- TypeScript
- Tailwind CSS
- Supabase Auth
- Supabase/Postgres
- Postgres COPY para cargas grandes
- MySQL como origen operacional opcional
- Inception AI para analisis LLM
- Brave/DuckDuckGo/Bing para enriquecimiento web segun configuracion
- Vercel para despliegue

## Modulos principales

| Ruta | Modulo |
| --- | --- |
| `/dashboard` | KPIs, graficos y actividad |
| `/buscar` | Busqueda y perfil 360 |
| `/datasets` | Catalogo de fuentes |
| `/ingesta` | Carga manual de datasets |
| `/inteligencia-comercial` | Motor comercial y acciones |
| `/ai` | Cerebro de Negocios |
| `/universos` | Explorador de universos |
| `/segmentos` | Segmentador visual |
| `/poblar` | Enriquecimiento de bases cargadas |
| `/equifax-bdd` | Armado BDD Equifax |
| `/exportar` | Exportacion de bases |
| `/logs` | Actividad y trazabilidad |

## APIs principales

| Endpoint | Uso |
| --- | --- |
| `GET /api/dashboard` | KPIs y estadisticas |
| `GET /api/personas` | Busqueda por RUT o filtros |
| `GET/POST/DELETE /api/segmentos` | CRUD y ejecucion de segmentos |
| `GET /api/universos` | Matriz de universos |
| `POST /api/base-builder` | Analisis y enriquecimiento de bases |
| `POST /api/base-builder/web-enrichment` | Enriquecimiento web de contactos |
| `GET/POST /api/commercial-intelligence` | Scores, explicaciones y acciones comerciales |
| `POST /api/commercial-intelligence/atlas-bridge` | Integracion Atlas Lead Engine |
| `POST /api/ai` | Analisis IA estructurado |
| `GET/POST /api/equifax/catalog` | Catalogo Equifax |
| `POST /api/equifax/import-sales` | Importacion de ventas |
| `GET/POST /api/equifax/leads` | Preview, generacion y push CRM de leads |
| `GET/POST /api/equifax/pipeline` | Control del pipeline de scoring |
| `GET/POST /api/scenarios/mirofish` | Corridas de simulacion MiroFish |

## Scripts operativos

### Desarrollo

```bash
npm run dev
npm run build
npm run type-check
```

### Master data y cargas bulk

```bash
npm run ops:sync:master
npm run ops:sync:master:replace
npm run ops:padron2024:import
npm run ops:personas-master:rebuild-apply
npm run ops:import:bbrr
npm run ops:bbrr:rollup
npm run ops:import:geobpo
npm run ops:refresh:dashboard
```

### Equifax

```bash
npm run ops:equifax:import:sales
npm run ops:equifax:refresh:scores
npm run ops:equifax:refresh:universe
npm run ops:equifax:refresh:master-pyme
npm run ops:equifax:train:logit
npm run ops:equifax:bootstrap:model
npm run ops:equifax:pipeline
npm run ops:equifax:generate:green
npm run ops:equifax:crm:feed
npm run ops:equifax:crm:push
```

### CRM y acciones

```bash
npm run ops:sync:crm-feedback
npm run ops:apply:crm-contract
npm run ops:atlas:backfill-company-matches
npm run ops:push:crm-actions
npm run ops:sync:crm-loop
```

## Variables de entorno

Crear `.env.local` desde el ejemplo:

```bash
cp .env.local.example .env.local
```

Variables clave:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DB_URL` o variables `SUPABASE_DB_*`
- `DATABASE_URL`
- `MYSQL_*` para sincronizacion desde MySQL local
- `INCEPTION_API_KEY` para IA
- `BRAVE_SEARCH_API_KEY` para enriquecimiento web
- `REGISTRO_INTEL_*` para feedback CRM
- `CRM_FEEDBACK_INGEST_TOKEN`
- `ATLAS_LEAD_BRIDGE_SECRET`
- `MIROFISH_API_URL` y opcional `MIROFISH_API_KEY`
- `NEXT_PUBLIC_APP_URL`
- `APP_SECRET`

Ver el detalle completo en [.env.local.example](.env.local.example).

## Base de datos

Las migraciones viven en `supabase/migrations`.

Incluyen:

- schema inicial de producto
- auditoria y analytics
- vistas canonicas sobre `personas_master`
- estadisticas de universos
- busqueda por nombre y RUT
- matching de empresas
- inteligencia comercial
- scoring y pipeline Equifax
- bienes raices
- datasets de ejecutivos y automoviles
- puente MiroFish
- blacklist/contactabilidad

Para operacion y despliegue, revisar [DEPLOY.md](DEPLOY.md).

## Flujo recomendado de operacion

1. Configurar Supabase, Auth y variables de entorno.
2. Aplicar migraciones.
3. Cargar o sincronizar master data con scripts bulk.
4. Refrescar vistas y estadisticas.
5. Validar login, dashboard, busqueda y segmentos.
6. Sincronizar feedback CRM si aplica.
7. Generar scores comerciales y/o Equifax.
8. Activar bases hacia exportacion, CRM o escenarios MiroFish.

## Notas importantes

- La UI de ingesta esta pensada para cargas pequenas o medianas.
- Las cargas masivas deben ejecutarse con scripts y Postgres COPY.
- El service role de Supabase solo debe usarse en backend/scripts.
- Los flujos Equifax y CRM requieren variables productivas correctas.
- El puente MiroFish no envia bases crudas completas; envia dossiers y contexto resumido.

