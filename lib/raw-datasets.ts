import { createHmac, timingSafeEqual } from 'node:crypto'

export const RAW_DATASETS_RELEASE = '2026-08-13'
export const RAW_DATASET_SESSION_COOKIE = '__Host-mdata-originales'

export type RawDataset = {
  slug: string
  name: string
  description: string
  table: string
  objectName: string
  rows: number | null
}

export const RAW_DATASETS: RawDataset[] = [
  {
    slug: 'padron-2024',
    name: 'Padrón 2024',
    description: 'Carga fuente del padrón de personas, sin cruces con maestros.',
    table: 'padron_personas_raw',
    objectName: 'padron-2024.csv.gz',
    rows: 15_456_642,
  },
  {
    slug: 'bbrr-propiedades',
    name: 'Bienes raíces y propiedades',
    description: 'Registros de la fuente BBRR tal como quedaron cargados en su tabla propia.',
    table: 'bbrr_propiedades',
    objectName: 'bbrr-propiedades.csv.gz',
    rows: 8_878_668,
  },
  {
    slug: 'automoviles-2025',
    name: 'Automóviles 2025',
    description: 'Carga fuente de vehículos 2025, sin enriquecimiento desde personas o empresas.',
    table: 'automoviles2025',
    objectName: 'automoviles-2025.csv.gz',
    rows: 8_396_372,
  },
  {
    slug: 'resultado-7569',
    name: 'Resultado 7569 personas naturales',
    description: 'Dataset fuente resultado 7569, sin cruces posteriores.',
    table: 'resultado_7569_dataset',
    objectName: 'resultado-7569-personas-naturales.csv.gz',
    rows: 300_000,
  },
  {
    slug: 'malla-ubo',
    name: 'Malla UBO sociedades',
    description: 'Relaciones sociedad-socio provenientes de la carga fuente UBO.',
    table: 'malla_ubo',
    objectName: 'malla-ubo-sociedades.csv.gz',
    rows: 2_819_222,
  },
  {
    slug: 'wom-customer-signals',
    name: 'WOM customer signals',
    description: 'Carga fuente de señales WOM, sin cruces con maestros ni scoring.',
    table: 'wom_customer_signals',
    objectName: 'wom-customer-signals.csv.gz',
    rows: 2_657_721,
  },
  {
    slug: 'd2c-leads-empresa-source',
    name: 'D2C Leads Empresa — fuente',
    description: 'Filas de origen D2C; se excluye expresamente la tabla enriquecida.',
    table: 'd2c_prd_leads_empresa_source',
    objectName: 'd2c-leads-empresa-source.csv.gz',
    rows: 5_527,
  },
]

type ShareTokenPayload = {
  v: 1
  exp: number
  nonce: string
}

function getShareSecret() {
  return process.env.RAW_DATASET_SHARE_SECRET ?? null
}

function signTokenPayload(encodedPayload: string, secret: string) {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url')
}

export function verifyRawDatasetShareToken(candidate: string | null): ShareTokenPayload | null {
  const secret = getShareSecret()
  if (!candidate || !secret) return null

  const [encodedPayload, providedSignature, extra] = candidate.split('.')
  if (!encodedPayload || !providedSignature || extra) return null

  const expectedSignature = signTokenPayload(encodedPayload, secret)
  const providedBuffer = Buffer.from(providedSignature)
  const expectedBuffer = Buffer.from(expectedSignature)
  if (
    providedBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(providedBuffer, expectedBuffer)
  ) return null

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Partial<ShareTokenPayload>
    if (
      payload.v !== 1
      || typeof payload.exp !== 'number'
      || payload.exp <= Math.floor(Date.now() / 1000)
      || typeof payload.nonce !== 'string'
      || payload.nonce.length < 16
    ) return null

    return payload as ShareTokenPayload
  } catch {
    return null
  }
}

export function createRawDatasetShareToken(expiresAt: Date, nonce: string) {
  const secret = getShareSecret()
  if (!secret) throw new Error('Falta RAW_DATASET_SHARE_SECRET.')

  const payload: ShareTokenPayload = {
    v: 1,
    exp: Math.floor(expiresAt.getTime() / 1000),
    nonce,
  }
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encodedPayload}.${signTokenPayload(encodedPayload, secret)}`
}

export function formatDatasetSize(bytes: number | null) {
  if (!bytes || bytes <= 0) return null

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value.toLocaleString('es-CL', { maximumFractionDigits: exponent > 2 ? 2 : 1 })} ${units[exponent]}`
}

export function formatDatasetRows(rows: number | null) {
  return rows === null ? null : rows.toLocaleString('es-CL')
}
