export function normalizeCompanyName(value: string): string {
  let normalized = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()

  normalized = normalized
    .replace(/\bSOCIEDAD POR ACCIONES\b/g, ' ')
    .replace(/\bSOCIEDAD ANONIMA\b/g, ' ')
    .replace(/\bRESPONSABILIDAD LIMITADA\b/g, ' ')
    .replace(/&/g, ' Y ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()

  const removableSuffixes = new Set([
    'SPA',
    'LTDA',
    'LIMITADA',
    'SA',
    'SAS',
    'EIRL',
  ])

  const tokens = normalized.split(/\s+/).filter(Boolean)
  while (tokens.length > 0 && removableSuffixes.has(tokens[tokens.length - 1])) {
    tokens.pop()
  }

  return tokens.join(' ').trim()
}
