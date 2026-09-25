import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import {
  handleFichaRutRequest,
  padronKey,
  padronNombreNatural,
  parseFichaRutRequest,
  personaNombre,
  type EmpresaRow,
  type FichaRutLoader,
  type PadronRow,
  type PersonaRow,
  type TelefonoRow,
} from './atlas-ficha-rut'

const SECRET = 'test-ficha-secret'
process.env.ATLAS2_FEEDBACK_BRIDGE_SECRET = SECRET

// La empresa del ejemplo del contrato; las personas y celulares son ficticios.
const funeraria: EmpresaRow = {
  rutid: '076150794K',
  razon_social: 'FUNERARIA ALMENDRAS Y COMPANIA LIMITADA',
  region: 'XIII REGION METROPOLITANA',
  comuna: 'QUINTA NORMAL',
  direccion: '',
  rubro_economico_ultimo: 'OTRAS ACTIVIDADES DE SERVICIOS',
  mejor_email: '',
  email_en_blacklist: false,
  mejor_fono: '+56227721528',
  fono_en_blacklist: false,
  ejecutivo_principal: '',
  ejecutivo_cargo: '',
  es_cliente_equifax: false,
  sii_activa_sin_termino_giro: true,
}

const telefonosFuneraria: TelefonoRow[] = [
  { telefono: '227721528', nombre_origen: 'FUNERARIA ALMENDRAS Y COMPANIA LIMITADA', cargo_origen: '', es_fono_empresa: true },
  { telefono: '227721528', nombre_origen: 'FUNERARIA ALMENDRAS Y COMPANIA LIMITADA', cargo_origen: '', es_fono_empresa: true },
  { telefono: '911110001', nombre_origen: 'PEDRO PABLO SOTO ROJAS', cargo_origen: '', es_fono_empresa: false },
  { telefono: '911110002', nombre_origen: 'MARIA JOSE SOTO VERA', cargo_origen: '', es_fono_empresa: false },
  { telefono: '911110001', nombre_origen: 'PEDRO PABLO SOTO ROJAS', cargo_origen: '', es_fono_empresa: false },
  { telefono: '222220003', nombre_origen: 'PEDRO PABLO SOTO ROJAS', cargo_origen: '', es_fono_empresa: false },
]

type Fixture = {
  empresas?: Record<string, EmpresaRow>
  telefonos?: Record<string, TelefonoRow[]>
  representantes?: Record<string, TelefonoRow>
  noContactar?: string[]
  personas?: Record<string, PersonaRow>
  padron?: Record<string, PadronRow>
  bloqueados?: { contact_type: string; normalized_value: string }[]
}

function fakeLoader(fixture: Fixture): FichaRutLoader & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async empresa(rutid) { calls.push(`empresa:${rutid}`); return fixture.empresas?.[rutid] ?? null },
    async telefonos(rutid) { return fixture.telefonos?.[rutid] ?? [] },
    async representante(rutid) { return fixture.representantes?.[rutid] ?? null },
    async noContactar(rutid) { return fixture.noContactar?.includes(rutid) ?? false },
    async persona(rutid) { return fixture.personas?.[rutid] ?? null },
    async padron(rutid) {
      const key = padronKey(rutid)
      calls.push(`padron:${key.rutid}-${key.dv}`)
      return fixture.padron?.[`${key.rutid}-${key.dv}`] ?? null
    },
    async bloqueados(values) {
      return (fixture.bloqueados ?? []).filter(row => values.includes(row.normalized_value))
    },
  }
}

const baseFixture: Fixture = {
  empresas: { '076150794K': funeraria },
  telefonos: { '076150794K': telefonosFuneraria },
}

