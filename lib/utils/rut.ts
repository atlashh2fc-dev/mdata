/**
 * Utilidades para validación y formateo de RUT chileno
 */

/**
 * Limpia un RUT eliminando puntos, guiones y espacios
 */
export function cleanRut(rut: string): string {
  return rut.replace(/[.\-\s]/g, '').toUpperCase().trim()
}

/**
 * Valida un RUT chileno (con o sin puntos/guiones)
 */
export function validateRut(rut: string): boolean {
  if (!rut || typeof rut !== 'string') return false

  const clean = cleanRut(rut)
  if (clean.length < 2) return false

  const dv = clean.slice(-1)
  const digits = clean.slice(0, -1)

  if (!/^\d+$/.test(digits)) return false

  let sum = 0
  let mult = 2

  for (let i = digits.length - 1; i >= 0; i--) {
    sum += parseInt(digits[i], 10) * mult
    mult = mult === 7 ? 2 : mult + 1
  }

  const remainder = 11 - (sum % 11)
  const calcDv = remainder === 11 ? '0' : remainder === 10 ? 'K' : String(remainder)

  return calcDv === dv
}

/**
 * Formatea un RUT al formato estándar chileno: XXXXXXXX-X
 */
export function formatRut(rut: string): string {
  const clean = cleanRut(rut)
  if (clean.length < 2) return rut

  const dv = clean.slice(-1)
  const digits = clean.slice(0, -1).replace(/^0+/, '') || '0'

  // Agregar puntos de miles
  const formatted = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${formatted}-${dv}`
}

/**
 * Normaliza un RUT a formato sin puntos pero con guión: XXXXXXXX-X
 */
export function normalizeRut(rut: string): string {
  const clean = cleanRut(rut)
  if (clean.length < 2) return rut
  return `${clean.slice(0, -1)}-${clean.slice(-1)}`
}

/**
 * Intenta detectar si una columna contiene RUTs chilenos
 * basándose en una muestra de valores
 */
export function detectRutColumn(samples: string[]): boolean {
  if (!samples || samples.length === 0) return false

  const validSamples = samples
    .filter(v => v && String(v).trim().length > 0)
    .slice(0, 20)

  if (validSamples.length === 0) return false

  const validCount = validSamples.filter(v => validateRut(String(v))).length
  return validCount / validSamples.length >= 0.7 // 70% válidos = columna de RUT
}

/**
 * Formatea RUT para display (con puntos y guión)
 */
export function displayRut(rut: string): string {
  return formatRut(rut)
}

/**
 * Genera el dígito verificador de un RUT
 */
export function calcDv(digits: string | number): string {
  const str = String(digits).replace(/\D/g, '')
  let sum = 0
  let mult = 2

  for (let i = str.length - 1; i >= 0; i--) {
    sum += parseInt(str[i], 10) * mult
    mult = mult === 7 ? 2 : mult + 1
  }

  const remainder = 11 - (sum % 11)
  if (remainder === 11) return '0'
  if (remainder === 10) return 'K'
  return String(remainder)
}
