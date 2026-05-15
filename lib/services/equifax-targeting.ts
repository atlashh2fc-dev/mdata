import { cleanRut, validateRut } from '@/lib/utils/rut'

const NON_TARGET_MATCHERS = [
  {
    tag: 'equifax-non-target-religious',
    tokens: [
      'iglesia',
      'parroquia',
      'diocesis',
      'diosesis',
      'obispado',
      'capilla',
      'congregacion',
      'ministerio evangelico',
      'corporacion religiosa',
    ],
  },
  {
    tag: 'equifax-non-target-foundation',
    tokens: [
      'corporacion',
      'fundacion',
    ],
  },
  {
    tag: 'equifax-non-target-public-sector',
    tokens: [
      'municipalidad',
      'gobierno',
      'ministerio',
      'subsecretaria',
      'seremi',
      'delegacion presidencial',
      'intendencia',
      'municipal',
      'servicio de salud',
      'departamento de salud',
      'salud municipal',
      'servicio nacional',
      'servicio de vivienda',
      'vivienda y urbanizacion',
      'serviu',
      'hospital',
      'contraloria',
      'tesoreria',
      'registro civil',
      'junta nacional',
      'sii',
      'corfo',
      'fosis',
      'sence',
      'sag',
      'conaf',
      'administracion publica',
      'seguridad social de afiliacion obligatoria',
    ],
  },
  {
    tag: 'equifax-non-target-armed-forces-police',
    tokens: [
      'carabineros',
      'direccion de logistica de carabineros',
      'carabineros de chile',
      'division de bienestar',
      'direccion de bienestar',
      'fuerzas armadas',
      'ejercito',
      'ejercito de chile',
      'armada',
      'armada de chile',
      'fuerza aerea',
      'fach',
      'policia de investigaciones',
      'pdi',
      'gendarmeria',
      'defensa nacional',
    ],
  },
  {
    tag: 'equifax-non-target-ngo-public-interest',
    tokens: [
      'organizacion no gubernamental',
      'ong',
      'asociacion',
      'asoc ',
      'corpor desarr',
      'corporacion de desarrollo',
      'corporacion municipal',
      'corporacion educacional',
      'corporacion cultural',
      'corp ',
      'corp industrial para',
      'asociacion gremial',
      'asoc gremial',
      'asoc de industriales',
      'asociacion de industriales',
      'camara de comercio',
      'camara chilena',
      'capitulo chileno',
      'red universitaria',
      'sucesion',
      'suc ',
    ],
  },
  {
    tag: 'equifax-non-target-bank-or-representative-office',
    tokens: [
      'banco',
      'bank',
      'societe generale',
      'oficina de representacion',
      'oficina de representación',
    ],
  },
  {
    tag: 'equifax-non-target-foreign-government',
    tokens: [
      'embajada',
      'consulado',
      'mision diplomatica',
      'organismos internacionales',
      'organos extraterritoriales',
    ],
  },
  {
    tag: 'equifax-non-target-foreign-country',
    tokens: [
      'peru',
      'peruana',
      'peruano',
      'bolivia',
      'argentina',
      'mexico',
      'ecuador',
      'colombia',
      'paraguay',
      'uruguay',
      'brasil',
      'brazil',
      'panama',
      'costa rica',
      'guatemala',
      'dominicana',
      'dominicano',
    ],
  },
  {
    tag: 'equifax-non-target-foreign-legal-form',
    tokens: [
      's a c',
      'sac',
      'sociedad anonima cerrada',
      'sucursal chile',
      'sucursal en chile',
      'agencia en chile',
    ],
  },
  {
    tag: 'equifax-non-target-community-property',
    tokens: [
      'condominio',
      'comunidad edificio',
      'comunidad de copropietarios',
      'junta de vecinos',
    ],
  },
] as const