function signedRequest(
  body: unknown,
  options: { source?: string | null; secret?: string; timestamp?: string; signature?: string } = {}
) {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body)
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000))
  const signature = options.signature ??
    createHmac('sha256', options.secret ?? SECRET).update(`${timestamp}.${rawBody}`).digest('hex')
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-atlas-timestamp': timestamp,
    'x-atlas-signature': signature,
  }
  if (options.source !== null) headers['x-atlas-source'] = options.source ?? 'atlas2'
  return new Request('https://bigdata.test/api/commercial-intelligence/atlas-bridge/ficha-rut', {
    method: 'POST',
    headers,
    body: rawBody,
  })
}

const pedido = { contract: 'bigdata.ficha_rut.v1', rut: '76150794K' }

test('firma válida de atlas2 devuelve la ficha con la forma del contrato', async () => {
  const loader = fakeLoader(baseFixture)
  const response = await handleFichaRutRequest(signedRequest(pedido), () => loader)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), {
    contract: 'bigdata.ficha_rut.v1',
    found: true,
    rutid: '076150794K',
    tipo: 'empresa',
    nombre: 'FUNERARIA ALMENDRAS Y COMPANIA LIMITADA',
    region: 'XIII REGION METROPOLITANA',
    comuna: 'QUINTA NORMAL',
    direccion: null,
    rubro: 'OTRAS ACTIVIDADES DE SERVICIOS',
    email: null,
    contacto: null,
    telefonos: [
      { telefono: '227721528', nombre: 'FUNERARIA ALMENDRAS Y COMPANIA LIMITADA', cargo: null, es_empresa: true },
      { telefono: '911110001', nombre: 'PEDRO PABLO SOTO ROJAS', cargo: null, es_empresa: false },
      { telefono: '911110002', nombre: 'MARIA JOSE SOTO VERA', cargo: null, es_empresa: false },
      { telefono: '222220003', nombre: 'PEDRO PABLO SOTO ROJAS', cargo: null, es_empresa: false },
    ],
    senales: { cliente_equifax: false, activa_sii: true, no_contactar: false },
  })
  assert.deepEqual(loader.calls.filter(call => call.startsWith('empresa:')), ['empresa:076150794K'])
})

test('firma inválida, vencida, sin headers o de otra fuente no pasa', async () => {
  const loader = fakeLoader(baseFixture)
  const run = (request: Request) => handleFichaRutRequest(request, () => loader)

  assert.equal((await run(signedRequest(pedido, { secret: 'otro-secreto' }))).status, 401)
  assert.equal((await run(signedRequest(pedido, { signature: 'a'.repeat(64) }))).status, 401)

  const vencida = String(Math.floor(Date.now() / 1000) - 60 * 60)
  const expired = await run(signedRequest(pedido, { timestamp: vencida }))
  assert.equal(expired.status, 401)
  assert.match((await expired.json()).error, /expiró/)

  const iso = await run(signedRequest(pedido, { timestamp: new Date().toISOString() }))
  assert.equal(iso.status, 401)

  // La firma es válida, pero ficha-rut solo atiende a Atlas 2.0 y sin api key.
  assert.equal((await run(signedRequest(pedido, { source: 'atlas_lead' }))).status, 401)
  assert.equal((await run(signedRequest(pedido, { source: null }))).status, 401)
  const withApiKey = new Request('https://bigdata.test/x', {
    method: 'POST',
    headers: { 'x-atlas-source': 'atlas2', 'x-api-key': SECRET },
    body: JSON.stringify(pedido),
  })
  assert.equal((await run(withApiKey)).status, 401)

  // El cuerpo firmado no se puede cambiar.
  const request = signedRequest(pedido)
  const tampered = new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify({ ...pedido, rut: '22.222.222-2' }),
  })
  assert.equal((await run(tampered)).status, 401)
  assert.deepEqual(loader.calls, [])
})

test('sin secreto configurado responde 503', async () => {
  delete process.env.ATLAS2_FEEDBACK_BRIDGE_SECRET
  try {
    const response = await handleFichaRutRequest(signedRequest(pedido), () => fakeLoader(baseFixture))
    assert.equal(response.status, 503)
  } finally {
    process.env.ATLAS2_FEEDBACK_BRIDGE_SECRET = SECRET
  }
})

