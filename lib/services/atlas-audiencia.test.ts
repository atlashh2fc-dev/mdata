import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import {
  handleAudienciaRequest,
  parseAudienciaFiltros,
  parseAudienciaRequest,
  type AudienciaFiltros,
  type AudienciaLoader,
} from './atlas-audiencia'

const SECRET = 'test-audiencia-secret'
process.env.ATLAS2_FEEDBACK_BRIDGE_SECRET = SECRET

function signedRequest(body: unknown, options: { source?: string | null; secret?: string } = {}) {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = createHmac('sha256', options.secret ?? SECRET).update(`${timestamp}.${rawBody}`).digest('hex')
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-atlas-timestamp': timestamp,
    'x-atlas-signature': signature,
  }
  if (options.source !== null) headers['x-atlas-source'] = options.source ?? 'atlas2'
  return new Request('https://bigdata.test/api/commercial-intelligence/atlas-bridge/audiencia', {
    method: 'POST',
    headers,
    body: rawBody,
  })
}

function fakeLoader() {
  const calls: Array<{ accion: string; filtros: AudienciaFiltros; despues?: string | null; limite?: number }> = []
  const loader: AudienciaLoader = {
    async opciones(filtros) {
      calls.push({ accion: 'opciones', filtros })
      return { regiones: [{ valor: 'Valparaíso', contactos: 10 }] }
    },
    async contar(filtros) {
      calls.push({ accion: 'contar', filtros })
      return { contactos: 42, empresas: 40 }
    },
    async pagina(filtros, despues, limite) {
      calls.push({ accion: 'pagina', filtros, despues, limite })
      return { filas: [{ email: 'gerencia@ejemplo.cl' }], siguiente: null, bloqueados: 0 }
    },
  }
  return { loader, calls }
}

const contract = 'bigdata.audiencia.v1'

test('cuenta con los filtros normalizados', async () => {
  const { loader, calls } = fakeLoader()
  const response = await handleAudienciaRequest(
    signedRequest({ contract, accion: 'contar', filtros: { regiones: ['Valparaíso', 'Valparaíso'], cargos: ['gerente_general'] } }),
    () => loader
  )
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.contactos, 42)
  assert.deepEqual(calls[0].filtros, { regiones: ['Valparaíso'], cargos: ['gerente_general'] })
})

test('pagina con cursor y límite', async () => {
  const { loader, calls } = fakeLoader()
  const response = await handleAudienciaRequest(
    signedRequest({ contract, accion: 'pagina', filtros: {}, despues: '0076:a@b.cl', limite: 300 }),
    () => loader
  )
  assert.equal(response.status, 200)
  assert.equal(calls[0].despues, '0076:a@b.cl')
  assert.equal(calls[0].limite, 300)
})

test('rechaza sin firma válida o sin fuente atlas2', async () => {
  const { loader } = fakeLoader()
  const sinFuente = await handleAudienciaRequest(signedRequest({ contract, accion: 'contar' }, { source: null }), () => loader)
  assert.equal(sinFuente.status, 401)
  const malFirmada = await handleAudienciaRequest(signedRequest({ contract, accion: 'contar' }, { secret: 'otra' }), () => loader)
  assert.equal(malFirmada.status, 401)
})

test('valida filtros y acciones', () => {
  assert.equal(parseAudienciaRequest({ contract, accion: 'borrar' }).ok, false)
  assert.equal(parseAudienciaRequest({ contract: 'otro', accion: 'contar' }).ok, false)
  assert.equal(parseAudienciaFiltros({ tamanos: ['gigante'] }).ok, false)
  assert.equal(parseAudienciaFiltros({ trabajadores_min: 50, trabajadores_max: 10 }).ok, false)
  assert.equal(parseAudienciaFiltros({ contacto: 'todos' }).ok, false)
  const limpio = parseAudienciaFiltros({ nombre_contiene: '100%_seguro' })
  assert.ok(limpio.ok && limpio.filtros.nombre_contiene === '100  seguro')
  assert.equal(parseAudienciaRequest({ contract, accion: 'pagina', limite: 5000 }).ok, false)
})

test('si la base no responde, devuelve 503 sin detalles internos', async () => {
  const loader: AudienciaLoader = {
    async opciones() { throw new Error('boom') },
    async contar() { throw new Error('boom') },
    async pagina() { throw new Error('boom') },
  }
  const response = await handleAudienciaRequest(signedRequest({ contract, accion: 'contar' }), () => loader)
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error, 'Bigdata no pudo armar la audiencia a tiempo.')
})