const CHILE_REGION_TOKENS = [
  'arica',
  'parinacota',
  'tarapaca',
  'antofagasta',
  'atacama',
  'coquimbo',
  'valparaiso',
  'metropolitana',
  'ohiggins',
  'o higgins',
  'maule',
  'nuble',
  'biobio',
  'araucania',
  'los rios',
  'los lagos',
  'aysen',
  'magallanes',
] as const

export function normalizeEquifaxKeyword(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export type EquifaxCommercialTier = 'A' | 'B' | 'C' | 'D'

export type EquifaxCommercialScoreInput = {
  companyName?: string | null
  rubro?: string | null
  actividad?: string | null
  region?: string | null
  comuna?: string | null
  trend?: string | null
  salesVariationPct?: number | null
  salesBand?: number | null
  employees?: number | null
  branchCount?: number | null
  hasCompanySignal?: boolean | null
  hasB2BAssetSignal?: boolean | null
  isExistingCustomer?: boolean | null
  contactabilityScore?: number | null
  purchaseProbability?: number | null
}

export type EquifaxCommercialScore = {
  total_score: number
  industry_fit_score: number
  credit_need_score: number
  geographic_opportunity_score: number
  growth_score: number
  strategic_expansion_score: number
  tier: EquifaxCommercialTier
  vertical: string
  explanation: string
  reason_tags: string[]
}

const HIGH_PRIORITY_REGIONS = [
  'antofagasta',
  'biobio',
  'bio bio',
  'los lagos',
  'aysen',
  'ohiggins',
  'o higgins',
  'maule',
  'araucania',
] as const

const SECONDARY_REGION_OPPORTUNITIES = [
  'atacama',
  'coquimbo',
  'valparaiso',
  'nuble',
  'los rios',
] as const

const STRATEGIC_SECONDARY_COMUNAS = [
  'calama',
  'mejillones',
  'tocopilla',
  'los andes',
  'san felipe',
  'rancagua',
  'san fernando',
  'rengo',
  'machali',
  'talca',
  'curico',
  'linares',
  'chillan',
  'los angeles',
  'talcahuano',
  'coronel',
  'temuco',
  'angol',
  'victoria',
  'puerto montt',
  'osorno',
  'castro',
  'ancud',
  'dalcahue',
  'aysen',
  'coyhaique',
  'copiapo',
  'vallenar',
  'ovalle',
  'coquimbo',
  'quilpue',
] as const

const CREDIT_VERTICALS = [
  {
    vertical: 'financiamiento, factoring o leasing',
    industry: 98,
    credit: 100,
    tokens: ['factoring', 'leasing', 'financiera', 'financiamiento', 'credito automotriz', 'caja de compensacion', 'cooperativa de ahorro', 'cooperativa financiera'],
  },
  {
    vertical: 'automotora o venta de vehiculos',
    industry: 94,
    credit: 96,
    tokens: ['automotora', 'concesionaria', 'vehiculos', 'vehiculo', 'camiones', 'maquinaria agricola', 'repuestos automotrices', 'neumaticos'],
  },
  {
    vertical: 'importadora/exportadora o comercio exterior',
    industry: 92,
    credit: 90,
    tokens: ['importadora', 'importacion', 'import export', 'exportadora', 'comercio exterior', 'distribucion internacional'],
  },
  {
    vertical: 'distribucion mayorista',
    industry: 90,
    credit: 92,
    tokens: ['distribuidora', 'distribucion', 'mayorista', 'comercializadora', 'representaciones', 'abastecimiento'],
  },
  {
    vertical: 'proveedor industrial, mineria o maquinaria',
    industry: 90,
    credit: 88,
    tokens: ['industrial', 'insumos industriales', 'proveedor industrial', 'mineria', 'minero', 'maquinaria', 'equipos', 'hidraulica', 'metalurgica', 'electricidad industrial', 'ingenieria industrial'],
  },
  {
    vertical: 'retail, casa comercial o venta a plazo',
    industry: 88,
    credit: 92,
    tokens: ['retail', 'casa comercial', 'tienda', 'multitienda', 'muebles', 'electrodomesticos', 'materiales de construccion', 'ferreteria'],
  },
  {
    vertical: 'salud privada o equipamiento medico',
    industry: 84,
    credit: 82,
    tokens: ['clinica', 'centro medico', 'salud privada', 'laboratorio clinico', 'equipamiento medico', 'insumos medicos', 'dental'],
  },
  {
    vertical: 'educacion privada con pago recurrente',
    industry: 78,
    credit: 74,
    tokens: ['colegio', 'instituto', 'universidad privada', 'preuniversitario', 'educacion privada', 'centro de formacion tecnica'],
  },
  {
    vertical: 'telco, utilities o servicios recurrentes',
    industry: 86,
    credit: 88,
    tokens: ['telecom', 'telefonia', 'internet', 'energia', 'electricidad', 'agua potable', 'gas', 'utility', 'utilities', 'sanitaria'],
  },
  {
    vertical: 'agroindustria, salmonicultura o alimentos B2B',
    industry: 82,
    credit: 78,
    tokens: ['agroindustrial', 'agricola', 'fruticola', 'packing', 'exportadora agricola', 'salmon', 'salmonera', 'acuicola', 'acuicultura', 'pesquera', 'alimentos'],
  },
  {
    vertical: 'logistica, transporte o flota comercial',
    industry: 80,
    credit: 76,
    tokens: ['logistica', 'transportes', 'transporte de carga', 'bodega', 'almacenaje', 'forwarder', 'courier', 'flota'],
  },
  {
    vertical: 'construccion y contratistas',
    industry: 78,
    credit: 76,
    tokens: ['constructora', 'construccion', 'contratista', 'obras civiles', 'ingenieria y construccion', 'inmobiliaria constructora'],
  },
  {
    vertical: 'cobranza, seguros o gestion de riesgo',
    industry: 84,
    credit: 88,
    tokens: ['cobranza', 'recuperacion', 'seguros', 'aseguradora', 'corredora de seguros', 'corredora'],
  },
] as const

function clampScore(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value))
}

