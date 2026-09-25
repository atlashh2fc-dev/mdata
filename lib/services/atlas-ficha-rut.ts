import { db } from '@/lib/db/supabase'
import { authorizeAtlasLeadBridgeRequest } from '@/lib/services/atlas-lead-bridge'
import { cleanRut, validateRut } from '@/lib/utils/rut'

/**
 * Ficha por RUT para el ingreso fuera de base de Atlas 2.0
 * (contrato bigdata.ficha_rut.v1). Atlas espera 6 s como máximo, así que todo
 * se lee por PK o índice de rutid. La ruta la llama un CRM multiempresa: la
 * respuesta lleva solo los campos del contrato, nada más.
 */

export const FICHA_RUT_CONTRACT = 'bigdata.ficha_rut.v1'
const MAX_BODY_BYTES = 4 * 1024
const MAX_TELEFONOS = 8
const QUERY_BUDGET_MS = 4_500

export type EmpresaRow = {
  rutid: string
  razon_social: string | null
  region: string | null
  comuna: string | null
  direccion: string | null
  rubro_economico_ultimo: string | null
  mejor_email: string | null
  email_en_blacklist: boolean | null
  mejor_fono: string | null
  fono_en_blacklist: boolean | null
  ejecutivo_principal: string | null
  ejecutivo_cargo: string | null
  es_cliente_equifax: boolean | null
  sii_activa_sin_termino_giro: boolean | null
}

export type TelefonoRow = {
  telefono: string | null
  nombre_origen: string | null
  cargo_origen: string | null
  es_fono_empresa: boolean | null
}

export type PersonaRow = {
  nombres: string | null
  paterno: string | null
  materno: string | null
  email: string | null
  fono_cel: string | null
  comuna_part: string | null
  region_part: string | null
  domicilio_comuna: string | null
  domicilio_region: string | null
}

export type PadronRow = {
  nombre: string | null
  comuna: string | null
  region: string | null
}

export type BlockedContact = { contact_type: string | null; normalized_value: string | null }

export type FichaRutLoader = {
  empresa(rutid: string): Promise<EmpresaRow | null>
  telefonos(rutid: string): Promise<TelefonoRow[]>
  representante(rutid: string): Promise<TelefonoRow | null>
  noContactar(rutid: string): Promise<boolean>
  persona(rutid: string): Promise<PersonaRow | null>
  padron(rutid: string): Promise<PadronRow | null>
  bloqueados(normalizedValues: string[]): Promise<BlockedContact[]>
}

export type FichaTelefono = {
  telefono: string
  nombre: string | null
  cargo: string | null
  es_empresa: boolean
}

export type FichaRutFound = {
  contract: typeof FICHA_RUT_CONTRACT
  found: true
  rutid: string
  tipo: 'empresa' | 'persona'
  nombre: string | null
  region: string | null
  comuna: string | null
  direccion: string | null
  rubro: string | null
  email: string | null
  contacto: { nombre: string; cargo: string | null } | null
  telefonos: FichaTelefono[]
  senales: { cliente_equifax: boolean; activa_sii: boolean | null; no_contactar: boolean }
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean || null
}

/** "76150794K" → "076150794K" (rutid de Bigdata). Null si no es un RUT válido. */
export function parseFichaRutRequest(payload: unknown): { ok: true; rutid: string } | { ok: false; error: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, error: 'El cuerpo debe ser un objeto JSON.' }
  }
  const body = payload as Record<string, unknown>
  if (body.contract !== FICHA_RUT_CONTRACT) {
    return { ok: false, error: `contract debe ser ${FICHA_RUT_CONTRACT}.` }
  }
  const rut = typeof body.rut === 'string' ? cleanRut(body.rut) : ''
  if (!/^\d{1,9}[0-9K]$/.test(rut) || !validateRut(rut)) {
    return { ok: false, error: 'rut inválido: se espera el RUT compacto con dígito verificador, p. ej. 76150794K.' }
  }
  return { ok: true, rutid: rut.replace(/^0+(?=\d)/, '').padStart(10, '0') }
}

