import { db } from '@/lib/db/supabase'
import { authorizeAtlasLeadBridgeRequest } from '@/lib/services/atlas-lead-bridge'

/**
 * Audiencias de correo para las campañas de Atlas CRM (contrato
 * bigdata.audiencia.v1). El CRM filtra la base de Bigdata (región, comuna,
 * rubro, tamaño, trabajadores, cargo), ve cuántos contactos quedan y los trae
 * por páginas para entregárselos a Atlas Lead. Todo sale de la vista
 * materializada atlas_audiencia_contactos: una fila por correo, sin la lista
 * negra, que además se revisa otra vez en cada página.
 *
 * Mismo puente firmado que la ficha por RUT: x-atlas-source atlas2 y HMAC del
 * cuerpo con ATLAS2_FEEDBACK_BRIDGE_SECRET.
 */

export const AUDIENCIA_CONTRACT = 'bigdata.audiencia.v1'
const MAX_BODY_BYTES = 16 * 1024
const QUERY_BUDGET_MS = 25_000
const MAX_LIST = 200

export const TAMANOS = ['micro', 'pequena', 'mediana', 'grande', 'sin_info'] as const
export const CARGOS = [
  'gerente_general',
  'gerencia',
  'representante_legal',
  'dueno_directorio',
  'comercial',
  'finanzas',
  'operaciones',
  'personas',
  'tecnologia',
  'marketing',
] as const
export const CONTACTO = ['ejecutivos', 'empresa', 'ambos'] as const

export type AudienciaFiltros = {
  regiones?: string[]
  comunas?: string[]
  rubros?: string[]
  tamanos?: (typeof TAMANOS)[number][]
  cargos?: (typeof CARGOS)[number][]
  trabajadores_min?: number | null
  trabajadores_max?: number | null
  solo_activas?: boolean
  excluir_clientes_equifax?: boolean
  contacto?: (typeof CONTACTO)[number]
  nombre_contiene?: string | null
}

export type AudienciaRequest =
  | { accion: 'opciones'; filtros: AudienciaFiltros }
  | { accion: 'contar'; filtros: AudienciaFiltros }
  | { accion: 'pagina'; filtros: AudienciaFiltros; despues: string | null; limite: number }

export type AudienciaLoader = {
  opciones(filtros: AudienciaFiltros): Promise<unknown>
  contar(filtros: AudienciaFiltros): Promise<unknown>
  pagina(filtros: AudienciaFiltros, despues: string | null, limite: number): Promise<unknown>
}

type Parsed = { ok: true; request: AudienciaRequest } | { ok: false; error: string }

function stringList(value: unknown, label: string, allowed?: readonly string[]): string[] | undefined | Error {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return new Error(`${label} debe ser una lista.`)
  if (value.length > MAX_LIST) return new Error(`${label} admite hasta ${MAX_LIST} valores.`)
  const items = value.map(item => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
  if (items.length !== value.length) return new Error(`${label} solo admite textos.`)
  if (allowed) {
    const unknown = items.find(item => !allowed.includes(item))
    if (unknown) return new Error(`${label}: valor desconocido "${unknown}".`)
  }
  return [...new Set(items)]
}

function optionalInt(value: unknown, label: string): number | null | undefined | Error {
  if (value === undefined || value === null || value === '') return value === undefined ? undefined : null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000_000) return new Error(`${label} debe ser un entero positivo.`)
  return parsed
}

export function parseAudienciaFiltros(value: unknown): { ok: true; filtros: AudienciaFiltros } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, filtros: {} }
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'filtros debe ser un objeto.' }
  const raw = value as Record<string, unknown>
  const filtros: AudienciaFiltros = {}

  const lists: Array<[keyof AudienciaFiltros, string, readonly string[] | undefined]> = [
    ['regiones', 'regiones', undefined],
    ['comunas', 'comunas', undefined],
    ['rubros', 'rubros', undefined],
    ['tamanos', 'tamanos', TAMANOS],
    ['cargos', 'cargos', CARGOS],
  ]
  for (const [key, label, allowed] of lists) {
    const parsed = stringList(raw[key], label, allowed)
    if (parsed instanceof Error) return { ok: false, error: parsed.message }
    if (parsed?.length) (filtros as Record<string, unknown>)[key] = parsed
  }

  for (const key of ['trabajadores_min', 'trabajadores_max'] as const) {
    const parsed = optionalInt(raw[key], key)
    if (parsed instanceof Error) return { ok: false, error: parsed.message }
    if (parsed !== undefined) filtros[key] = parsed
  }
  if (
    typeof filtros.trabajadores_min === 'number'
    && typeof filtros.trabajadores_max === 'number'
    && filtros.trabajadores_min > filtros.trabajadores_max
  ) {
    return { ok: false, error: 'trabajadores_min no puede ser mayor que trabajadores_max.' }
  }

  for (const key of ['solo_activas', 'excluir_clientes_equifax'] as const) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'boolean') return { ok: false, error: `${key} debe ser verdadero o falso.` }
    filtros[key] = raw[key] as boolean
  }

  if (raw.contacto !== undefined) {
    if (typeof raw.contacto !== 'string' || !CONTACTO.includes(raw.contacto as never)) {
      return { ok: false, error: `contacto debe ser ${CONTACTO.join(', ')}.` }
    }
    filtros.contacto = raw.contacto as AudienciaFiltros['contacto']
  }

  if (raw.nombre_contiene !== undefined && raw.nombre_contiene !== null) {
    if (typeof raw.nombre_contiene !== 'string' || raw.nombre_contiene.length > 120) {
      return { ok: false, error: 'nombre_contiene debe ser un texto de hasta 120 caracteres.' }
    }
    const clean = raw.nombre_contiene.replace(/[%_\\]/g, ' ').trim()
    if (clean) filtros.nombre_contiene = clean
  }

  return { ok: true, filtros }
}