test('RUT que no está en Bigdata responde 404 con cuerpo del contrato', async () => {
  const response = await handleFichaRutRequest(
    signedRequest({ contract: 'bigdata.ficha_rut.v1', rut: '111111111' }),
    () => fakeLoader(baseFixture)
  )
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { contract: 'bigdata.ficha_rut.v1', found: false })
})

test('RUT o contrato inválidos responden 400', async () => {
  const run = (body: unknown) => handleFichaRutRequest(signedRequest(body), () => fakeLoader(baseFixture))
  assert.equal((await run({ contract: 'bigdata.ficha_rut.v1', rut: '761507941' })).status, 400)
  assert.equal((await run({ contract: 'bigdata.ficha_rut.v1', rut: 'hola' })).status, 400)
  assert.equal((await run({ contract: 'bigdata.ficha_rut.v1' })).status, 400)
  assert.equal((await run({ contract: 'otro.v2', rut: '76150794K' })).status, 400)
  assert.equal((await run('no es json')).status, 400)
})

test('el RUT compacto se lleva al rutid de 10 caracteres', () => {
  assert.deepEqual(parseFichaRutRequest(pedido), { ok: true, rutid: '076150794K' })
  assert.deepEqual(parseFichaRutRequest({ ...pedido, rut: '76150794k' }), { ok: true, rutid: '076150794K' })
  assert.deepEqual(parseFichaRutRequest({ ...pedido, rut: '76.150.794-K' }), { ok: true, rutid: '076150794K' })
  assert.deepEqual(parseFichaRutRequest({ ...pedido, rut: '222222222' }), { ok: true, rutid: '0222222222' })
  assert.deepEqual(padronKey('0222222222'), { rutid: '0022222222', dv: '2' })
})

test('lista negra, no contactar, ejecutivo y tope de teléfonos', async () => {
  const muchos = Array.from({ length: 12 }, (_, index) => ({
    telefono: `9${String(10000000 + index)}`,
    nombre_origen: `PERSONA ${index}`,
    cargo_origen: null,
    es_fono_empresa: false,
  }))
  const loader = fakeLoader({
    empresas: {
      '076150794K': {
        ...funeraria,
        mejor_fono: '+56911112222',
        mejor_email: 'CONTACTO@FUNERARIA.CL',
        ejecutivo_principal: 'ANA PEREZ',
        ejecutivo_cargo: 'GERENTE GENERAL',
      },
    },
    telefonos: { '076150794K': [...telefonosFuneraria, ...muchos] },
    representantes: {
      '076150794K': { telefono: '911110001', nombre_origen: 'PEDRO PABLO SOTO ROJAS', cargo_origen: 'REPRESENTANTE LEGAL', es_fono_empresa: false },
    },
    noContactar: ['076150794K'],
    bloqueados: [
      { contact_type: 'phone', normalized_value: '+56911110001' },
      { contact_type: 'phone', normalized_value: '+227721528' },
      { contact_type: 'email', normalized_value: 'contacto@funeraria.cl' },
    ],
  })
  const response = await handleFichaRutRequest(signedRequest(pedido), () => loader)
  const body = await response.json()
  assert.equal(body.telefonos.length, 8)
  assert.deepEqual(body.telefonos[0], { telefono: '911112222', nombre: null, cargo: null, es_empresa: false })
  const numeros = body.telefonos.map((item: { telefono: string }) => item.telefono)
  assert.ok(!numeros.includes('911110001'))
  assert.ok(!numeros.includes('227721528'))
  assert.equal(new Set(numeros).size, numeros.length)
  assert.equal(body.email, null)
  assert.deepEqual(body.contacto, { nombre: 'ANA PEREZ', cargo: 'GERENTE GENERAL' })
  assert.equal(body.senales.no_contactar, true)
})

