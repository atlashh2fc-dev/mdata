import * as XLSX from 'xlsx'
import { db, hasSupabaseAdminEnv } from '@/lib/db/supabase'
import { calcDv, cleanRut } from '@/lib/utils/rut'

const BATCH_SIZE = 500

const EMPRESA_HEADERS = [
  'RUT',
  'EMPRESA',
  'TAMAÑO',
  'FACTURACION_SUB_RANGO de FACTURACION',
  'ACTIVIDAD ECONOMICA',
  'DIRECCION',
  'COMUNA',
  'CIUDAD',
  'REGION',
  'TELEFONO COMERCIAL',
] as const

const EJECUTIVO_HEADERS = [
  'RUT',
  'NOMBRES',
  'APELLIDO_PATERNO',
  'APELLIDO_MATERNO',
  'CARGO',
  'CARGO GENERICO',
  'MAIL_EJECUTIVO',
  'FONO_EJECUTIVO',
  'CELULAR_EJECUTIVO',
] as const

type CellValue = string | number | boolean | null

type EmpresaInfo = {
  rutid: string
  razon_social_empresa: string | null
  rubro: string | null
  facturacion_sub_rango: string | null
  tamano_empresas: string | null
  domicilio_comuna: string | null
  domicilio_region: string | null
  comuna_canonica: string | null
  region_canonica: string | null
  fono_cel: string | null
}

type GeimserInfo = {
  rutid: string
  razon_social: string | null
  tipovia_comer: string | null
  calle_comer: string | null
  numero_comer: string | null
  resto_direccion_comer: string | null
  comuna_comer: string | null
  ciudad_comer: string | null
  region_comer: string | null
  rubro: string | null
  facturacion_sub_rango: string | null
  tamano_empresas: string | null
}

type SalesTrendInfo = {
  rutid: string
  trabajadores_2024: number | null
  ultimo_tramo_ventas: number | null
  actividad_economica_ultima: string | null
  rubro_economico_ultimo: string | null
}

type AddressInfo = {
  rutid: string
  direccion: string | null
  comuna: string | null
  region: string | null
}

type WomInfo = {
  rutid: string
  direccion: string | null
  comuna: string | null
  telefono: string | null
}

type ContactPointInfo = {
  rutid: string
  contact_type: string | null
  contact_value: string | null
  source_name: string | null
  quality_score: number | null
  is_primary: boolean | null
  is_verified: boolean | null
  last_seen_at: string | null
}

type ExecutiveInfo = {
  id: string | number
  rutid: string
  rutid_ejecutivo: string | null
  nombre_ejecutivo: string | null
  cargo: string | null
  fono_area_cel: string | null
  fono_numero_cel: string | null
  fono_area_comer: string | null
  fono_numero_comer: string | null
  email: string | null
}

type Lookup = {
  lookupRutIds: string[]
  canonicalByLookup: Map<string, string>
}

function compact(values: Array<string | number | null | undefined>) {
  return values
    .map(value => String(value ?? '').trim())
    .filter(Boolean)
}

function firstPresent(...values: Array<CellValue | undefined>): CellValue {
  for (const value of values) {
    if (value === null || value === undefined) continue
    if (typeof value === 'string' && value.trim().length === 0) continue
    return value
  }
  return null
}

function normalizeJoinRut(value: string | null | undefined): string {
  return cleanRut(String(value ?? '')).replace(/^0+/, '')
}

function buildLookup(rutids: string[]): Lookup {
  const canonicalByLookup = new Map<string, string>()

  for (const rutid of rutids) {
    const cleaned = cleanRut(String(rutid ?? ''))
    const unpadded = normalizeJoinRut(cleaned)
    if (!cleaned || cleaned.length < 2) continue
    canonicalByLookup.set(cleaned, cleaned)
    if (unpadded) canonicalByLookup.set(unpadded, cleaned)
  }

  return {
    lookupRutIds: [...canonicalByLookup.keys()],
    canonicalByLookup,
  }
}

function canonicalRut(rowRutid: unknown, lookup: Lookup): string | null {
  const cleaned = cleanRut(String(rowRutid ?? ''))
  if (!cleaned) return null
  return lookup.canonicalByLookup.get(cleaned) ?? lookup.canonicalByLookup.get(cleaned.replace(/^0+/, '')) ?? null
}

export function formatRutInfobusiness(rutid: string): string {
  const cleaned = cleanRut(rutid)
  if (cleaned.length < 2) return String(rutid ?? '')

  const body = cleaned.slice(0, -1).replace(/^0+/, '') || '0'
  const dv = cleaned.slice(-1)
  return `${body}-${dv}`
}

