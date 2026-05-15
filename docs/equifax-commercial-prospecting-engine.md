# Auditoria y rediseño del BDD prospecting engine Equifax Chile

## Auditoria del motor anterior

- El scoring principal estaba optimizado para contactabilidad, interés y compra desde feedback CRM, pero no separaba el fit comercial propio de Equifax.
- `fit_score` era demasiado simple: cliente existente recibía 70+ y prospecto nuevo 45, aunque fuera una automotora, factoring, importadora o distribuidora mayorista.
- El filtro `non-target` penalizaba categorías que sí pueden ser compradores naturales: financieras, seguros, cooperativas, bancos, clínicas/hospitales privados y educación privada.
- La verticalización dependía demasiado de keywords de producto o razón social; el rubro/subrubro y señales de venta B2B a plazo quedaban subutilizadas.
- La geografía no tenía una hipótesis comercial explícita. Santiago podía sobrepesarse por disponibilidad de datos/contactos, no por oportunidad incremental.
- La tendencia comercial se usaba como boost simple, sin componente visible ni penalización fuerte por deterioro.
- La explicación final eran tags operativos, no una narrativa comercial accionable para el ejecutivo.

## Nueva lógica de scoring

Score total 0-100:

- `Industry Fit Score` 30%: verticales con dolor Equifax explícito.
- `Credit Need Score` 28%: probabilidad de vender a plazo, evaluar clientes, financiar, validar solvencia o reducir incobrables.
- `Geographic Opportunity Score` 16%: regiones y comunas donde hay oportunidad comercial fuera del sesgo Santiago.
- `Growth Score` 14%: empresas creciendo o estables; deterioro fuerte baja el ranking.
- `Strategic Expansion Score` 12%: tamaño, multi-sucursal, activos B2B, empresa verificada y posible expansión/upsell.

Tiering:

- Tier A: 78-100, máxima prioridad.
- Tier B: 62-77.99, buena oportunidad.
- Tier C: 45-61.99, secundario.
- Tier D: menos de 45, descartar o dejar en nurture.

## Verticales priorizadas

Alta prioridad:

- Factoring, leasing, financieras, cooperativas de ahorro/crédito.
- Automotoras, concesionarias, venta de camiones/maquinaria.
- Importadoras/exportadoras y comercio exterior.
- Distribuidoras, mayoristas, comercializadoras B2B.
- Proveedores industriales, minería, maquinaria, hidráulica, metalmecánica.
- Retail, casas comerciales, materiales de construcción y ferretería.
- Telcos, utilities y servicios recurrentes.
- Clínicas, centros médicos, equipamiento e insumos médicos.
- Educación privada con pago recurrente.
- Agroindustria, salmoneras, acuicultura, pesqueras y alimentos B2B.
- Logística, transporte de carga, bodegaje y flotas.
- Constructoras, contratistas y obras civiles.
- Cobranza, seguros, corredoras y gestión de riesgo.

## Geografía estratégica

Alta prioridad:

- Antofagasta, Biobío, Los Lagos, Aysén, O'Higgins, Maule y La Araucanía.

Oportunidad secundaria:

- Atacama, Coquimbo, Valparaíso, Ñuble y Los Ríos.

Comunas/polos con boost:

- Calama, Los Andes, San Felipe, Rancagua, Talca, Curicó, Chillán, Los Ángeles, Temuco, Puerto Montt, Osorno, Castro, Dalcahue, Coyhaique, Copiapó, Ovalle, Quilpué, entre otras.

## Implementación

Se agregó `buildEquifaxCommercialScore` en `lib/services/equifax-targeting.ts`.

El armado de BDD en `lib/services/equifax-bdd.ts` ahora devuelve por lead:

- `industry_fit_score`
- `credit_need_score`
- `geographic_opportunity_score`
- `growth_score`
- `strategic_expansion_score`
- `commercial_tier`
- `commercial_vertical`
- `commercial_explanation`

El pipeline de scoring en `lib/services/equifax-scoring.ts` guarda el nuevo fit en `score_breakdown.commercial_fit` y usa `fit_score` como fit comercial total, manteniendo compatibilidad con la tabla existente.

La UI/exportación en `components/equifax/EquifaxLeadBuilderPage.tsx` muestra y exporta tier, componentes y explicación.

## SQL sugerido para analítica

```sql
select
  rutid,
  company_name,
  fit_score as commercial_fit_score,
  score_breakdown #>> '{commercial_fit,tier}' as commercial_tier,
  score_breakdown #>> '{commercial_fit,vertical}' as commercial_vertical,
  (score_breakdown #>> '{commercial_fit,industry_fit_score}')::numeric as industry_fit_score,
  (score_breakdown #>> '{commercial_fit,credit_need_score}')::numeric as credit_need_score,
  (score_breakdown #>> '{commercial_fit,geographic_opportunity_score}')::numeric as geographic_opportunity_score,
  (score_breakdown #>> '{commercial_fit,growth_score}')::numeric as growth_score,
  (score_breakdown #>> '{commercial_fit,strategic_expansion_score}')::numeric as strategic_expansion_score,
  score_breakdown #>> '{commercial_fit,explanation}' as commercial_explanation,
  lead_score,
  lead_temperature,
  scored_at
from public.equifax_lead_scores
where fit_score >= 62
order by fit_score desc, lead_score desc;
```

## Ranking esperado

El top esperado debería moverse hacia:

1. Factoring/leasing/financieras regionales con buen contacto.
2. Automotoras y concesionarias en regiones mineras/agroindustriales.
3. Importadoras y distribuidoras mayoristas con tendencia al alza.
4. Proveedores industriales/mineros en Antofagasta, Calama, Biobío y Los Lagos.
5. Agroindustria, salmoneras y proveedores acuícolas en Los Lagos/Aysén.
6. Constructoras, transporte y logística B2B con activos y operación regional.
7. Clínicas/equipamiento médico y educación privada con pago recurrente.

## Próximas mejoras ML

- Entrenar un modelo supervisado con ventas Equifax reales usando los componentes como features interpretables.
- Calibrar pesos por producto: DICOM/Informes, scoring, validación financiera, monitoreo, cobranza.
- Crear uplift por región comparando conversión histórica vs penetración actual.
- Incorporar señales web: sucursales, ecommerce B2B, formularios de crédito, licitaciones, headcount y crecimiento.
- Medir precisión por tier: conversión, contacto efectivo, interés, venta y ticket esperado.
