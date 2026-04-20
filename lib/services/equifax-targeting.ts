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
      'fundacion',
    ],
  },
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

export function detectEquifaxNonTargetCompany(companyName?: string | null): EquifaxNonTargetMatch | null {
  const normalizedName = normalizeEquifaxKeyword(companyName ?? '')
  if (!normalizedName) return null

  for (const matcher of NON_TARGET_MATCHERS) {
    for (const token of matcher.tokens) {
      if (normalizedName.includes(token)) {
        return {
          tag: matcher.tag,
          matchedToken: token,
        }
      }
    }
  }

  return null
}

export function isEquifaxNonTargetCompany(companyName?: string | null): boolean {
  return detectEquifaxNonTargetCompany(companyName) !== null
}
