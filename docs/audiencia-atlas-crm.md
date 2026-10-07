# Audiencias de correo para Atlas CRM (`bigdata.audiencia.v1`)

Atlas CRM arma campañas de correo que envía Atlas Lead. La audiencia sale de Bigdata:
el CRM filtra, ve el conteo y trae los contactos por páginas para entregárselos a
Atlas Lead. Bigdata y Atlas Lead no se hablan entre sí; el CRM orquesta.

## Endpoint

`POST /api/commercial-intelligence/atlas-bridge/audiencia`

Mismo puente firmado que la ficha por RUT: `x-atlas-source: atlas2`,
`x-atlas-timestamp` (segundos UNIX) y `x-atlas-signature = HMAC-SHA256(ATLAS2_FEEDBACK_BRIDGE_SECRET, "<ts>.<cuerpo>")`.

```json
{ "contract": "bigdata.audiencia.v1", "accion": "opciones" | "contar" | "pagina",
  "filtros": {
    "regiones": ["Metropolitana de Santiago"], "comunas": ["PROVIDENCIA"], "rubros": ["..."],
    "tamanos": ["micro", "pequena", "mediana", "grande", "sin_info"],
    "cargos": ["gerente_general", "gerencia", "representante_legal", "dueno_directorio", "comercial",
               "finanzas", "operaciones", "personas", "tecnologia", "marketing"],
    "trabajadores_min": 10, "trabajadores_max": 200,
    "solo_activas": true, "excluir_clientes_equifax": false,
    "contacto": "ejecutivos" | "empresa" | "ambos", "nombre_contiene": "..."
  },
  "despues": null, "limite": 500 }
```

- `opciones`: regiones, rubros, tamaños y grupos de cargo con su conteo; comunas de las regiones pedidas.
- `contar`: `contactos`, `empresas`, `ejecutivos`, `correos_generales`, `actualizada_at`.
- `pagina`: `filas` (referencia, rut, empresa, email, origen, nombre, cargo, área, teléfono, región,
  comuna, rubro, tamaño, trabajadores) y `siguiente` (cursor; `null` en la última página).

`contacto: "ambos"` trae a los ejecutivos que calzan con el cargo, más el correo general de las
empresas que no tienen ningún ejecutivo con correo.

## Datos

- Vista materializada `atlas_audiencia_contactos`: una fila por correo de ejecutivo (`ejecutivos`) o
  correo general (`empresas_master.mejor_email`), con la región escrita de una sola forma
  (`atlas_region_canonica`), el tamaño por tramo de ventas del SII (`atlas_tamano_empresa`) y el cargo
  agrupado (`atlas_grupos_de_cargo`). Sin lo que está en `contact_blacklist`.
- Se refresca todas las noches a las 07:50 UTC (`pg_cron`, `atlas_audiencia_refrescar()`); cada
  página vuelve a revisar la lista negra para que un rebote de hoy no espere al refresco.
- Migración: `supabase/migrations/20261007180000_audiencias_para_campanas_de_correo.sql`.