/** Número nacional de 9 dígitos, o null si no es marcable. */
export function nationalPhone(value: unknown): string | null {
  const digits = typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\D/g, '') : ''
  const national = digits.startsWith('56') && digits.length === 11 ? digits.slice(2) : digits
  return /^[2-9]\d{8}$/.test(national) ? national : null
}

/** Formas en que `contact_blacklist.normalized_value` guarda un mismo número. */
function phoneBlacklistKeys(national: string): string[] {
  return [`+56${national}`, `56${national}`, `+${national}`, national]
}

const APELLIDO_PREFIJOS = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'SAN', 'SANTA', 'VAN', 'VON', 'MC', 'DA', 'DI', 'DAL', 'DELLA'])

/**
 * El padrón escribe "APELLIDO APELLIDO NOMBRES". Se devuelve en orden natural
 * ("PEDRO PABLO SOTO ROJAS") respetando apellidos compuestos como
 * "DE LA FUENTE". Si no alcanza para separar nombres, queda como viene.
 */
export function padronNombreNatural(value: string | null): string | null {
  const tokens = text(value)?.toUpperCase().split(' ') ?? []
  let index = 0
  const apellidos: string[] = []
  for (let apellido = 0; apellido < 2 && index < tokens.length; apellido += 1) {
    const partes: string[] = []
    while (index < tokens.length - 1 && APELLIDO_PREFIJOS.has(tokens[index])) partes.push(tokens[index++])
    partes.push(tokens[index++])
    apellidos.push(partes.join(' '))
  }
  const nombres = tokens.slice(index)
  if (!nombres.length) return text(value)
  return [...nombres, ...apellidos].join(' ')
}

/**
 * `personas_master` trae las columnas cruzadas: a veces `nombres` son los
 * apellidos y `paterno`/`materno` repiten los nombres de pila ("PEDRO PABLO"
 * + "PEDRO" + "ROJAS"). Se juntan sin repetir palabras.
 */
export function personaNombre(row: Pick<PersonaRow, 'nombres' | 'paterno' | 'materno'>): string | null {
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const part of [row.nombres, row.paterno, row.materno]) {
    for (const token of text(part)?.toUpperCase().split(' ') ?? []) {
      if (seen.has(token)) continue
      seen.add(token)
      tokens.push(token)
    }
  }
  return tokens.length ? tokens.join(' ') : null
}

/** Clave del padrón: cuerpo del RUT a 10 caracteres, sin dígito verificador. */
export function padronKey(rutid: string): { rutid: string; dv: string } {
  return { rutid: rutid.slice(0, -1).replace(/^0+(?=\d)/, '').padStart(10, '0'), dv: rutid.slice(-1) }
}

type Candidate = FichaTelefono

function uniquePhones(candidates: (Candidate | null)[], blocked: Set<string>): FichaTelefono[] {
  const seen = new Set<string>()
  const result: FichaTelefono[] = []
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.telefono)) continue
    seen.add(candidate.telefono)
    if (phoneBlacklistKeys(candidate.telefono).some(key => blocked.has(key))) continue
    result.push(candidate)
    if (result.length === MAX_TELEFONOS) break
  }
  return result
}

function telefonoCandidate(row: TelefonoRow): Candidate | null {
  const telefono = nationalPhone(row.telefono)
  if (!telefono) return null
  return {
    telefono,
    nombre: text(row.nombre_origen),
    cargo: text(row.cargo_origen),
    es_empresa: row.es_fono_empresa === true,
  }
}

async function blockedValues(loader: FichaRutLoader, phones: (string | null)[], emails: (string | null)[]) {
  const keys = new Set<string>()
  for (const phone of phones) if (phone) for (const key of phoneBlacklistKeys(phone)) keys.add(key)
  for (const email of emails) if (email) keys.add(email.toLowerCase())
  if (!keys.size) return { phones: new Set<string>(), emails: new Set<string>() }
  const rows = await loader.bloqueados([...keys])
  const blocked = { phones: new Set<string>(), emails: new Set<string>() }
  for (const row of rows) {
    const value = text(row.normalized_value)
    if (!value) continue
    if (row.contact_type === 'phone') blocked.phones.add(value)
    if (row.contact_type === 'email') blocked.emails.add(value.toLowerCase())
  }
  return blocked
}

