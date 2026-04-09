# Commercial Brain MVP

## Rol del proyecto

`rut-intelligence` pasa a operar como el cerebro analítico del contact center:

- aprende desde el histórico masivo del feedback operativo
- detecta deterioro táctico antes de que se pierda el bloque del día
- prioriza leads, segmentos y campañas con scoring dinámico
- entrega al CRM solo salidas livianas y accionables

El CRM sigue siendo el sistema de ejecución. La inteligencia pesada vive aquí.

## Loop estratégico implementado

### 1. Capa de investigación y enriquecimiento

- usa Inception para leer el estado táctico y generar diagnóstico ejecutivo
- interpreta anomalías, resume causas probables y sugiere acciones concretas
- deja espacio para incorporar señales externas y contexto territorial por comuna/zona/cohorte sin recargar el CRM

### 2. Capa predictiva

- reutiliza `persona_scores` como base de contacto y conversión
- recalcula prioridad dinámica ponderando:
  - probabilidad de contacto
  - probabilidad de conversión
  - afinidad operativa
  - fatiga reciente
  - mejor ventana horaria
- mezcla scoring histórico por persona con señal táctica intradía por campaña

### 3. Capa de optimización táctica

- detecta campañas activas usando el feedback reciente
- construye baseline por campaña y hora usando el histórico local
- aplica la regla crítica:
  - si una campaña acumula 3 horas consecutivas bajo baseline, la marca como deterioro crítico
- diagnostica causa probable:
  - fatiga de base
  - ventana subóptima
  - deterioro de canal
  - quiebre de conversión
  - dilución del mix
- propone acción concreta:
  - cambiar lógica de priorización
  - redistribuir segmentos
  - bajar o subir intensidad
  - mover ventana
  - recalcular ranking

## Salidas del motor

El endpoint `GET /api/commercial-intelligence?section=brain` entrega:

- snapshot de salud operativa
- campañas en vigilancia/riesgo/crítica
- recomendaciones tácticas priorizadas
- segmentos fuertes y débiles
- ventanas óptimas
- priorización dinámica de leads
- resumen ejecutivo generado por IA cuando Inception está disponible

El endpoint `GET /api/commercial-intelligence?section=actions` entrega el feed operacional limpio para CRM:

- `portfolio_status`
- `campaign_instructions`
- `lead_instructions`
- `recommendations`
- `executive_summary`

Ese endpoint acepta autenticación máquina-a-máquina con `CRM_FEEDBACK_INGEST_TOKEN`.

## Loop bidireccional con registro-intel

### Lo que ya queda resuelto aquí

- `npm run ops:sync:crm-feedback`
  - trae feedback incremental desde `registro-intel`
- `npm run ops:push:crm-actions`
  - publica acciones del cerebro hacia `registro-intel`
- `npm run ops:sync:crm-loop`
  - ejecuta el ciclo completo feedback -> aprendizaje -> decisiones

### Lo que debe existir en registro-intel

- una vista incremental `crm_feedback_export_v1`
- un endpoint receptor autenticado como:
  - `POST /api/intelligence-actions/ingest`
- lógica de ejecución que tome:
  - `campaign_instructions`
  - `lead_instructions`
  - `recommendations`
  y las transforme en priorización real, secuencias, colas o alertas operativas

## Vista ejecutiva

La pantalla `/inteligencia-comercial` ya funciona como centro de supervisión operativa:

- salud general del portafolio
- campañas activas con baseline vs actual
- causas probables de deterioro
- acciones sugeridas por el motor
- segmentos fuertes y débiles
- ventanas óptimas
- ranking dinámico listo para servir al CRM

## Próximas evoluciones recomendadas

- persistir snapshots tácticos por bloque horario para backtesting
- modelar afinidad agente-campaña-estrategia
- incorporar variables externas versionadas por comuna/zona/producto
- publicar feed operacional directo hacia colas y secuencias del CRM
