# MiroFish en produccion

## Recomendacion cerrada

Separaria los despliegues asi:

1. `rut-intelligence` en Vercel
2. `MiroFish` backend en Render o Railway con volumen persistente
3. `Zep Cloud` como servicio administrado externo
4. `Vercel Cron` llamando a `/api/scenarios/mirofish/sync`

## Por que no conviene poner MiroFish en Vercel

MiroFish hoy depende de:

- backend Flask stateful
- archivos en disco para `backend/uploads`
- simulaciones largas
- reportes persistidos en filesystem
- procesos y tareas asincronas por etapas

Eso choca con el modelo serverless de Vercel para este caso. Las funciones de Vercel tienen filesystem de solo lectura y solo `/tmp` temporal, asi que no es un buen hogar para `backend/uploads` ni para el estado de simulacion. Ademas, aunque Vercel Functions soporta duraciones largas, siguen siendo invocaciones y no una app stateful con disco montado.

Fuentes:

- Render Persistent Disks: <https://render.com/docs/disks>
- Fly Volumes overview: <https://fly.io/docs/volumes/overview/>
- Railway Volumes: <https://docs.railway.com/guides/volumes>
- Vercel runtimes filesystem support: <https://vercel.com/docs/functions/runtimes>

## Opcion recomendada

### Opcion A: Render

Es la opcion que mas sentido me hace para este repo de MiroFish.

Pros:

- muy buen fit para Flask + Docker
- disco persistente simple de montar
- servicio siempre vivo
- operacion facil
- buen equilibrio entre tiempo de setup y estabilidad

Arquitectura:

- 1 web service para MiroFish
- 1 persistent disk montado en una ruta tipo `/app/backend/uploads`
- variables `LLM_API_KEY`, `ZEP_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL_NAME`

Cuando elegirla:

- si quieres salir rapido y estable
- si no quieres pelearte con networking ni maquinas

### Opcion B: Railway

Tambien sirve bien.

Pros:

- deploy muy rapido
- volumen persistente disponible
- experiencia simple para apps Docker

Contras:

- para cargas largas y crecimiento operativo grande, tiendo a preferir Render por previsibilidad

### Opcion C: Fly.io

La usaria solo si quieres mas control operativo.

Pros:

- maquinas dedicadas
- volumenes persistentes
- mas control fino

Contras:

- mas compleja
- los volumenes son locales a una maquina o region y requieren mas criterio operativo

## Mi decision practica

Si esto fuera mi stack, haria:

- `rut-intelligence` en Vercel
- `MiroFish` en Render
- `Zep` cloud
- Supabase como ya esta

## Flujo always-on

1. Un usuario crea una corrida desde `rut-intelligence`
2. Este repo sube el scenario pack a MiroFish
3. MiroFish corre sus etapas
4. Vercel Cron pega cada 5 minutos a `/api/scenarios/mirofish/sync`
5. El estado local se actualiza hasta terminar en `report_ready`

## Variables de entorno sugeridas

### En `rut-intelligence`

```env
MIROFISH_API_URL=https://tu-mirofish.onrender.com
MIROFISH_BRIDGE_SECRET=un-secret-compartido
```

Si quieres autenticar tambien por header:

```env
MIROFISH_API_KEY=token-opcional
```

### En Vercel

Configura el mismo `MIROFISH_BRIDGE_SECRET` para que el cron pueda entrar a:

- `/api/scenarios/mirofish/sync`

### En MiroFish

```env
LLM_API_KEY=...
LLM_BASE_URL=...
LLM_MODEL_NAME=...
ZEP_API_KEY=...
```

## Que desplegar de MiroFish

Para el puente actual, lo critico es el backend.

Puedes:

1. desplegar solo backend si este repo sera el frontend principal
2. desplegar backend + frontend de MiroFish si quieres tambien usar su UI nativa

Para este proyecto, yo priorizaria:

- backend obligatorio
- frontend opcional

## Siguiente paso sugerido

1. desplegar MiroFish backend en Render
2. apuntar `MIROFISH_API_URL`
3. aplicar migracion local de `mirofish_scenario_runs`
4. probar una corrida real
5. agregar una vista UI en `rut-intelligence` para lanzar y monitorear escenarios