export async function buildFichaRut(rutid: string, loader: FichaRutLoader): Promise<FichaRutFound | null> {
  const [empresa, telefonos, representante, noContactar, persona, padron] = await Promise.all([
    loader.empresa(rutid),
    loader.telefonos(rutid),
    loader.representante(rutid),
    loader.noContactar(rutid),
    loader.persona(rutid),
    loader.padron(rutid),
  ])

  if (empresa) {
    const mejorFono = empresa.fono_en_blacklist ? null : nationalPhone(empresa.mejor_fono)
    const filas = telefonos.map(telefonoCandidate)
    const mejorFila = mejorFono ? filas.find(candidate => candidate?.telefono === mejorFono) : null
    const email = empresa.email_en_blacklist ? null : text(empresa.mejor_email)?.toLowerCase() ?? null
    const blocked = await blockedValues(loader, [mejorFono, ...filas.map(candidate => candidate?.telefono ?? null)], [email])
    const ejecutivo = text(empresa.ejecutivo_principal)
    const representanteNombre = text(representante?.nombre_origen)

    return {
      contract: FICHA_RUT_CONTRACT,
      found: true,
      rutid,
      tipo: 'empresa',
      nombre: text(empresa.razon_social),
      region: text(empresa.region),
      comuna: text(empresa.comuna),
      direccion: text(empresa.direccion),
      rubro: text(empresa.rubro_economico_ultimo),
      email: email && !blocked.emails.has(email) ? email : null,
      contacto: ejecutivo
        ? { nombre: ejecutivo, cargo: text(empresa.ejecutivo_cargo) }
        : representanteNombre
          ? { nombre: representanteNombre, cargo: text(representante?.cargo_origen) }
          : null,
      telefonos: uniquePhones(
        [mejorFono ? mejorFila ?? { telefono: mejorFono, nombre: null, cargo: null, es_empresa: false } : null, ...filas],
        blocked.phones
      ),
      senales: {
        cliente_equifax: empresa.es_cliente_equifax === true,
        activa_sii: empresa.sii_activa_sin_termino_giro === true,
        no_contactar: noContactar,
      },
    }
  }

  if (!persona && !padron) return null

  const nombre = padronNombreNatural(padron?.nombre ?? null) ?? (persona ? personaNombre(persona) : null)
  const fono = nationalPhone(persona?.fono_cel)
  const email = text(persona?.email)?.toLowerCase() ?? null
  const blocked = await blockedValues(loader, [fono], [email])

  return {
    contract: FICHA_RUT_CONTRACT,
    found: true,
    rutid,
    tipo: 'persona',
    nombre,
    region: text(persona?.region_part) ?? text(persona?.domicilio_region) ?? text(padron?.region),
    comuna: text(persona?.comuna_part) ?? text(persona?.domicilio_comuna) ?? text(padron?.comuna),
    direccion: null,
    rubro: null,
    email: email && !blocked.emails.has(email) ? email : null,
    contacto: null,
    telefonos: uniquePhones([fono ? { telefono: fono, nombre, cargo: null, es_empresa: false } : null], blocked.phones),
    senales: { cliente_equifax: false, activa_sii: null, no_contactar: noContactar },
  }
}

function unwrap<T>(label: string, result: { data: T | null; error: { message: string } | null }): T | null {
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data
}

