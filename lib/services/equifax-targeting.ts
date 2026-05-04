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
      'universidad',
      'colegio',
      'escuela',
      'liceo',
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
      'corpor desarr',
      'corporacion de desarrollo',
      'corporacion municipal',
      'corporacion educacional',
      'corporacion cultural',
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