function normalizePhone(area: string | null | undefined, number: string | null | undefined): string | null {
  const areaDigits = String(area ?? '').replace(/\D/g, '')
  const numberDigits = String(number ?? '').replace(/\D/g, '')
  const joined = `${areaDigits}${numberDigits}`
  if (!joined) return null
  if (areaDigits === '9' || joined.length === 9 && joined.startsWith('9')) return `9 ${joined.replace(/^9/, '')}`
  if (areaDigits && numberDigits) return `${areaDigits} ${numberDigits}`
  return joined
}

function displayStoredPhone(value: string | null | undefined): string | null {
  let digits = String(value ?? '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('56')) digits = digits.slice(2)
  if (digits.length === 9 && digits.startsWith('9')) return `9 ${digits.slice(1)}`
  if (digits.length === 9 && digits.startsWith('2')) return `2 ${digits.slice(1)}`
  if (digits.length === 9) return `${digits.slice(0, 2)} ${digits.slice(2)}`
  if (digits.length > 1) return `${digits.slice(0, digits.length - 8)} ${digits.slice(-8)}`.trim()
  return digits
}

function contactRank(row: ContactPointInfo): number {
  const lastSeenTime = row.last_seen_at ? Date.parse(row.last_seen_at) : 0
  return (
    (row.is_primary ? 1_000_000 : 0) +
    (row.is_verified ? 100_000 : 0) +
    Number(row.quality_score ?? 0) * 1_000 +
    (Number.isFinite(lastSeenTime) ? Math.floor(lastSeenTime / 1_000_000_000) : 0)
  )
}

function executivePriority(cargo: string | null | undefined): number {
  const text = String(cargo ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  if (/sub\s*gerente|subgerente/.test(text)) return 78
  if (/gerente general|director ejecutivo|ceo|presidente/.test(text)) return 100
  if (/director/.test(text)) return 95
  if (/gerente comercial|ventas|comercial|negocios/.test(text)) return 92
  if (/administracion|finanzas|financ/.test(text)) return 90
  if (/operaciones|operacion/.test(text)) return 88
  if (/informatica|tecnolog|sistemas| ti\b|it\b/.test(text)) return 86
  if (/recursos humanos|personal|rrhh/.test(text)) return 84
  if (/compras|abastecimiento/.test(text)) return 82
  if (/subgerente/.test(text)) return 78
  if (/jefe|jefa|head|encargad/.test(text)) return 70
  if (/representante legal/.test(text)) return 68
  return 50
}

export function genericCargo(cargo: string | null | undefined): string {
  const text = String(cargo ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  if (/sub\s*gerente|subgerente/.test(text)) return 'Subgerente'
  if (/gerente general|director ejecutivo|ceo|presidente/.test(text)) return 'Gerente General'
  if (/gerente comercial|ventas|comercial|negocios/.test(text)) return 'Gerente Comercial'
  if (/administracion|finanzas|financ/.test(text)) return 'Gerente de Administración y Finanzas'
  if (/recursos humanos|personal|rrhh/.test(text)) return 'Gerente de Recursos Humanos'
  if (/informatica|tecnolog|sistemas| ti\b|it\b/.test(text)) return 'Gerente TI'
  if (/operaciones|operacion/.test(text)) return 'Gerente de Operaciones'
  if (/compras|abastecimiento/.test(text)) return 'Compras'
  if (/sucursal|oficina/.test(text)) return 'Sucursal'
  if (/representante legal/.test(text)) return 'Representante Legal'
  if (/director/.test(text)) return 'Director'
  if (/subgerente/.test(text)) return 'Subgerente'
  if (/jefe|jefa|head|encargad/.test(text)) return 'Jefatura'
  return 'Otro'
}

export function splitExecutiveName(nombre: string | null | undefined) {
  const parts = String(nombre ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { nombres: '', paterno: '', materno: '' }
  if (parts.length === 1) return { nombres: parts[0], paterno: '', materno: '' }
  if (parts.length === 2) return { nombres: parts[0], paterno: parts[1], materno: '' }
  return {
    nombres: parts.slice(0, -2).join(' '),
    paterno: parts.at(-2) ?? '',
    materno: parts.at(-1) ?? '',
  }
}

function buildGeimserAddress(row: GeimserInfo | undefined): string | null {
  if (!row) return null
  return compact([
    row.tipovia_comer,
    row.calle_comer,
    row.numero_comer,
    row.resto_direccion_comer,
  ]).join(' ') || null
}

async function fetchMap<T extends { rutid: string }>(
  table: string,
  select: string,
  lookup: Lookup
): Promise<Map<string, T>> {
  const rowsByRut = new Map<string, T>()
  for (let i = 0; i < lookup.lookupRutIds.length; i += BATCH_SIZE) {
    const batch = lookup.lookupRutIds.slice(i, i + BATCH_SIZE)
    const { data, error } = await db.from(table).select(select).in('rutid', batch)
    if (error) throw new Error(`No se pudo consultar ${table}: ${error.message}`)
    for (const row of (data ?? []) as T[]) {
      const rutid = canonicalRut(row.rutid, lookup)
      if (!rutid || rowsByRut.has(rutid)) continue
      rowsByRut.set(rutid, { ...row, rutid })
    }
  }
  return rowsByRut
}

async function fetchExecutives(lookup: Lookup): Promise<Map<string, ExecutiveInfo[]>> {
  const executivesByRut = new Map<string, ExecutiveInfo[]>()
  for (let i = 0; i < lookup.lookupRutIds.length; i += BATCH_SIZE) {
    const batch = lookup.lookupRutIds.slice(i, i + BATCH_SIZE)
    const { data, error } = await db
      .from('ejecutivos')
      .select('id,rutid,rutid_ejecutivo,nombre_ejecutivo,cargo,fono_area_cel,fono_numero_cel,fono_area_comer,fono_numero_comer,email')
      .in('rutid', batch)

    if (error) throw new Error(`No se pudo consultar ejecutivos: ${error.message}`)

    for (const row of (data ?? []) as ExecutiveInfo[]) {
      const rutid = canonicalRut(row.rutid, lookup)
      if (!rutid) continue
      const rows = executivesByRut.get(rutid) ?? []
      rows.push({ ...row, rutid })
      executivesByRut.set(rutid, rows)
    }
  }

  for (const rows of executivesByRut.values()) {
    rows.sort((a, b) => {
      const priorityDelta = executivePriority(b.cargo) - executivePriority(a.cargo)
      if (priorityDelta !== 0) return priorityDelta
      return Number(a.id) - Number(b.id)
    })
  }

  return executivesByRut
}

async function fetchBestPhones(lookup: Lookup): Promise<Map<string, string>> {
  const bestByRut = new Map<string, ContactPointInfo>()
  for (let i = 0; i < lookup.lookupRutIds.length; i += BATCH_SIZE) {
    const batch = lookup.lookupRutIds.slice(i, i + BATCH_SIZE)
    const { data, error } = await db
      .from('persona_contact_points')
      .select('rutid,contact_type,contact_value,source_name,quality_score,is_primary,is_verified,last_seen_at')
      .eq('contact_type', 'phone')
      .in('rutid', batch)

    if (error) throw new Error(`No se pudo consultar teléfonos: ${error.message}`)

    for (const row of (data ?? []) as ContactPointInfo[]) {
      const rutid = canonicalRut(row.rutid, lookup)
      if (!rutid || !row.contact_value) continue
      const normalized = { ...row, rutid }
      const current = bestByRut.get(rutid)
      if (!current || contactRank(normalized) > contactRank(current)) bestByRut.set(rutid, normalized)
    }
  }

  return new Map([...bestByRut.entries()].map(([rutid, row]) => [rutid, row.contact_value ?? '']))
}

export async function buildInfobusinessExport(rutids: string[]): Promise<ArrayBuffer> {
  if (!hasSupabaseAdminEnv) throw new Error('Faltan credenciales de Supabase para exportar Infobusiness.')

  const cleanRutids = [...new Set(rutids.map(rutid => cleanRut(String(rutid ?? ''))).filter(rutid => rutid.length >= 2))]
  const lookup = buildLookup(cleanRutids)

  const [
    masterByRut,
    geimserByRut,
    salesByRut,
    addressByRut,
    womByRut,
    bestPhonesByRut,
    executivesByRut,
  ] = await Promise.all([
    fetchMap<EmpresaInfo>(
      'master_personas_view',
      'rutid,razon_social_empresa,rubro,facturacion_sub_rango,tamano_empresas,domicilio_comuna,domicilio_region,comuna_canonica,region_canonica,fono_cel',
      lookup
    ),
    fetchMap<GeimserInfo>(
      'geimser_mkt_7245_empresas',
      'rutid,razon_social,tipovia_comer,calle_comer,numero_comer,resto_direccion_comer,comuna_comer,ciudad_comer,region_comer,rubro,facturacion_sub_rango,tamano_empresas',
      lookup
    ),
    fetchMap<SalesTrendInfo>(
      'empresas_ventas_tendencia',
      'rutid,trabajadores_2024,ultimo_tramo_ventas,actividad_economica_ultima,rubro_economico_ultimo',
      lookup
    ),
    fetchMap<AddressInfo>('empresas_direccion_preferida', 'rutid,direccion,comuna,region', lookup),
    fetchMap<WomInfo>('wom_customer_signals', 'rutid,direccion,comuna,telefono', lookup),
    fetchBestPhones(lookup),
    fetchExecutives(lookup),
  ])

  const empresaRows = cleanRutids.flatMap(rutid => {
    const master = masterByRut.get(rutid)
    if (!master) return []
    const geimser = geimserByRut.get(rutid)
    const sales = salesByRut.get(rutid)
    const address = addressByRut.get(rutid)
    const wom = womByRut.get(rutid)
    const firstExecutive = executivesByRut.get(rutid)?.[0]

    return [[
      formatRutInfobusiness(rutid),
      firstPresent(master.razon_social_empresa, geimser?.razon_social),
      firstPresent(sales?.trabajadores_2024, geimser?.tamano_empresas, master.tamano_empresas),
      firstPresent(geimser?.facturacion_sub_rango, master.facturacion_sub_rango, sales?.ultimo_tramo_ventas),
      firstPresent(sales?.actividad_economica_ultima, geimser?.rubro, master.rubro, sales?.rubro_economico_ultimo),
      firstPresent(buildGeimserAddress(geimser), address?.direccion, wom?.direccion),
      firstPresent(geimser?.comuna_comer, address?.comuna, master.domicilio_comuna, master.comuna_canonica, wom?.comuna),
      firstPresent(geimser?.ciudad_comer, geimser?.comuna_comer, address?.comuna, master.comuna_canonica),
      firstPresent(geimser?.region_comer, address?.region, master.domicilio_region, master.region_canonica),
      firstPresent(
        normalizePhone(firstExecutive?.fono_area_comer, firstExecutive?.fono_numero_comer),
        displayStoredPhone(bestPhonesByRut.get(rutid)),
        displayStoredPhone(master.fono_cel),
        displayStoredPhone(wom?.telefono)
      ),
    ]]
  })

  const ejecutivoRows = cleanRutids.flatMap(rutid => {
    const master = masterByRut.get(rutid)
    if (!master) return []
    return (executivesByRut.get(rutid) ?? []).map(executive => {
      const name = splitExecutiveName(executive.nombre_ejecutivo)
      return [
        formatRutInfobusiness(rutid),
        name.nombres,
        name.paterno,
        name.materno,
        executive.cargo ?? null,
        genericCargo(executive.cargo),
        executive.email ?? null,
        normalizePhone(executive.fono_area_comer, executive.fono_numero_comer),
        normalizePhone(executive.fono_area_cel, executive.fono_numero_cel),
      ]
    })
  })

  const workbook = XLSX.utils.book_new()
  const empresaSheet = XLSX.utils.aoa_to_sheet([[...EMPRESA_HEADERS], ...empresaRows])
  const ejecutivoSheet = XLSX.utils.aoa_to_sheet([[...EJECUTIVO_HEADERS], ...ejecutivoRows])

  empresaSheet['!cols'] = [
    { wch: 14 }, { wch: 38 }, { wch: 14 }, { wch: 30 }, { wch: 46 },
    { wch: 38 }, { wch: 18 }, { wch: 18 }, { wch: 24 }, { wch: 22 },
  ]
  ejecutivoSheet['!cols'] = [
    { wch: 14 }, { wch: 18 }, { wch: 18 }, { wch: 20 }, { wch: 42 },
    { wch: 32 }, { wch: 30 }, { wch: 18 }, { wch: 18 },
  ]
  empresaSheet['!autofilter'] = { ref: `A1:J${Math.max(1, empresaRows.length + 1)}` }
  ejecutivoSheet['!autofilter'] = { ref: `A1:I${Math.max(1, ejecutivoRows.length + 1)}` }

  XLSX.utils.book_append_sheet(workbook, empresaSheet, 'EMPRESA')
  XLSX.utils.book_append_sheet(workbook, ejecutivoSheet, 'EJECUTIVO')

  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
}

export function isValidInfobusinessRut(rutid: string): boolean {
  const cleaned = cleanRut(rutid)
  if (cleaned.length < 2) return false
  const body = cleaned.slice(0, -1).replace(/^0+/, '') || '0'
  return calcDv(body) === cleaned.slice(-1)
}
