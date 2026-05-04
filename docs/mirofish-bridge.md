# Puente MiroFish

## Objetivo

Este puente conecta `rut-intelligence` con una instancia local o remota de `MiroFish` para convertir el estado actual del cerebro comercial en un `scenario pack` y ejecutar una corrida multiagente por etapas:

1. genera dossier semilla desde este repo
2. lo sube a MiroFish
3. construye grafo
4. crea y prepara simulacion
5. corre la simulacion
6. genera reporte
7. persiste el resultado localmente

## Variables requeridas

En `rut-intelligence`:

```env
MIROFISH_API_URL=http://localhost:5001
```

Opcional si pones seguridad delante de MiroFish o si quieres correr sync por cron:

```env
MIROFISH_API_KEY=tu_token_opcional
MIROFISH_BRIDGE_SECRET=tu_secret_para_syncs
```

En la repo `MiroFish`, su backend debe estar levantado y con sus propias variables listas, al menos:

```env
LLM_API_KEY=...
ZEP_API_KEY=...
```

## Endpoints en este repo

Ruta nueva:

- `POST /api/scenarios/mirofish`
- `GET /api/scenarios/mirofish`

### 1. Iniciar corrida

```json
{
  "action": "start",
  "title": "Escenario Pyme Verde RM",
  "hypothesis": "Si concentramos prioridad en pymes verdes RM durante la tarde, sube la conversion sin disparar fatiga",
  "scope": "commercial_brain",
  "additional_context": "Evaluar riesgo de saturacion y deterioro tactico",
  "max_rounds": 24,
  "include_equifax_projection": true
}
```

Respuesta esperada:

- crea registro local en `mirofish_scenario_runs`
- deja la corrida en `graph_building`

### 2. Sincronizar una corrida

```json
{
  "action": "sync",
  "run_id": "uuid-de-la-corrida"
}
```

Cada `sync` intenta avanzar varios pasos si MiroFish ya tiene resultados listos.

### 3. Sincronizar todas las pendientes

```json
{
  "action": "sync_all",
  "limit": 10
}
```

Ideal para cron o job interno.

### 4. Listar corridas

```http
GET /api/scenarios/mirofish?section=list&limit=20
```

### 5. Obtener una corrida

```http
GET /api/scenarios/mirofish?section=run&run_id=uuid
```

## Persistencia local

Nueva tabla:

- `public.mirofish_scenario_runs`

Guarda:

- metadata de la corrida
- `scenario_pack_markdown`
- ids remotos de proyecto, simulacion y reporte
- estado remoto consolidado en `remote_status_payload`
- reporte final en markdown
- resumen del reporte

## Flujo operativo recomendado

1. Levantar `MiroFish` backend en `http://localhost:5001`
2. Ejecutar la migracion nueva en Supabase
3. Configurar `MIROFISH_API_URL` en este repo
4. Disparar `action=start`
5. Ejecutar `action=sync` o `action=sync_all` hasta que la corrida quede en `completed`

## Notas de diseño

- El puente no le manda millones de filas crudas a MiroFish.
- Convierte el estado cuantitativo actual en un dossier semilla mucho mas apto para simulacion.
- El score estadistico sigue viviendo aqui.
- MiroFish agrega una capa de proyeccion, stress test y ensayo de decisiones.