function roundScore(value: number) {
  return Math.round(clampScore(value) * 100) / 100
}

function nullableNumber(value: number | null | undefined) {
  return Number.isFinite(Number(value)) ? Number(value) : null
}

function matchAnyToken(normalizedText: string, tokens: readonly string[]) {
  return tokens.filter(token => matchesNormalizedToken(normalizedText, token))
}

function classifyCommercialVertical(normalizedText: string) {
  let best = {
    vertical: 'empresa B2B general',
    industry: 45,
    credit: 42,
    matches: [] as string[],
  }

  for (const profile of CREDIT_VERTICALS) {
    const matches = matchAnyToken(normalizedText, profile.tokens)
    if (matches.length === 0) continue
    const score = profile.industry + Math.min(matches.length - 1, 4) * 3
    if (score > best.industry) {
      best = {
        vertical: profile.vertical,
        industry: clampScore(score),
        credit: clampScore(profile.credit + Math.min(matches.length - 1, 4) * 2),
        matches,
      }
    }
  }

  return best
}

function scoreGeography(region?: string | null, comuna?: string | null) {
  const normalizedRegion = normalizeEquifaxKeyword(region ?? '')
  const normalizedComuna = normalizeEquifaxKeyword(comuna ?? '')
  let score = 42
  const tags: string[] = []

  if (HIGH_PRIORITY_REGIONS.some(token => normalizedRegion.includes(token))) {
    score = 82
    tags.push('region-oportunidad-alta')
  } else if (SECONDARY_REGION_OPPORTUNITIES.some(token => normalizedRegion.includes(token))) {
    score = 66
    tags.push('region-oportunidad-media')
  } else if (normalizedRegion.includes('metropolitana')) {
    score = 38
    tags.push('region-mayor-competencia')
  }

  if (STRATEGIC_SECONDARY_COMUNAS.some(token => normalizedComuna.includes(token))) {
    score += 14
    tags.push('comuna-polo-secundario')
  }

  return {
    score: roundScore(score),
    tags,
  }
}