test('sin ejecutivo, el contacto es el representante; con blacklist del maestro, el mejor fono sale', async () => {
  const loader = fakeLoader({
    empresas: { '076150794K': { ...funeraria, fono_en_blacklist: true, mejor_email: 'hola@funeraria.cl', email_en_blacklist: true } },
    telefonos: { '076150794K': telefonosFuneraria.slice(2) },
    representantes: {
      '076150794K': { telefono: '911110001', nombre_origen: 'PEDRO PABLO SOTO ROJAS', cargo_origen: 'REPRESENTANTE LEGAL', es_fono_empresa: false },
    },
  })
  const body = await (await handleFichaRutRequest(signedRequest(pedido), () => loader)).json()
  assert.deepEqual(body.contacto, { nombre: 'PEDRO PABLO SOTO ROJAS', cargo: 'REPRESENTANTE LEGAL' })
  assert.equal(body.email, null)
  assert.equal(body.telefonos[0].telefono, '911110001')
})

test('persona natural: nombre del padrón en orden natural y sin campos de empresa', async () => {
  const loader = fakeLoader({
    personas: {
      '0222222222': {
        nombres: 'PEDRO PABLO',
        paterno: 'PEDRO',
        materno: 'ROJAS',
        email: 'Pedro.Soto@example.com',
        fono_cel: '911110001',
        comuna_part: 'QUINTA NORMAL',
        region_part: 'METROPOLITANA DE SANTIAGO',
        domicilio_comuna: 'LOS ANGELES',
        domicilio_region: 'DEL BIOBIO',
      },
    },
    padron: { '0022222222-2': { nombre: 'SOTO ROJAS PEDRO PABLO', comuna: 'LOS ANGELES', region: 'DEL BIOBIO' } },
  })
  const response = await handleFichaRutRequest(
    signedRequest({ contract: 'bigdata.ficha_rut.v1', rut: '222222222' }),
    () => loader
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    contract: 'bigdata.ficha_rut.v1',
    found: true,
    rutid: '0222222222',
    tipo: 'persona',
    nombre: 'PEDRO PABLO SOTO ROJAS',
    region: 'METROPOLITANA DE SANTIAGO',
    comuna: 'QUINTA NORMAL',
    direccion: null,
    rubro: null,
    email: 'pedro.soto@example.com',
    contacto: null,
    telefonos: [{ telefono: '911110001', nombre: 'PEDRO PABLO SOTO ROJAS', cargo: null, es_empresa: false }],
    senales: { cliente_equifax: false, activa_sii: null, no_contactar: false },
  })
})

test('nombres de persona: padrón con apellidos compuestos y personas_master sin repetir', () => {
  assert.equal(padronNombreNatural('SOTO ROJAS PEDRO PABLO'), 'PEDRO PABLO SOTO ROJAS')
  assert.equal(padronNombreNatural('DE LA FUENTE PEREZ MARIA JOSE'), 'MARIA JOSE DE LA FUENTE PEREZ')
  assert.equal(padronNombreNatural('SAN MARTIN DEL CANTO ANA'), 'ANA SAN MARTIN DEL CANTO')
  assert.equal(padronNombreNatural('SMITH JOHN'), 'SMITH JOHN')
  assert.equal(padronNombreNatural('  '), null)
  assert.equal(personaNombre({ nombres: 'PEDRO PABLO', paterno: 'PEDRO', materno: 'ROJAS' }), 'PEDRO PABLO ROJAS')
  assert.equal(personaNombre({ nombres: 'MARIA JOSE', paterno: 'MARIA', materno: 'JOSE' }), 'MARIA JOSE')
  assert.equal(personaNombre({ nombres: '', paterno: null, materno: ' ' }), null)
})

test('una caída de la base responde 503, no 404', async () => {
  const loader = fakeLoader(baseFixture)
  loader.empresa = async () => { throw new Error('timeout') }
  const original = console.error
  console.error = () => {}
  try {
    const response = await handleFichaRutRequest(signedRequest(pedido), () => loader)
    assert.equal(response.status, 503)
  } finally {
    console.error = original
  }
})