export function parseAudienciaRequest(payload: unknown): Parsed {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'El cuerpo debe ser un objeto.' }
  }
  const body = payload as Record<string, unknown>
  if (body.contract !== AUDIENCIA_CONTRACT) {
    return { ok: false, error: `contract debe ser ${AUDIENCIA_CONTRACT}.` }
  }
  const filtros = parseAudienciaFiltros(body.filtros)
  if (!filtros.ok) return filtros

  if (body.accion === 'opciones' || body.accion === 'contar') {
    return { ok: true, request: { accion: body.accion, filtros: filtros.filtros } }
  }
  if (body.accion === 'pagina') {
    const despues = body.despues === undefined || body.despues === null ? null : body.despues
    if (despues !== null && (typeof despues !== 'string' || despues.length > 400)) {
      return { ok: false, error: 'despues debe ser el cursor que devolvió la página anterior.' }
    }
    const limite = body.limite === undefined ? 500 : Number(body.limite)
    if (!Number.isInteger(limite) || limite < 1 || limite > 1000) {
      return { ok: false, error: 'limite debe estar entre 1 y 1000.' }
    }
    return { ok: true, request: { accion: 'pagina', filtros: filtros.filtros, despues, limite } }
  }
  return { ok: false, error: 'accion debe ser opciones, contar o pagina.' }
}

function unwrap<T>(label: string, result: { data: T | null; error: { message: string } | null }): T | null {
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data
}

/** Lecturas reales: funciones SQL sobre la vista materializada. */
export function supabaseAudienciaLoader(signal: AbortSignal): AudienciaLoader {
  return {
    async opciones(filtros) {
      return unwrap('opciones', await db.rpc('atlas_audiencia_opciones', { f: filtros }).abortSignal(signal))
    },
    async contar(filtros) {
      return unwrap('contar', await db.rpc('atlas_audiencia_contar', { f: filtros }).abortSignal(signal))
    },
    async pagina(filtros, despues, limite) {
      return unwrap(
        'pagina',
        await db.rpc('atlas_audiencia_pagina', { f: filtros, despues, limite }).abortSignal(signal)
      )
    },
  }
}

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

export async function handleAudienciaRequest(
  req: Request,
  makeLoader: (signal: AbortSignal) => AudienciaLoader = supabaseAudienciaLoader
): Promise<Response> {
  const rawBody = await req.text()
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return json({ error: 'El payload excede 16 KiB.' }, 413)
  }

  const source = req.headers.get('x-atlas-source')
  if (source !== 'atlas2') {
    return json({ error: 'audiencia requiere x-atlas-source: atlas2.' }, 401)
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
  const parsed = parseAudienciaRequest(payload)
  if (!parsed.ok) return json({ error: parsed.error }, 400)

  const request = parsed.request
  try {
    const loader = makeLoader(AbortSignal.timeout(QUERY_BUDGET_MS))
    const data =
      request.accion === 'opciones'
        ? await loader.opciones(request.filtros)
        : request.accion === 'contar'
          ? await loader.contar(request.filtros)
          : await loader.pagina(request.filtros, request.despues, request.limite)
    return json({ contract: AUDIENCIA_CONTRACT, accion: request.accion, ...(data as Record<string, unknown>) }, 200)
  } catch (error) {
    console.error('[commercial-intelligence/atlas-bridge/audiencia]', error)
    return json({ error: 'Bigdata no pudo armar la audiencia a tiempo.' }, 503)
  }
}