function scoreGrowth(params: EquifaxCommercialScoreInput) {
  const trend = normalizeEquifaxKeyword(params.trend ?? '')
  const variation = nullableNumber(params.salesVariationPct)
  let score = 50
  const tags: string[] = []

  if (trend.includes('sube') || trend.includes('crece') || trend.includes('alza')) {
    score = 82
    tags.push('crecimiento-observable')
  } else if (trend.includes('estable')) {
    score = 64
    tags.push('estable')
  } else if (trend.includes('baja') || trend.includes('cae')) {
    score = 22
    tags.push('deterioro-ventas')
  } else if (trend.includes('sin datos')) {
    score = 45
    tags.push('crecimiento-sin-datos')
  }

  if (variation !== null) {
    if (variation >= 20) {
      score += 14
      tags.push('ventas-acelerando')
    } else if (variation >= 8) {
      score += 8
      tags.push('ventas-al-alza')
    } else if (variation <= -20) {
      score -= 24
      tags.push('caida-fuerte')
    } else if (variation <= -8) {
      score -= 12
      tags.push('ventas-a-la-baja')
    }
  }

  return {
    score: roundScore(score),
    tags,
  }
}

function scoreStrategicExpansion(params: EquifaxCommercialScoreInput, verticalScore: number) {
  let score = 34
  const tags: string[] = []
  const salesBand = nullableNumber(params.salesBand)
  const employees = nullableNumber(params.employees)
  const branchCount = nullableNumber(params.branchCount)

  if (salesBand !== null) {
    if (salesBand >= 8 && salesBand <= 12) {
      score += 28
      tags.push('tamano-comercial-relevante')
    } else if (salesBand >= 5) {
      score += 18
      tags.push('pyme-escalable')
    } else if (salesBand <= 2) {
      score -= 12
      tags.push('escala-limitada')
    }
  }

  if (employees !== null) {
    if (employees >= 50) {
      score += 20
      tags.push('dotacion-relevante')
    } else if (employees >= 10) {
      score += 10
      tags.push('dotacion-pyme')
    }
  }

  if (branchCount !== null && branchCount >= 2) {
    score += Math.min(18, branchCount * 3)
    tags.push('multi-sucursal')
  }

  if (params.hasB2BAssetSignal) {
    score += 10
    tags.push('senal-operacion-b2b')
  }

  if (params.hasCompanySignal) {
    score += 8
    tags.push('empresa-verificada')
  }

  if (params.isExistingCustomer) {
    score += 8
    tags.push('expansion-cliente-equifax')
  }

  score += Math.max(0, verticalScore - 70) * 0.18

  return {
    score: roundScore(score),
    tags,
  }
}

function resolveCommercialTier(totalScore: number): EquifaxCommercialTier {
  if (totalScore >= 78) return 'A'
  if (totalScore >= 62) return 'B'
  if (totalScore >= 45) return 'C'
  return 'D'
}