/** Lecturas reales, todas por PK o índice de rutid (o de normalized_value). */
export function supabaseFichaRutLoader(signal: AbortSignal): FichaRutLoader {
  return {
    async empresa(rutid) {
      return unwrap<EmpresaRow>('empresas_master', await db
        .from('empresas_master')
        .select('rutid,razon_social,region,comuna,direccion,rubro_economico_ultimo,mejor_email,email_en_blacklist,mejor_fono,fono_en_blacklist,ejecutivo_principal,ejecutivo_cargo,es_cliente_equifax,sii_activa_sin_termino_giro')
        .eq('rutid', rutid)
        .abortSignal(signal)
        .maybeSingle())
    },
    async telefonos(rutid) {
      return unwrap<TelefonoRow[]>('empresa_telefonos', await db
        .from('empresa_telefonos')
        .select('telefono,nombre_origen,cargo_origen,es_fono_empresa')
        .eq('rutid', rutid)
        .order('prioridad', { ascending: true, nullsFirst: false })
        .order('telefono', { ascending: true })
        .limit(40)
        .abortSignal(signal)) ?? []
    },
    async representante(rutid) {
      const rows = unwrap<TelefonoRow[]>('empresa_telefonos:representante', await db
        .from('empresa_telefonos')
        .select('telefono,nombre_origen,cargo_origen,es_fono_empresa')
        .eq('rutid', rutid)
        .imatch('cargo_origen', 'represent')
        .not('nombre_origen', 'is', null)
        .order('prioridad', { ascending: true, nullsFirst: false })
        .limit(1)
        .abortSignal(signal))
      return rows?.[0] ?? null
    },
    async noContactar(rutid) {
      const row = unwrap<{ do_not_contact: boolean | null }>('customer_360_companies', await db
        .from('customer_360_companies')
        .select('do_not_contact')
        .eq('rutid', rutid)
        .abortSignal(signal)
        .maybeSingle())
      return row?.do_not_contact === true
    },
    async persona(rutid) {
      return unwrap<PersonaRow>('personas_master', await db
        .from('personas_master')
        .select('nombres,paterno,materno,email,fono_cel,comuna_part,region_part,domicilio_comuna,domicilio_region')
        .eq('rutid', rutid)
        .abortSignal(signal)
        .maybeSingle())
    },
    async padron(rutid) {
      const key = padronKey(rutid)
      return unwrap<PadronRow>('padron_personas_raw', await db
        .from('padron_personas_raw')
        .select('nombre,comuna,region')
        .eq('rutid', key.rutid)
        .eq('dv', key.dv)
        .abortSignal(signal)
        .maybeSingle())
    },
    async bloqueados(normalizedValues) {
      return unwrap<BlockedContact[]>('contact_blacklist', await db
        .from('contact_blacklist')
        .select('contact_type,normalized_value')
        .in('normalized_value', normalizedValues)
        .abortSignal(signal)) ?? []
    },
  }
}

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

export async function handleFichaRutRequest(
  req: Request,
  makeLoader: (signal: AbortSignal) => FichaRutLoader = supabaseFichaRutLoader
): Promise<Response> {
  const rawBody = await req.text()
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return json({ error: 'El payload excede 4 KiB.' }, 413)
  }

  const source = req.headers.get('x-atlas-source')
  if (source !== 'atlas2') {
    return json({ error: 'ficha-rut requiere x-atlas-source: atlas2.' }, 401)
  }
  const authorization = authorizeAtlasLeadBridgeRequest({
    rawBody,
    source,
    signature: req.headers.get('x-atlas-signature'),
    timestamp: req.headers.get('x-atlas-timestamp'),
  })
  if (!authorization.ok) {
    return json({ error: authorization.error }, authorization.status)
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return json({ error: 'El cuerpo no es JSON válido.' }, 400)
  }
  const parsed = parseFichaRutRequest(payload)
  if (!parsed.ok) return json({ error: parsed.error }, 400)

  try {
    const ficha = await buildFichaRut(parsed.rutid, makeLoader(AbortSignal.timeout(QUERY_BUDGET_MS)))
    if (!ficha) return json({ contract: FICHA_RUT_CONTRACT, found: false }, 404)
    return json(ficha, 200)
  } catch (error) {
    console.error('[commercial-intelligence/atlas-bridge/ficha-rut]', error)
    return json({ error: 'Bigdata no pudo leer la ficha a tiempo.' }, 503)
  }
}