export function buildEquifaxCommercialScore(input: EquifaxCommercialScoreInput): EquifaxCommercialScore {
  const normalizedText = normalizeEquifaxKeyword([
    input.companyName,
    input.rubro,
    input.actividad,
  ].filter(Boolean).join(' '))
  const vertical = classifyCommercialVertical(normalizedText)
  const geo = scoreGeography(input.region, input.comuna)
  const growth = scoreGrowth(input)
  const expansion = scoreStrategicExpansion(input, vertical.industry)
  const contactability = nullableNumber(input.contactabilityScore)
  const purchaseProbability = nullableNumber(input.purchaseProbability)

  const industryFitScore = roundScore(vertical.industry)
  const creditNeedScore = roundScore(
    vertical.credit +
    (purchaseProbability === null ? 0 : (purchaseProbability - 50) * 0.12) +
    (contactability === null ? 0 : (contactability - 50) * 0.06)
  )
  const geographicOpportunityScore = geo.score
  const growthScore = growth.score
  const strategicExpansionScore = expansion.score
  const totalScore = roundScore(
    industryFitScore * 0.3 +
    creditNeedScore * 0.28 +
    geographicOpportunityScore * 0.16 +
    growthScore * 0.14 +
    strategicExpansionScore * 0.12
  )
  const tier = resolveCommercialTier(totalScore)
  const comuna = input.comuna?.trim()
  const region = input.region?.trim()
  const growthPhrase = growth.tags.includes('crecimiento-observable')
    ? 'con crecimiento observable'
    : growth.tags.includes('estable')
      ? 'con estabilidad sostenida'
      : growth.tags.includes('deterioro-ventas')
        ? 'con senal de deterioro'
        : 'sin tendencia concluyente'
  const locationPhrase = comuna && region ? `${comuna}, ${region}` : region ?? comuna ?? 'Chile'
  const explanation = `${vertical.vertical} en ${locationPhrase}, ${growthPhrase}, con necesidad probable de evaluacion crediticia, validacion comercial o control de incobrables.`

  return {
    total_score: totalScore,
    industry_fit_score: industryFitScore,
    credit_need_score: creditNeedScore,
    geographic_opportunity_score: geographicOpportunityScore,
    growth_score: growthScore,
    strategic_expansion_score: strategicExpansionScore,
    tier,
    vertical: vertical.vertical,
    explanation,
    reason_tags: [
      `vertical-${normalizeEquifaxKeyword(vertical.vertical).replace(/\s+/g, '-')}`,
      ...vertical.matches.map(match => `match-${match}`),
      ...geo.tags,
      ...growth.tags,
      ...expansion.tags,
      `tier-${tier}`,
    ].slice(0, 14),
  }
}

export type EquifaxNonTargetMatch = {
  tag: string
  matchedToken: string
}

function matchesNormalizedToken(normalizedText: string, token: string): boolean {
  if (!normalizedText || !token) return false
  if (token.length <= 4) {
    return normalizedText.split(/\s+/g).includes(token)
  }
  return normalizedText.includes(token)
}

export function normalizeEquifaxRutCandidate(value?: string | null): string {
  const cleaned = cleanRut(value ?? '')
  return cleaned.replace(/^0+(?=\d)/, '')
}

export function isValidChileanEntityRut(value?: string | null): boolean {
  const normalizedRut = normalizeEquifaxRutCandidate(value)
  if (!normalizedRut || normalizedRut.length < 2 || normalizedRut.length > 9) return false
  return validateRut(normalizedRut)
}

export function isLikelyChileanRegion(region?: string | null): boolean {
  const normalizedRegion = normalizeEquifaxKeyword(region ?? '')
  if (!normalizedRegion) return true
  return CHILE_REGION_TOKENS.some(token => normalizedRegion.includes(token))
}

export function detectEquifaxNonTargetCompany(
  companyName?: string | null,
  options?: {
    rutid?: string | null
    region?: string | null
  }
): EquifaxNonTargetMatch | null {
  const normalizedName = normalizeEquifaxKeyword(companyName ?? '')
  const normalizedRegion = normalizeEquifaxKeyword(options?.region ?? '')

  if (options?.rutid && !isValidChileanEntityRut(options.rutid)) {
    return {
      tag: 'equifax-non-target-invalid-chile-rut',
      matchedToken: normalizeEquifaxRutCandidate(options.rutid),
    }
  }

  if (normalizedRegion && !isLikelyChileanRegion(options?.region)) {
    return {
      tag: 'equifax-non-target-non-chile-region',
      matchedToken: normalizedRegion,
    }
  }

  if (!normalizedName) return null

  for (const matcher of NON_TARGET_MATCHERS) {
    for (const token of matcher.tokens) {
      if (matchesNormalizedToken(normalizedName, token)) {
        return {
          tag: matcher.tag,
          matchedToken: token,
        }
      }
    }
  }

  return null
}

export function isEquifaxNonTargetCompany(
  companyName?: string | null,
  options?: {
    rutid?: string | null
    region?: string | null
  }
): boolean {
  return detectEquifaxNonTargetCompany(companyName, options) !== null
}
