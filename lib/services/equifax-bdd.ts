import { db, hasSupabaseAdminEnv } from '@/lib/db/supabase'
import { getEquifaxLeadScoresMap } from '@/lib/services/equifax-scoring'
import {
  detectEquifaxNonTargetCompany,
  normalizeEquifaxKeyword,
} from '@/lib/services/equifax-targeting'
import { cleanRut } from '@/lib/utils/rut'
import { Client } from 'pg'
import type {
  EquifaxCatalogSummary,
  EquifaxLeadGenerationParams,
  EquifaxLeadPreviewResult,
  EquifaxLeadGenerationResult,
  EquifaxLeadScoreSnapshot,
  EquifaxLeadResultItem,
  EquifaxLeadScenario,
  EquifaxUniverseProgress,
  EquifaxUniversePreviewResult,
  EquifaxProductCatalogItem,
  EquifaxSalesImportResult,
} from '@/types/equifax'

const INCEPTION_API_URL = 'https://api.inceptionlabs.ai/v1/chat/completions'
const INCEPTION_MODEL = 'mercury-2'
const FETCH_CHUNK_SIZE = 1000
const FRESH_COMPANY_FETCH_CHUNK_SIZE = 5000
const RUT_LOOKUP_CHUNK_SIZE = 250
const MAX_GENERATION_VOLUME = 50000
const MAX_CANDIDATES = 60000
const MAX_FRESH_COMPANY_CANDIDATES = 180000
const MIN_SCORED_UNIVERSE_SAMPLE = 8000
const INSERT_CHUNK_SIZE = 500

type ImportedSaleRow = {
  source_file: string
  source_sheet: string
  source_row_number: number
  sale_kind: 'recurrente' | 'one_time'
  mes: string | null
  rut_raw: string | null
  rutid: string | null
  cliente: string | null
  fecha_venta: string | null
  ejecutiva: string | null
  origen: string | null
  servicio: string | null
  servicio_normalized: string | null
  valor: number | null
  periodo: number | null
  metadata: Record<string, unknown>
}

type ProductProfile = {
  include_keywords: string[]
  exclude_keywords: string[]
  buyer_signals: string[]
  prefer_existing_customers: boolean
  size_preference: 'any' | 'pyme' | 'enterprise'
  avoid_enterprise_keywords: string[]
  weights: {
    contactability: number
    purchase: number
    coverage: number
    existing_customer: number
    keyword_match: number
    company_presence: number
  }
  notes: string
}

type CandidateCompany = {
  rutid: string
  razon_social_empresa: string | null
  region_canonica: string | null
  comuna_canonica: string | null
  email: string | null
  fono_cel: string | null
  score_patrimonial: number | null
  cobertura_pct: number | null
  tiene_empresa: boolean | null
  tiene_autos: boolean | null
  tiene_bienes_raices: boolean | null
  n_autos: number | null
  n_bienes_raices: number | null
  source_universe?: 'master_personas_view' | 'empresas_comercial_unificada'
  segmento_tamano_empresa?: string | null
  resultado_tendencia?: string | null
  rubro_economico?: string | null
  actividad_economica?: string | null
  es_pyme?: boolean | null
  es_corporacion?: boolean | null
}

type PersonaScoreRow = {
  rutid: string
  contactability_score: number | null
  purchase_propensity_score: number | null
  priority_score: number | null
  best_phone: string | null
  best_email: string | null
  known_phone_count: number | null
  known_email_count: number | null
}

type FreshUniverseProgressHandler = (progress: EquifaxUniverseProgress) => void

type FreshCompanyTrendRow = {
  rutid: string
  razon_social: string | null
  region: string | null
  comuna: string | null
  ultimo_tramo_ventas: number | null
  resultado_tendencia: string | null
  rubro_economico_ultimo: string | null
  actividad_economica_ultima: string | null
}

type FreshMasterPersonaRow = {
  rutid: string
  email: string | null
  fono_cel: string | null
  region_part: string | null
  comuna_part: string | null
  domicilio_region: string | null
  domicilio_comuna: string | null
  razon_social_empresa: string | null
  n_autos: number | null
  n_bienes_raices: number | null
  totalavaluos: number | null
}

type EquifaxFeatureSnapshot = {
  company_name: string | null
  region: string | null
  comuna: string | null
  is_existing_customer: boolean
  known_phone_count: number
  known_email_count: number
  best_phone: string | null
  best_email: string | null
  score_patrimonial: number
  cobertura_pct: number
  n_autos: number
  n_bienes_raices: number
}

type CustomerSummaryRow = {
  rutid: string
  sales_count: number | null
  recurrent_sales_count: number | null
  one_time_sales_count: number | null
  total_amount: number | null
  last_sale_at: string | null
  services_bought: string[] | null
}

type ScoredLeadCandidate = EquifaxLeadResultItem & {
  base_priority_score: number
  coverage_score: number
  keyword_hits: number
}

type ScenarioConfig = {
  key: string
  title: string
  description: string
  recommendation: string
  weights: {
    base: number
    contactability: number
    purchase: number
    fit: number
    existing: number
    prospect: number
  }
}

type PreparedEquifaxCandidates = {
  volume: number
  aiProfile: ProductProfile
  candidates: ScoredLeadCandidate[]
  universeAnalyzed: number
  eligibleMatches: number
  universeSource: 'sampled_master' | 'scored_universe' | 'fresh_companies'
}

type PromptDirectives = {
  sizePreference: 'any' | 'pyme' | 'enterprise'
  avoidEnterpriseKeywords: string[]
}

type CandidateSelectionContext = {
  candidate: CandidateCompany
  aiProfile: ProductProfile
  scoreRow?: PersonaScoreRow
  customerSummary?: CustomerSummaryRow
  equifaxLeadScore?: EquifaxLeadScoreSnapshot
  includeExistingCustomers: boolean
  minPhoneCount: number
  minEmailCount: number
}

const EQUFAX_SCENARIOS: ScenarioConfig[] = [
  {
    key: 'balanceado_rapido',
    title: 'Base 1 · Balanceado para cierre rápido',
    description: 'Mezcla clientes actuales y prospectos nuevos, priorizando contacto disponible y fit comercial inmediato.',
    recommendation: 'Úsala cuando quieras velocidad comercial con una mezcla sana de upsell y apertura de cuentas nuevas.',
    weights: {
      base: 0.44,
      contactability: 0.18,
      purchase: 0.15,
      fit: 0.13,
      existing: 0.1,
      prospect: 0,
    },
  },
  {
    key: 'upsell_cross_sell',
    title: 'Base 2 · Upsell y cross-sell',
    description: 'Empuja primero clientes Equifax actuales con mayor contactabilidad y mejor encaje para ampliar ticket.',
    recommendation: 'Úsala cuando el foco sea vender rápido sobre cartera conocida y con argumentos comerciales más directos.',
    weights: {
      base: 0.34,
      contactability: 0.2,
      purchase: 0.14,
      fit: 0.14,
      existing: 0.18,
      prospect: 0,
    },
  },
  {
    key: 'captacion_nuevos',
    title: 'Base 3 · Captación de prospectos nuevos',
    description: 'Busca empresas nuevas con alto match a los productos, buena señal comercial y posibilidad real de contacto.',
    recommendation: 'Úsala cuando quieras expandir base nueva sin perder calidad de contacto ni potencial de compra.',
    weights: {
      base: 0.32,
      contactability: 0.16,
      purchase: 0.2,
      fit: 0.18,
      existing: 0,
      prospect: 0.14,
    },
  },
  {
    key: 'solo_verdes',
    title: 'Base 4 · Solo verdes priorizados',
    description: 'Parte desde leads ya scoreados como verdes y reordena por contacto disponible, propensión de compra e historial útil.',
    recommendation: 'Úsala cuando quieras una base nueva enfocada solo en oportunidades listas para gestión inmediata.',
    weights: {
      base: 0.28,
      contactability: 0.24,
      purchase: 0.18,
      fit: 0.18,
      existing: 0.08,
      prospect: 0.04,
    },
  },
]

function sanitizePostgresConnectionString(value: string) {
  const url = new URL(value)
  url.searchParams.delete('sslmode')
  url.searchParams.delete('pgbouncer')
  url.searchParams.delete('supa')
  return url.toString()
}

function resolvePostgresConnectionString() {
  return process.env.POSTGRES_URL_NON_POOLING
    ?? process.env.POSTGRES_URL
    ?? process.env.POSTGRES_PRISMA_URL
    ?? process.env.DATABASE_URL
    ?? null
}

async function withPostgresClient<T>(operation: (client: Client) => Promise<T>) {
  const connectionString = resolvePostgresConnectionString()
  if (!connectionString) {
    throw new Error('Falta configurar POSTGRES_URL_NON_POOLING para construir el universo.')
  }

  const client = new Client({
    connectionString: sanitizePostgresConnectionString(connectionString),
    ssl: { rejectUnauthorized: false },
    statement_timeout: 0,
    query_timeout: 0,
    connectionTimeoutMillis: 30000,
  })

  await client.connect()
  try {
    await client.query('set statement_timeout = 0')
    return await operation(client)
  } finally {
    await client.end()
  }
}

function normalizeRutForDb(value: string | null | undefined): string | null {
  if (!value) return null
  const cleaned = cleanRut(value)
  if (cleaned.length < 2) return null
  return cleaned.padStart(10, '0')
}

function normalizeRutForMatch(value: string | null | undefined): string | null {
  if (!value) return null
  const cleaned = cleanRut(value).replace(/^0+(?=\d)/, '')
  return cleaned.length >= 2 ? cleaned : null
}

function rutLookupVariants(value: string | null | undefined): string[] {
  const normalized = normalizeRutForMatch(value)
  const padded = normalizeRutForDb(value)
  return uniqueStrings([value ?? null, normalized, padded])
}

function normalizeKeyword(value: string): string {
  return normalizeEquifaxKeyword(value)
}

function normalizeTextArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => String(item ?? '').trim())
      .filter(Boolean)
  }

  return String(value ?? '')
    .split(/[,;\n|]/g)
    .map(item => item.trim())
    .filter(Boolean)
}

function toNullableString(value: unknown): string | null {
  const normalized = String(value ?? '').trim()
  return normalized.length > 0 ? normalized : null
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const normalized = Number(String(value).replace(',', '.'))
  return Number.isFinite(normalized) ? normalized : null
}

function toIsoDate(value: unknown, asMonth = false): string | null {
  if (!value) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString()
  }

  const raw = String(value).trim()
  if (!raw) return null

  if (asMonth && /^\d{4}-\d{2}$/.test(raw)) {
    return `${raw}-01T00:00:00.000Z`
  }

  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

function serviceSlug(value: string | null): string | null {
  if (!value) return null
  const normalized = normalizeKeyword(value)
  return normalized || null
}

function pickFirstValue(record: Record<string, unknown>, aliases: string[]): string | null {
  const entries = Object.entries(record)
  for (const alias of aliases) {
    const found = entries.find(([key]) => normalizeKeyword(key) === normalizeKeyword(alias))
    if (!found) continue
    return toNullableString(found[1])
  }
  return null
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function tokenizeKeywordCandidates(values: Array<string | null>): string[] {
  const stopwords = new Set([
    'equifax',
    'servicio',
    'servicios',
    'producto',
    'productos',
    'bundle',
    'pack',
    'plan',
    'venta',
    'ventas',
    'riesgo',
    'comercial',
  ])

  const tokens: string[] = []
  for (const value of values) {
    if (!value) continue
    const parts = normalizeKeyword(value).split(/\s+/g)
    for (const part of parts) {
      if (part.length < 4 || stopwords.has(part)) continue
      tokens.push(part)
    }
  }

  return uniqueStrings(tokens).slice(0, 24)
}

function extractPromptDirectives(prompt?: string | null): PromptDirectives {
  const normalizedPrompt = normalizeKeyword(prompt ?? '')
  if (!normalizedPrompt) {
    return {
      sizePreference: 'any',
      avoidEnterpriseKeywords: [],
    }
  }

  const prefersPyme =
    /\bpyme?s?\b/.test(normalizedPrompt) ||
    /\bnegocios?\b/.test(normalizedPrompt) ||
    /\bmedianas?\b/.test(normalizedPrompt) ||
    /\bpequenas?\b/.test(normalizedPrompt) ||
    normalizedPrompt.includes('no grandes empresas') ||
    normalizedPrompt.includes('no priorices grandes') ||
    normalizedPrompt.includes('evita grandes empresas') ||
    normalizedPrompt.includes('sin grandes empresas')

  const prefersEnterprise =
    normalizedPrompt.includes('grandes empresas') &&
    !normalizedPrompt.includes('no grandes empresas')

  const explicitTokens = new Set<string>()

  const genericMatches = [
    { pattern: /\bbancos?\b|\bbank\b/, token: 'banco' },
    { pattern: /\bcopec\b/, token: 'copec' },
    { pattern: /\bseguros?\b/, token: 'seguros' },
    { pattern: /\bholding\b/, token: 'holding' },
    { pattern: /\bretail\b/, token: 'retail' },
    { pattern: /\bafp\b/, token: 'afp' },
    { pattern: /\bisapre\b/, token: 'isapre' },
  ]

  for (const matcher of genericMatches) {
    if (matcher.pattern.test(normalizedPrompt)) {
      explicitTokens.add(matcher.token)
    }
  }

  const exampleClauseMatches = normalizedPrompt.match(/como\s+([a-z0-9\s,]+?)(?:\s+debemos|\s+y\s+negocios|\s+y\s+no|\s+quiero|[\.\n]|$)/)
  if (exampleClauseMatches?.[1]) {
    const rawTokens = exampleClauseMatches[1]
      .split(/\s+o\s+|,|\sy\s/g)
      .map(token => normalizeKeyword(token))
      .filter(token => token.length >= 4)

    for (const token of rawTokens) {
      explicitTokens.add(token)
    }
  }

  if (prefersPyme) {
    ;[
      'banco',
      'bank',
      'holding',
      'seguros',
      'afp',
      'isapre',
      'retail',
      'copec',
      'cencosud',
      'falabella',
      'walmart',
      'enel',
      'entel',
      'latam',
    ].forEach(token => explicitTokens.add(token))
  }

  return {
    sizePreference: prefersPyme ? 'pyme' : prefersEnterprise ? 'enterprise' : 'any',
    avoidEnterpriseKeywords: uniqueStrings([...explicitTokens]).map(normalizeKeyword).filter(Boolean),
  }
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value))
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function scoreEnterprisePenalty(companyName: string, profile: ProductProfile): number {
  if (profile.size_preference !== 'pyme') return 0

  const normalizedName = normalizeKeyword(companyName)
  let penalty = 0

  for (const keyword of profile.avoid_enterprise_keywords) {
    if (!keyword) continue
    if (normalizedName.includes(keyword)) {
      penalty += keyword.length <= 5 ? 85 : 70
    }
  }

  const genericEnterpriseIndicators = [
    'banco',
    'bank',
    'holding',
    'seguros',
    'afp',
    'isapre',
    'retail',
    'energia',
    'petroleo',
    'telecom',
  ]

  for (const indicator of genericEnterpriseIndicators) {
    if (normalizedName.includes(indicator)) {
      penalty += 35
    }
  }

  if (/\bs a\b/.test(normalizedName) || normalizedName.endsWith(' sa')) {
    penalty += 10
  }

  if (normalizedName.split(/\s+/g).length >= 6) {
    penalty += 8
  }

  return clamp(penalty, 0, 100)
}

function normalizeProductRecord(record: Record<string, unknown>) {
  const name = pickFirstValue(record, ['nombre', 'producto', 'servicio', 'product', 'name'])
  const category = pickFirstValue(record, ['categoria', 'tipo', 'linea', 'category'])
  const description = pickFirstValue(record, ['descripcion', 'detalle', 'propuesta', 'resumen', 'description'])
  const targetRubro = pickFirstValue(record, ['rubro', 'industria', 'sector', 'vertical', 'rubro_objetivo'])
  const keywords = uniqueStrings([
    ...normalizeTextArray(pickFirstValue(record, ['keywords', 'palabras_clave', 'company_keywords'])),
    ...normalizeTextArray(targetRubro),
  ])
  const painPoints = uniqueStrings([
    ...normalizeTextArray(pickFirstValue(record, ['dolor', 'pain_points', 'senales', 'señales', 'problema'])),
    ...normalizeTextArray(pickFirstValue(record, ['use_case', 'caso_uso'])),
  ])

  return {
    name: name ?? 'Producto Equifax',
    category,
    description,
    target_rubro: targetRubro,
    target_company_keywords: keywords,
    pain_points: painPoints,
    pricing_notes: pickFirstValue(record, ['precio', 'pricing', 'ticket', 'pricing_notes']),
    filters: {},
    raw_payload: record,
  }
}

function sanitizeDocumentText(text: string): string {
  return text
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function buildFallbackProductsFromDocument(text: string, fileName: string): Array<Record<string, unknown>> {
  const sanitizedText = sanitizeDocumentText(text)
  const lines = sanitizedText
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  const sections: Array<{ title: string; body: string[] }> = []

  for (const line of lines) {
    const isHeadingCandidate =
      line.length >= 5 &&
      line.length <= 90 &&
      line.split(/\s+/g).length <= 8 &&
      (
        line === line.toUpperCase() ||
        /^[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ0-9\s\-/:]+$/.test(line)
      )

    if (isHeadingCandidate && sections.length < 8) {
      sections.push({ title: line, body: [] })
      continue
    }

    if (sections.length === 0) continue
    if (sections[sections.length - 1].body.join(' ').length > 420) continue
    sections[sections.length - 1].body.push(line)
  }

  const products = sections
    .filter(section => section.body.length > 0)
    .map(section => ({
      nombre: section.title,
      categoria: 'PDF',
      descripcion: section.body.join(' ').slice(0, 500),
      rubro: null,
      keywords: tokenizeKeywordCandidates([section.title, section.body.join(' ')]).slice(0, 8),
      pain_points: [],
      raw_source_type: 'pdf',
      raw_source_file: fileName,
    }))

  if (products.length > 0) return products

  const baseName = fileName.replace(/\.[^.]+$/, '')
  return [{
    nombre: baseName || 'Producto Equifax desde PDF',
    categoria: 'PDF',
    descripcion: sanitizedText.slice(0, 900),
    rubro: null,
    keywords: tokenizeKeywordCandidates([sanitizedText]).slice(0, 12),
    pain_points: [],
    raw_source_type: 'pdf',
    raw_source_file: fileName,
  }]
}

async function extractProductsFromDocumentWithAI(
  text: string,
  fileName: string
): Promise<Array<Record<string, unknown>>> {
  const sanitizedText = sanitizeDocumentText(text)
  const fallback = buildFallbackProductsFromDocument(sanitizedText, fileName)
  const apiKey = process.env.INCEPTION_API_KEY

  if (!apiKey) return fallback

  const truncatedText = sanitizedText.slice(0, 16000)
  const messages = [
    {
      role: 'system',
      content: `Eres un parser de material comercial de Equifax en Chile.
Devuelve SIEMPRE JSON válido con una lista de productos detectados en un PDF o brochure.
Extrae solo productos o servicios comercializables.
Si hay bundles, planes o variantes, sepáralos cuando tenga sentido comercial.`,
    },
    {
      role: 'user',
      content: `Archivo: ${fileName}

Texto extraído del PDF:
${truncatedText}

Devuelve estrictamente un JSON de este tipo:
{
  "products": [
    {
      "nombre": "string",
      "categoria": "string o null",
      "descripcion": "string o null",
      "rubro": "string o null",
      "keywords": ["kw1", "kw2"],
      "pain_points": ["dolor 1", "dolor 2"],
      "pricing_notes": "string o null"
    }
  ]
}

Si solo detectas un producto general, devuélvelo igual.`,
    },
  ]

  try {
    const response = await fetch(INCEPTION_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: INCEPTION_MODEL,
        messages,
        max_tokens: 1400,
        temperature: 0.1,
      }),
    })

    if (!response.ok) return fallback

    const json = await response.json()
    const content = json?.choices?.[0]?.message?.content ?? ''
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return fallback

    const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]) as {
      products?: Array<Record<string, unknown>>
    }

    const products = Array.isArray(parsed.products)
      ? parsed.products
          .filter(product => typeof product === 'object' && product !== null)
          .map(product => ({
            ...product,
            raw_source_type: 'pdf',
            raw_source_file: fileName,
          }))
      : []

    return products.length > 0 ? products : fallback
  } catch (error) {
    console.error('[extractProductsFromDocumentWithAI]', error)
    return fallback
  }
}

export async function extractEquifaxProductsFromPdf(
  buffer: Buffer,
  fileName: string,
  userId?: string
): Promise<{ inserted: number; items: EquifaxProductCatalogItem[]; extracted_products: number }> {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: buffer })

  try {
    const result = await parser.getText()
    return extractEquifaxProductsFromText(result.text ?? '', fileName, userId)
  } finally {
    await parser.destroy()
  }
}

export async function extractEquifaxProductsFromText(
  text: string,
  fileName: string,
  userId?: string
): Promise<{ inserted: number; items: EquifaxProductCatalogItem[]; extracted_products: number }> {
  const extractedText = sanitizeDocumentText(text)

  if (!extractedText) {
    throw new Error('No se pudo extraer texto útil desde el documento.')
  }

  const products = await extractProductsFromDocumentWithAI(extractedText, fileName)
  const enrichedProducts = products.map(product => ({
    ...product,
    extracted_text_preview: extractedText.slice(0, 2000),
  }))

  const saved = await saveEquifaxProducts(enrichedProducts, userId)
  return {
    ...saved,
    extracted_products: products.length,
  }
}

function buildFallbackProfile(products: ReturnType<typeof normalizeProductRecord>[], prompt?: string | null): ProductProfile {
  const directives = extractPromptDirectives(prompt)
  const productKeywords = tokenizeKeywordCandidates(
    products.flatMap(product => [
      product.name,
      product.category,
      product.description,
      product.target_rubro,
      ...product.target_company_keywords,
      ...product.pain_points,
      prompt ?? null,
    ])
  )

  return {
    include_keywords: productKeywords,
    exclude_keywords: [],
    buyer_signals: uniqueStrings([
      'empresa con datos de contacto disponibles',
      'patrimonio o cobertura superior al promedio',
      'razon social alineada al rubro objetivo',
      ...(directives.sizePreference === 'pyme' ? ['foco en pymes y negocios medianos, evitando grandes corporaciones'] : []),
      ...(prompt ? [prompt] : []),
    ]).slice(0, 8),
    prefer_existing_customers: true,
    size_preference: directives.sizePreference,
    avoid_enterprise_keywords: directives.avoidEnterpriseKeywords,
    weights: {
      contactability: 0.34,
      purchase: 0.3,
      coverage: 0.1,
      existing_customer: 0.12,
      keyword_match: 0.1,
      company_presence: 0.04,
    },
    notes: 'Perfil generado por heurística local debido a falta de respuesta AI o contexto limitado.',
  }
}

function buildScoredUniverseFallbackProfile(prompt?: string | null): ProductProfile {
  const directives = extractPromptDirectives(prompt)
  const promptKeywords = tokenizeKeywordCandidates([prompt ?? null])

  return {
    include_keywords: promptKeywords,
    exclude_keywords: [],
    buyer_signals: uniqueStrings([
      'lead score verde confirmado',
      'contactabilidad alta',
      'propension de compra alta',
      'contacto disponible para gestion comercial',
      ...(prompt ? [prompt] : []),
    ]).slice(0, 8),
    prefer_existing_customers: true,
    size_preference: directives.sizePreference,
    avoid_enterprise_keywords: directives.avoidEnterpriseKeywords,
    weights: {
      contactability: 0.42,
      purchase: 0.26,
      coverage: 0.08,
      existing_customer: 0.08,
      keyword_match: promptKeywords.length > 0 ? 0.08 : 0.02,
      company_presence: 0.08,
    },
    notes: 'Perfil genérico para explotar universo scoreado, aun sin catálogo de productos explícito.',
  }
}

function normalizeAllowedTemperatures(
  value?: Array<'green' | 'yellow' | 'red'> | null
): Array<'green' | 'yellow' | 'red'> {
  const allowed = Array.isArray(value)
    ? value.filter(item => item === 'green' || item === 'yellow' || item === 'red')
    : []

  return allowed.length > 0 ? uniqueStrings(allowed) as Array<'green' | 'yellow' | 'red'> : ['green', 'yellow', 'red']
}

function extractEquifaxFeatureSnapshot(
  equifaxLeadScore?: EquifaxLeadScoreSnapshot
): EquifaxFeatureSnapshot | null {
  const raw = equifaxLeadScore?.score_breakdown?.feature_snapshot
  if (!raw || typeof raw !== 'object') return null

  const snapshot = raw as Record<string, unknown>
  const featurePayload = typeof snapshot.feature_payload === 'object' && snapshot.feature_payload
    ? snapshot.feature_payload as Record<string, unknown>
    : {}

  return {
    company_name: toNullableString(snapshot.company_name),
    region: toNullableString(snapshot.region),
    comuna: toNullableString(snapshot.comuna),
    is_existing_customer: snapshot.is_existing_customer === true,
    known_phone_count: Math.max(0, Number(snapshot.known_phone_count ?? 0)),
    known_email_count: Math.max(0, Number(snapshot.known_email_count ?? 0)),
    best_phone: toNullableString(featurePayload.best_phone),
    best_email: toNullableString(featurePayload.best_email),
    score_patrimonial: Math.max(0, Number(featurePayload.score_patrimonial ?? 0)),
    cobertura_pct: Math.max(0, Number(featurePayload.cobertura_pct ?? 0)),
    n_autos: Math.max(0, Number(featurePayload.n_autos ?? 0)),
    n_bienes_raices: Math.max(0, Number(featurePayload.n_bienes_raices ?? 0)),
  }
}

async function buildCampaignProfileWithAI(
  products: ReturnType<typeof normalizeProductRecord>[],
  topServices: EquifaxCatalogSummary['top_services'],
  prompt?: string | null
): Promise<ProductProfile> {
  const apiKey = process.env.INCEPTION_API_KEY
  const fallback = buildFallbackProfile(products, prompt)
  if (!apiKey) return fallback

  const messages = [
    {
      role: 'system',
      content: `Eres un estratega B2B para ventas de Equifax en Chile.
Devuelve SIEMPRE un JSON válido y compacto.
Debes traducir productos comerciales en una pauta de priorización para scoring masivo sobre una base de empresas.
Si el usuario pide excluir grandes empresas, bancos, holdings o enfocarse en pymes, debes reflejarlo explícitamente.
Los campos weights deben sumar aproximadamente 1.`,
    },
    {
      role: 'user',
      content: `Construye un perfil de targeting para estos productos:

${JSON.stringify(products, null, 2)}

Histórico resumido de servicios vendidos:
${JSON.stringify(topServices, null, 2)}

Contexto adicional del usuario:
${prompt ?? 'sin contexto adicional'}

Devuelve:
{
  "include_keywords": ["keyword1", "keyword2"],
  "exclude_keywords": [],
  "buyer_signals": ["signal1", "signal2"],
  "prefer_existing_customers": true,
  "size_preference": "any | pyme | enterprise",
  "avoid_enterprise_keywords": ["banco", "holding"],
  "weights": {
    "contactability": 0.0,
    "purchase": 0.0,
    "coverage": 0.0,
    "existing_customer": 0.0,
    "keyword_match": 0.0,
    "company_presence": 0.0
  },
  "notes": "explicacion breve"
}`,
    },
  ]

  try {
    const response = await fetch(INCEPTION_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: INCEPTION_MODEL,
        messages,
        max_tokens: 800,
        temperature: 0.2,
      }),
    })

    if (!response.ok) return fallback
    const json = await response.json()
    const content = json?.choices?.[0]?.message?.content ?? ''
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return fallback

    const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]) as Partial<ProductProfile>
    const weights = parsed.weights ?? fallback.weights
    return {
      include_keywords: uniqueStrings((parsed.include_keywords ?? fallback.include_keywords).map(item => normalizeKeyword(item))).filter(Boolean),
      exclude_keywords: uniqueStrings((parsed.exclude_keywords ?? []).map(item => normalizeKeyword(item))).filter(Boolean),
      buyer_signals: uniqueStrings(parsed.buyer_signals ?? fallback.buyer_signals).slice(0, 10),
      prefer_existing_customers: parsed.prefer_existing_customers ?? fallback.prefer_existing_customers,
      size_preference: parsed.size_preference === 'pyme' || parsed.size_preference === 'enterprise'
        ? parsed.size_preference
        : fallback.size_preference,
      avoid_enterprise_keywords: uniqueStrings(
        ((parsed.avoid_enterprise_keywords as string[] | undefined) ?? fallback.avoid_enterprise_keywords)
          .map(item => normalizeKeyword(item))
      ).filter(Boolean),
      weights: {
        contactability: Number(weights.contactability ?? fallback.weights.contactability),
        purchase: Number(weights.purchase ?? fallback.weights.purchase),
        coverage: Number(weights.coverage ?? fallback.weights.coverage),
        existing_customer: Number(weights.existing_customer ?? fallback.weights.existing_customer),
        keyword_match: Number(weights.keyword_match ?? fallback.weights.keyword_match),
        company_presence: Number(weights.company_presence ?? fallback.weights.company_presence),
      },
      notes: String(parsed.notes ?? fallback.notes),
    }
  } catch (error) {
    console.error('[buildCampaignProfileWithAI]', error)
    return fallback
  }
}

function dedupeCandidateCompanies(rows: CandidateCompany[]) {
  const map = new Map<string, CandidateCompany>()

  for (const row of rows) {
    const current = map.get(row.rutid)
    if (!current) {
      map.set(row.rutid, row)
      continue
    }

    const currentCoverage = Number(current.cobertura_pct ?? 0)
    const nextCoverage = Number(row.cobertura_pct ?? 0)
    const currentContacts = Number(Boolean(current.email)) + Number(Boolean(current.fono_cel))
    const nextContacts = Number(Boolean(row.email)) + Number(Boolean(row.fono_cel))
    const currentPatrimonial = Number(current.score_patrimonial ?? 0)
    const nextPatrimonial = Number(row.score_patrimonial ?? 0)

    if (
      nextContacts > currentContacts ||
      nextCoverage > currentCoverage ||
      nextPatrimonial > currentPatrimonial
    ) {
      map.set(row.rutid, row)
    }
  }

  return [...map.values()]
}

async function fetchManagedRutidsFromCallBase(rutids: string[]) {
  const managed = new Set<string>()
  const lookupRutids = uniqueStrings(rutids.flatMap(rutid => rutLookupVariants(rutid)))
  if (lookupRutids.length === 0) return managed

  async function readFeedbackColumn(column: 'rutid' | 'matched_rutid', subset: string[]) {
    for (let from = 0; ; from += FETCH_CHUNK_SIZE) {
      const { data, error } = await db
        .from('contact_center_feedback')
        .select('rutid,matched_rutid')
        .in(column, subset)
        .range(from, from + FETCH_CHUNK_SIZE - 1)

      if (error) {
        console.error(`[fetchManagedRutidsFromCallBase:${column}]`, error)
        throw new Error('No se pudo cruzar contra la base de gestiones del call.')
      }

      const rows = (data ?? []) as Array<{ rutid: string | null; matched_rutid: string | null }>
      for (const row of rows) {
        for (const rutid of rutLookupVariants(row.matched_rutid ?? row.rutid)) {
          managed.add(rutid)
        }
      }

      if (rows.length < FETCH_CHUNK_SIZE) break
    }
  }

  for (let start = 0; start < lookupRutids.length; start += RUT_LOOKUP_CHUNK_SIZE) {
    const subset = lookupRutids.slice(start, start + RUT_LOOKUP_CHUNK_SIZE)
    await Promise.all([
      readFeedbackColumn('rutid', subset),
      readFeedbackColumn('matched_rutid', subset),
    ])
  }

  return managed
}

function hasManagedRutid(managedRutids: Set<string>, rutid: string) {
  return rutLookupVariants(rutid).some(variant => managedRutids.has(variant))
}

async function fetchCandidateCompaniesByRutids(rutids: string[], regions: string[]) {
  const map = new Map<string, CandidateCompany>()
  if (rutids.length === 0) return map

  for (let start = 0; start < rutids.length; start += RUT_LOOKUP_CHUNK_SIZE) {
    let query = db
      .from('master_personas_view')
      .select(`
        rutid,
        razon_social_empresa,
        region_canonica,
        comuna_canonica,
        email,
        fono_cel,
        score_patrimonial,
        cobertura_pct,
        tiene_empresa,
        tiene_autos,
        tiene_bienes_raices,
        n_autos,
        n_bienes_raices
      `)
      .in('rutid', rutids.slice(start, start + RUT_LOOKUP_CHUNK_SIZE))

    if (regions.length > 0) {
      query = query.in('region_canonica', regions)
    }

    const { data, error } = await query
    if (error) {
      console.error('[fetchCandidateCompaniesByRutids]', error)
      throw new Error('No se pudo leer el universo empresarial scoreado.')
    }

    for (const row of (data ?? []) as CandidateCompany[]) {
      map.set(row.rutid, row)
    }
  }

  return map
}

async function fetchScoredUniverseRows(
  limit: number,
  allowedTemperatures: Array<'green' | 'yellow' | 'red'>
) {
  const rows: EquifaxLeadScoreSnapshot[] = []

  for (let start = 0; start < limit; start += FETCH_CHUNK_SIZE) {
    const { data, error } = await db
      .from('equifax_lead_scores')
      .select(`
        rutid,
        model_version,
        model_type,
        contact_probability,
        interest_probability,
        purchase_probability,
        fit_score,
        lead_score,
        lead_temperature,
        recommended_channel,
        recommended_hour,
        reason_tags,
        score_breakdown,
        scored_at
      `)
      .in('lead_temperature', allowedTemperatures)
      .order('lead_score', { ascending: false })
      .range(start, Math.min(start + FETCH_CHUNK_SIZE - 1, limit - 1))

    if (error) {
      console.error('[fetchScoredUniverseRows]', error)
      throw new Error('No se pudo leer el universo scoreado Equifax.')
    }

    const chunk = (data ?? []) as EquifaxLeadScoreSnapshot[]
    rows.push(...chunk)
    if (chunk.length < FETCH_CHUNK_SIZE) break
  }

  return rows.slice(0, limit)
}

async function fetchCandidateCompaniesOrdered(
  sampleSize: number,
  regions: string[],
  orderBy: 'score_patrimonial' | 'cobertura_pct'
) {
  const rows: CandidateCompany[] = []

  for (let start = 0; start < sampleSize; start += FETCH_CHUNK_SIZE) {
    let query = db
      .from('master_personas_view')
      .select(`
        rutid,
        razon_social_empresa,
        region_canonica,
        comuna_canonica,
        email,
        fono_cel,
        score_patrimonial,
        cobertura_pct,
        tiene_empresa,
        tiene_autos,
        tiene_bienes_raices,
        n_autos,
        n_bienes_raices
      `)
      .not('razon_social_empresa', 'is', null)
      .order(orderBy, { ascending: false, nullsFirst: false })
      .range(start, start + FETCH_CHUNK_SIZE - 1)

    if (regions.length > 0) {
      query = query.in('region_canonica', regions)
    }

    const { data, error } = await query
    if (error) {
      console.error('[fetchCandidateCompaniesOrdered]', error)
      throw new Error('No se pudo consultar el universo empresarial.')
    }

    const chunk = (data ?? []) as CandidateCompany[]
    rows.push(...chunk)
    if (chunk.length < FETCH_CHUNK_SIZE) break
  }

  return rows
}

async function fetchExistingCustomerCandidates(limit: number, regions: string[]) {
  const { data: customerRows, error: customerError } = await db
    .from('equifax_sales_company_summary')
    .select('rutid')
    .order('total_amount', { ascending: false })
    .order('last_sale_at', { ascending: false })
    .limit(limit)

  if (customerError) {
    console.error('[fetchExistingCustomerCandidates:summary]', customerError)
    throw new Error('No se pudo consultar clientes Equifax históricos.')
  }

  const rutids = uniqueStrings((customerRows ?? []).map(row => String(row.rutid ?? '')).filter(Boolean))
  const rows: CandidateCompany[] = []

  for (let start = 0; start < rutids.length; start += FETCH_CHUNK_SIZE) {
    let query = db
      .from('master_personas_view')
      .select(`
        rutid,
        razon_social_empresa,
        region_canonica,
        comuna_canonica,
        email,
        fono_cel,
        score_patrimonial,
        cobertura_pct,
        tiene_empresa,
        tiene_autos,
        tiene_bienes_raices,
        n_autos,
        n_bienes_raices
      `)
      .in('rutid', rutids.slice(start, start + FETCH_CHUNK_SIZE))

    if (regions.length > 0) {
      query = query.in('region_canonica', regions)
    }

    const { data, error } = await query
    if (error) {
      console.error('[fetchExistingCustomerCandidates:master]', error)
      throw new Error('No se pudo cruzar clientes Equifax con el universo empresarial.')
    }

    rows.push(...((data ?? []) as CandidateCompany[]))
  }

  return rows
}

async function fetchCandidateCompanies(sampleSize: number, regions: string[], profile: ProductProfile) {
  const [patrimonialRows, coverageRows, existingRows] = await Promise.all([
    fetchCandidateCompaniesOrdered(sampleSize, regions, 'score_patrimonial'),
    fetchCandidateCompaniesOrdered(Math.ceil(sampleSize * 0.6), regions, 'cobertura_pct'),
    fetchExistingCustomerCandidates(Math.min(Math.ceil(sampleSize * 0.2), 8000), regions),
  ])

  return dedupeCandidateCompanies([
    ...existingRows,
    ...patrimonialRows,
    ...coverageRows,
  ])
    .sort((left, right) => {
      const leftScore =
        Number(Boolean(left.email)) * 18 +
        Number(Boolean(left.fono_cel)) * 24 +
        Number(left.cobertura_pct ?? 0) * 0.4 +
        Number(left.score_patrimonial ?? 0) * 0.35 +
        Number(Boolean(left.tiene_empresa)) * 12 -
        scoreEnterprisePenalty(left.razon_social_empresa ?? '', profile) * 0.8

      const rightScore =
        Number(Boolean(right.email)) * 18 +
        Number(Boolean(right.fono_cel)) * 24 +
        Number(right.cobertura_pct ?? 0) * 0.4 +
        Number(right.score_patrimonial ?? 0) * 0.35 +
        Number(Boolean(right.tiene_empresa)) * 12 -
        scoreEnterprisePenalty(right.razon_social_empresa ?? '', profile) * 0.8

      return rightScore - leftScore
    })
    .slice(0, sampleSize)
}

function emitFreshUniverseProgress(
  onProgress: FreshUniverseProgressHandler | undefined,
  progress: EquifaxUniverseProgress
) {
  onProgress?.({
    ...progress,
    percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
  })
}

function mapFreshCompanyCandidate(
  trendRow: FreshCompanyTrendRow,
  scoreRow: PersonaScoreRow | undefined,
  masterRow: FreshMasterPersonaRow | undefined
): CandidateCompany {
  const tramoVentas = toNullableNumber(trendRow.ultimo_tramo_ventas)
  const nAutos = toNullableNumber(masterRow?.n_autos) ?? 0
  const nBienesRaices = toNullableNumber(masterRow?.n_bienes_raices) ?? 0
  const totalAvaluos = toNullableNumber(masterRow?.totalavaluos) ?? 0
  const email = toNullableString(scoreRow?.best_email) ?? toNullableString(masterRow?.email)
  const phone = toNullableString(scoreRow?.best_phone) ?? toNullableString(masterRow?.fono_cel)
  const scorePatrimonial = toNullableNumber(scoreRow?.priority_score)
    ?? (nAutos * 10
      + nBienesRaices * 20
      + Number(Boolean(masterRow?.razon_social_empresa || trendRow.razon_social)) * 15
      + Number(Boolean(email)) * 5
      + Number(Boolean(phone)) * 5)
  const coberturaPct = toNullableNumber(scoreRow?.contactability_score)
    ?? Math.round((
      Number(Boolean(email))
      + Number(Boolean(phone))
      + Number(Boolean(masterRow?.region_part || masterRow?.domicilio_region || trendRow.region))
      + Number(nAutos > 0)
      + Number(nBienesRaices > 0 || totalAvaluos > 0)
      + Number(Boolean(masterRow?.razon_social_empresa || trendRow.razon_social))
    ) / 6 * 100)

  return {
    rutid: String(trendRow.rutid ?? '').trim(),
    razon_social_empresa: toNullableString(trendRow.razon_social) ?? toNullableString(masterRow?.razon_social_empresa),
    region_canonica: toNullableString(trendRow.region) ?? toNullableString(masterRow?.region_part) ?? toNullableString(masterRow?.domicilio_region),
    comuna_canonica: toNullableString(trendRow.comuna) ?? toNullableString(masterRow?.comuna_part) ?? toNullableString(masterRow?.domicilio_comuna),
    email,
    fono_cel: phone,
    score_patrimonial: scorePatrimonial,
    cobertura_pct: coberturaPct,
    tiene_empresa: true,
    tiene_autos: nAutos > 0,
    tiene_bienes_raices: nBienesRaices > 0 || totalAvaluos > 0,
    n_autos: nAutos,
    n_bienes_raices: nBienesRaices,
    source_universe: 'empresas_comercial_unificada',
    segmento_tamano_empresa:
      tramoVentas != null && tramoVentas >= 13
        ? 'corporacion'
        : tramoVentas != null && tramoVentas >= 10
          ? 'gran_empresa'
          : tramoVentas != null && tramoVentas >= 1
            ? 'pyme'
            : 'sin_tramo',
    resultado_tendencia: toNullableString(trendRow.resultado_tendencia),
    rubro_economico: toNullableString(trendRow.rubro_economico_ultimo),
    actividad_economica: toNullableString(trendRow.actividad_economica_ultima),
    es_pyme: tramoVentas != null && tramoVentas >= 1 && tramoVentas <= 9,
    es_corporacion: tramoVentas != null && tramoVentas >= 13,
  }
}

async function fetchPersonaScoreRowsByRutids(client: Client, rutids: string[]) {
  const lookupRutids = uniqueStrings(rutids.flatMap(rutid => rutLookupVariants(rutid)))
  const map = new Map<string, PersonaScoreRow>()
  if (lookupRutids.length === 0) return map

  for (let start = 0; start < lookupRutids.length; start += 5000) {
    const chunk = lookupRutids.slice(start, start + 5000)
    const result = await client.query<PersonaScoreRow>(
      `
        select
          rutid,
          contactability_score,
          purchase_propensity_score,
          priority_score,
          best_phone,
          best_email,
          known_phone_count,
          known_email_count
        from public.persona_scores
        where rutid = any($1::varchar[])
      `,
      [chunk]
    )

    for (const row of result.rows) {
      map.set(row.rutid, row)
    }
  }

  return map
}

async function fetchMasterPersonaRowsByRutids(client: Client, rutids: string[]) {
  const lookupRutids = uniqueStrings(rutids.flatMap(rutid => rutLookupVariants(rutid)))
  const map = new Map<string, FreshMasterPersonaRow>()
  if (lookupRutids.length === 0) return map

  for (let start = 0; start < lookupRutids.length; start += 5000) {
    const chunk = lookupRutids.slice(start, start + 5000)
    const result = await client.query<FreshMasterPersonaRow>(
      `
        select
          rutid,
          email,
          fono_cel,
          region_part,
          comuna_part,
          domicilio_region,
          domicilio_comuna,
          razon_social_empresa,
          n_autos,
          n_bienes_raices,
          totalavaluos
        from public.personas_master
        where rutid = any($1::varchar[])
      `,
      [chunk]
    )

    for (const row of result.rows) {
      map.set(row.rutid, row)
    }
  }

  return map
}

async function fetchFreshCompanyCandidates(
  sampleSize: number,
  regions: string[],
  profile: ProductProfile,
  onProgress?: FreshUniverseProgressHandler
) {
  const rows: CandidateCompany[] = []
  const targetRows = Math.min(sampleSize, MAX_FRESH_COMPANY_CANDIDATES)

  emitFreshUniverseProgress(onProgress, {
    phase: 'starting',
    percent: 1,
    message: 'Preparando lectura de empresas activas 2024.',
    scanned: 0,
    collected: 0,
    target: targetRows,
  })

  await withPostgresClient(async client => {
    for (let start = 0; rows.length < targetRows; start += FRESH_COMPANY_FETCH_CHUNK_SIZE) {
      const params: unknown[] = [FRESH_COMPANY_FETCH_CHUNK_SIZE, start]
      const regionClause = regions.length > 0
        ? `and evt.region_ultima = any($${params.push(regions)}::text[])`
        : ''

      const companyResult = await client.query<FreshCompanyTrendRow>(
        `
          select
            evt.rutid,
            evt.razon_social_ultima as razon_social,
            evt.region_ultima as region,
            evt.comuna_ultima as comuna,
            evt.ultimo_tramo_ventas,
            evt.resultado_tendencia,
            evt.rubro_economico_ultimo,
            evt.actividad_economica_ultima
          from public.empresas_ventas_tendencia evt
          where evt.anio_ultimo = 2024
            and evt.fecha_termino_giro_ultima is null
            and (evt.ultimo_tramo_ventas is null or evt.ultimo_tramo_ventas < 13)
            ${regionClause}
          limit $1 offset $2
        `,
        params
      )

      const chunkRutids = companyResult.rows.map(row => row.rutid)
      const [scoreRows, masterRows] = await Promise.all([
        fetchPersonaScoreRowsByRutids(client, chunkRutids),
        fetchMasterPersonaRowsByRutids(client, chunkRutids),
      ])

      const chunk = companyResult.rows
        .map(row => mapFreshCompanyCandidate(
          row,
          getMapByRutVariants(scoreRows, row.rutid),
          getMapByRutVariants(masterRows, row.rutid)
        ))
        .filter(row => {
          if (!row.rutid || !row.razon_social_empresa) return false
          if (!row.email && !row.fono_cel) return false
          if (row.es_corporacion) return false
          const targetText = [
            row.razon_social_empresa,
            row.rubro_economico,
            row.actividad_economica,
          ].filter(Boolean).join(' ')
          return !detectEquifaxNonTargetCompany(targetText, {
            rutid: row.rutid,
            region: row.region_canonica,
          })
        })

      rows.push(...chunk)
      emitFreshUniverseProgress(onProgress, {
        phase: 'matching_contacts',
        percent: Math.min(72, 8 + (rows.length / Math.max(targetRows, 1)) * 64),
        message: `Leídas ${rows.length.toLocaleString('es-CL')} empresas con contacto útil.`,
        scanned: start + companyResult.rows.length,
        collected: rows.length,
        target: targetRows,
      })

      if (companyResult.rows.length < FRESH_COMPANY_FETCH_CHUNK_SIZE) break
    }
  })

  const deduped = dedupeCandidateCompanies(rows)
  emitFreshUniverseProgress(onProgress, {
    phase: 'excluding_managed',
    percent: 78,
    message: `Cruzando ${deduped.length.toLocaleString('es-CL')} empresas contra call/CRM.`,
    scanned: rows.length,
    collected: deduped.length,
    target: targetRows,
  })
  const managedRutids = await fetchManagedRutidsFromCallBase(deduped.map(row => row.rutid))

  const freshRows = deduped
    .filter(row => !hasManagedRutid(managedRutids, row.rutid))
    .sort((left, right) => {
      const leftScore =
        Number(Boolean(left.email)) * 22 +
        Number(Boolean(left.fono_cel)) * 30 +
        Number(left.es_pyme) * 20 +
        Number(left.resultado_tendencia === 'sube') * 12 +
        Number(left.cobertura_pct ?? 0) * 0.35 +
        Number(left.score_patrimonial ?? 0) * 0.3 -
        scoreEnterprisePenalty(left.razon_social_empresa ?? '', profile) * 0.8

      const rightScore =
        Number(Boolean(right.email)) * 22 +
        Number(Boolean(right.fono_cel)) * 30 +
        Number(right.es_pyme) * 20 +
        Number(right.resultado_tendencia === 'sube') * 12 +
        Number(right.cobertura_pct ?? 0) * 0.35 +
        Number(right.score_patrimonial ?? 0) * 0.3 -
        scoreEnterprisePenalty(right.razon_social_empresa ?? '', profile) * 0.8

      return rightScore - leftScore
    })
    .slice(0, sampleSize)

  emitFreshUniverseProgress(onProgress, {
    phase: 'cleaning',
    percent: 94,
    message: `Quedaron ${freshRows.length.toLocaleString('es-CL')} empresas nuevas limpias.`,
    scanned: rows.length,
    collected: freshRows.length,
    target: targetRows,
  })

  return freshRows
}

async function fetchPersonaScoresMap(rutids: string[]) {
  const map = new Map<string, PersonaScoreRow>()
  if (rutids.length === 0) return map

  for (let start = 0; start < rutids.length; start += RUT_LOOKUP_CHUNK_SIZE) {
    const chunk = rutids.slice(start, start + RUT_LOOKUP_CHUNK_SIZE)
    const { data, error } = await db
      .from('persona_scores')
      .select(`
        rutid,
        contactability_score,
        purchase_propensity_score,
        priority_score,
        best_phone,
        best_email,
        known_phone_count,
        known_email_count
      `)
      .in('rutid', chunk)

    if (error) {
      console.error('[fetchPersonaScoresMap]', error)
      throw new Error('No se pudieron cargar los scores comerciales.')
    }

    for (const row of (data ?? []) as PersonaScoreRow[]) {
      map.set(row.rutid, row)
    }
  }

  return map
}

async function fetchCustomerSummaryMap(rutids: string[]) {
  const map = new Map<string, CustomerSummaryRow>()
  if (rutids.length === 0) return map

  for (let start = 0; start < rutids.length; start += RUT_LOOKUP_CHUNK_SIZE) {
    const chunk = rutids.slice(start, start + RUT_LOOKUP_CHUNK_SIZE)
    const { data, error } = await db
      .from('equifax_sales_company_summary')
      .select('*')
      .in('rutid', chunk)

    if (error) {
      console.error('[fetchCustomerSummaryMap]', error)
      throw new Error('No se pudo cruzar el histórico Equifax.')
    }

    for (const row of (data ?? []) as CustomerSummaryRow[]) {
      map.set(row.rutid, row)
    }
  }

  return map
}

function scoreKeywordMatches(companyName: string, includeKeywords: string[], excludeKeywords: string[]) {
  const normalizedName = normalizeKeyword(companyName)
  let includeHits = 0
  let excludeHits = 0

  for (const keyword of includeKeywords) {
    if (!keyword) continue
    if (normalizedName.includes(keyword)) includeHits += 1
  }

  for (const keyword of excludeKeywords) {
    if (!keyword) continue
    if (normalizedName.includes(keyword)) excludeHits += 1
  }

  return {
    includeHits,
    excludeHits,
    score: clamp(includeHits * 16 - excludeHits * 20, 0, 100),
  }
}

function buildScoredLeadCandidate(params: CandidateSelectionContext): ScoredLeadCandidate | null {
  const {
    candidate,
    aiProfile,
    scoreRow,
    customerSummary,
    equifaxLeadScore,
    includeExistingCustomers,
    minPhoneCount,
    minEmailCount,
  } = params

  const featureSnapshot = extractEquifaxFeatureSnapshot(equifaxLeadScore)
  const companyName = candidate.razon_social_empresa?.trim() || featureSnapshot?.company_name?.trim()
  if (!companyName) return null
  const targetText = [
    companyName,
    candidate.rubro_economico,
    candidate.actividad_economica,
  ].filter(Boolean).join(' ')
  if (
    detectEquifaxNonTargetCompany(targetText, {
      rutid: candidate.rutid,
      region: candidate.region_canonica ?? featureSnapshot?.region ?? null,
    })
  ) return null

  const isExistingCustomer = featureSnapshot?.is_existing_customer ?? Boolean(customerSummary)
  if (!includeExistingCustomers && isExistingCustomer) return null

  const phoneCount = Math.max(
    Number(scoreRow?.known_phone_count ?? featureSnapshot?.known_phone_count ?? 0),
    candidate.fono_cel ? 1 : 0
  )
  const emailCount = Math.max(
    Number(scoreRow?.known_email_count ?? featureSnapshot?.known_email_count ?? 0),
    candidate.email ? 1 : 0
  )

  if (phoneCount < minPhoneCount) return null
  if (emailCount < minEmailCount) return null

  const contactability = clamp(
    Number(
      scoreRow?.contactability_score ??
      phoneCount * 18 +
      emailCount * 10 +
      Number(candidate.cobertura_pct ?? 0) * 0.35
    )
  )

  const purchase = clamp(
    Number(
      scoreRow?.purchase_propensity_score ??
      Number(candidate.score_patrimonial ?? 0) * 0.65 +
      (candidate.tiene_empresa ? 12 : 0) +
      (candidate.tiene_bienes_raices ? 10 : 0) +
      (candidate.tiene_autos ? 6 : 0)
    )
  )

  const contactProbability = round(
    equifaxLeadScore?.contact_probability ?? contactability,
    2
  )
  const interestProbability = round(
    equifaxLeadScore?.interest_probability ??
    clamp(contactability * 0.45 + purchase * 0.2 + (isExistingCustomer ? 12 : 0)),
    2
  )
  const purchaseProbability = round(
    equifaxLeadScore?.purchase_probability ?? purchase,
    2
  )
  const leadScore = round(
    equifaxLeadScore?.lead_score ??
    clamp(contactProbability * 0.45 + interestProbability * 0.25 + purchaseProbability * 0.3),
    2
  )
  const leadTemperature = equifaxLeadScore?.lead_temperature ?? 'red'
  const recommendedChannel = equifaxLeadScore?.recommended_channel ?? (phoneCount > 0 ? 'phone' : emailCount > 0 ? 'email' : null)
  const recommendedHour = equifaxLeadScore?.recommended_hour ?? null

  const keywordMetrics = scoreKeywordMatches(
    companyName,
    aiProfile.include_keywords,
    aiProfile.exclude_keywords
  )

  const enterprisePenalty = scoreEnterprisePenalty(companyName, aiProfile)

  if (keywordMetrics.excludeHits > 0) return null
  if (aiProfile.size_preference === 'pyme' && enterprisePenalty >= 85) return null

  const equifaxFit = clamp(
    keywordMetrics.score * aiProfile.weights.keyword_match +
    (isExistingCustomer
      ? (aiProfile.prefer_existing_customers ? 100 : 0) * aiProfile.weights.existing_customer
      : 30 * aiProfile.weights.existing_customer) +
    (candidate.tiene_empresa ? 100 : 0) * aiProfile.weights.company_presence +
    Number(candidate.cobertura_pct ?? 0) * aiProfile.weights.coverage +
    purchaseProbability * 0.08 +
    interestProbability * 0.05 -
    enterprisePenalty * 0.2
  )

  const priorityScore = clamp(
    contactProbability * aiProfile.weights.contactability +
    purchaseProbability * aiProfile.weights.purchase +
    Number(candidate.cobertura_pct ?? 0) * aiProfile.weights.coverage +
    (isExistingCustomer ? 100 : 20) * aiProfile.weights.existing_customer +
    keywordMetrics.score * aiProfile.weights.keyword_match +
    (candidate.tiene_empresa ? 100 : 0) * aiProfile.weights.company_presence +
    interestProbability * 0.12 +
    leadScore * 0.18 -
    enterprisePenalty * 0.45
  )

  return {
    rutid: candidate.rutid,
    company_name: companyName,
    region: candidate.region_canonica ?? featureSnapshot?.region ?? null,
    comuna: candidate.comuna_canonica ?? featureSnapshot?.comuna ?? null,
    best_phone: scoreRow?.best_phone ?? candidate.fono_cel ?? null,
    best_email: scoreRow?.best_email ?? candidate.email ?? null,
    phone_count: phoneCount,
    email_count: emailCount,
    contactability_score: contactProbability,
    purchase_propensity_score: purchaseProbability,
    equifax_fit_score: round(equifaxFit, 2),
    priority_score: round(priorityScore, 2),
    contact_probability: contactProbability,
    interest_probability: interestProbability,
    purchase_probability: purchaseProbability,
    lead_score: leadScore,
    lead_temperature: leadTemperature,
    recommended_channel: recommendedChannel,
    recommended_hour: recommendedHour,
    base_priority_score: round(priorityScore, 2),
    coverage_score: round(Number(candidate.cobertura_pct ?? 0), 2),
    keyword_hits: keywordMetrics.includeHits,
    is_existing_customer: isExistingCustomer,
    last_equifax_sale_at: customerSummary?.last_sale_at ?? null,
    services_bought: customerSummary?.services_bought ?? [],
    reason_tags: uniqueStrings([
      candidate.source_universe === 'empresas_comercial_unificada' ? 'universo-empresas-activo-2024' : null,
      candidate.source_universe === 'empresas_comercial_unificada' ? 'sin-gestion-call-previa' : null,
      candidate.segmento_tamano_empresa ? `segmento-${candidate.segmento_tamano_empresa}` : null,
      candidate.resultado_tendencia ? `tendencia-${candidate.resultado_tendencia}` : null,
      ...buildLeadReasons({
        phoneCount,
        emailCount,
        isExistingCustomer,
        keywordHits: keywordMetrics.includeHits,
        contactability: contactProbability,
        purchase: purchaseProbability,
        company: candidate,
        customerSummary,
      }),
    ]),
  }
}

function buildLeadReasons(params: {
  phoneCount: number
  emailCount: number
  isExistingCustomer: boolean
  keywordHits: number
  contactability: number
  purchase: number
  company: CandidateCompany
  customerSummary?: CustomerSummaryRow | null
}) {
  const reasons: string[] = []

  if (params.phoneCount > 0) reasons.push(`${params.phoneCount} teléfono(s) disponible(s)`)
  if (params.emailCount > 0) reasons.push(`${params.emailCount} email(s) disponible(s)`)
  if (params.isExistingCustomer) reasons.push('ya compró Equifax')
  if (params.keywordHits > 0) reasons.push('match con rubro/keyword objetivo')
  if (params.contactability >= 70) reasons.push('alta contactabilidad')
  if (params.purchase >= 70) reasons.push('alta propensión de compra')
  if (params.company.tiene_bienes_raices) reasons.push('señal patrimonial por bienes raíces')
  if (params.company.tiene_autos) reasons.push('señal patrimonial por vehículos')
  if (params.customerSummary?.services_bought?.length) {
    reasons.push(`historial en ${params.customerSummary.services_bought.slice(0, 2).join(', ')}`)
  }

  return reasons.slice(0, 6)
}

function dedupeLeadRowsByRutid(rows: EquifaxLeadResultItem[]) {
  const map = new Map<string, EquifaxLeadResultItem>()

  for (const row of rows) {
    const current = map.get(row.rutid)
    if (!current || row.priority_score > current.priority_score) {
      map.set(row.rutid, row)
    }
  }

  return [...map.values()]
}

function buildRunSummary(rows: EquifaxLeadResultItem[]) {
  const avg = (values: number[]) => values.length
    ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 2)
    : 0

  return {
    existing_customers: rows.filter(row => row.is_existing_customer).length,
    prospects: rows.filter(row => !row.is_existing_customer).length,
    avg_priority_score: avg(rows.map(row => row.priority_score)),
    avg_contactability_score: avg(rows.map(row => row.contactability_score)),
    avg_purchase_propensity_score: avg(rows.map(row => row.purchase_propensity_score)),
    avg_equifax_fit_score: avg(rows.map(row => row.equifax_fit_score)),
    green_leads: rows.filter(row => row.lead_temperature === 'green').length,
    yellow_leads: rows.filter(row => row.lead_temperature === 'yellow').length,
    red_leads: rows.filter(row => row.lead_temperature === 'red').length,
  }
}

function countTopValues<T extends string>(values: Array<T | null | undefined>, fallback: T) {
  const counts = new Map<T, number>()

  for (const value of values) {
    const key = value ?? fallback
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
}

export async function previewFreshEquifaxUniverse(
  params: EquifaxLeadGenerationParams,
  onProgress?: FreshUniverseProgressHandler
): Promise<EquifaxUniversePreviewResult> {
  const volume = clamp(Math.round(params.volume || 30000), 1, MAX_GENERATION_VOLUME)
  const regions = uniqueStrings((params.regions ?? []).map(item => item.trim()).filter(Boolean))
  const requestedSampleSize = Number(params.scored_universe_limit ?? 0)
  const sampleSize = Math.min(
    MAX_FRESH_COMPANY_CANDIDATES,
    Math.max(volume * 2, 1000, Number.isFinite(requestedSampleSize) ? requestedSampleSize : 0)
  )
  const candidates = await fetchFreshCompanyCandidates(
    sampleSize,
    regions,
    buildScoredUniverseFallbackProfile(params.prompt),
    onProgress
  )
  const minPhoneCount = Math.max(0, Math.round(params.min_phone_count ?? 1))
  const minEmailCount = Math.max(0, Math.round(params.min_email_count ?? 0))
  const eligible = candidates.filter(candidate => {
    const phoneCount = candidate.fono_cel ? 1 : 0
    const emailCount = candidate.email ? 1 : 0
    return phoneCount >= minPhoneCount && emailCount >= minEmailCount
  })
  const selected = eligible.slice(0, volume)

  const result = {
    requested_volume: volume,
    universe_analyzed: candidates.length,
    eligible_matches: selected.length,
    rules: [
      'Empresas activas 2024',
      'Sin gestión previa en call/CRM',
      'Sin iglesias, corporaciones, fundaciones, gobierno ni educación',
      'Sin corporaciones por tramo',
      `Mínimo ${minPhoneCount} teléfono(s) y ${minEmailCount} email(s)`,
      regions.length ? `Regiones: ${regions.join(', ')}` : 'Todas las regiones',
    ],
    summary: {
      with_phone: selected.filter(row => Boolean(row.fono_cel)).length,
      with_email: selected.filter(row => Boolean(row.email)).length,
      with_phone_and_email: selected.filter(row => Boolean(row.fono_cel) && Boolean(row.email)).length,
      pyme: selected.filter(row => row.es_pyme).length,
      regions: countTopValues(selected.map(row => row.region_canonica), 'Sin region')
        .map(([region, count]) => ({ region, count })),
      segments: countTopValues(selected.map(row => row.segmento_tamano_empresa), 'sin_segmento')
        .map(([segment, count]) => ({ segment, count })),
    },
    sample_rows: selected.slice(0, 12).map(row => ({
      rutid: row.rutid,
      company_name: row.razon_social_empresa ?? 'Sin razon social',
      region: row.region_canonica,
      comuna: row.comuna_canonica,
      phone: row.fono_cel,
      email: row.email,
      segment: row.segmento_tamano_empresa ?? null,
      trend: row.resultado_tendencia ?? null,
    })),
  }

  emitFreshUniverseProgress(onProgress, {
    phase: 'done',
    percent: 100,
    message: `Universo listo: ${selected.length.toLocaleString('es-CL')} registros disponibles.`,
    scanned: candidates.length,
    collected: selected.length,
    target: volume,
  })

  return result
}

function applyScenarioToCandidates(
  candidates: ScoredLeadCandidate[],
  scenario: ScenarioConfig,
  volume: number
) {
  const reranked = candidates
    .map(candidate => ({
      ...candidate,
      priority_score: round(
        clamp(
          candidate.base_priority_score * scenario.weights.base +
          candidate.contactability_score * scenario.weights.contactability +
          candidate.purchase_propensity_score * scenario.weights.purchase +
          candidate.equifax_fit_score * scenario.weights.fit +
          (candidate.is_existing_customer ? 100 : 0) * scenario.weights.existing +
          (!candidate.is_existing_customer ? 100 : 0) * scenario.weights.prospect
        ),
        2
      ),
    }))
    .sort((left, right) => right.priority_score - left.priority_score)

  const selectedRows = dedupeLeadRowsByRutid(reranked).slice(0, volume)
  return {
    selectedRows,
    summary: buildRunSummary(selectedRows),
  }
}

function buildScenarioHighlights(rows: EquifaxLeadResultItem[], requestedVolume: number) {
  const bothContact = rows.filter(row => row.phone_count > 0 && row.email_count > 0).length
  const withPhone = rows.filter(row => row.phone_count > 0).length
  const withEmail = rows.filter(row => row.email_count > 0).length
  const greenLeads = rows.filter(row => row.lead_temperature === 'green').length
  const yellowLeads = rows.filter(row => row.lead_temperature === 'yellow').length
  const redLeads = rows.filter(row => row.lead_temperature === 'red').length
  const regionCounts = new Map<string, number>()
  for (const row of rows) {
    if (!row.region) continue
    regionCounts.set(row.region, (regionCounts.get(row.region) ?? 0) + 1)
  }

  const topRegions = [...regionCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([region, count]) => `${region}: ${count}`)

  return [
    `${rows.length} leads elegibles sobre ${requestedVolume} solicitados`,
    `${bothContact} con teléfono y email · ${withPhone} con teléfono · ${withEmail} con email`,
    `${greenLeads} verdes · ${yellowLeads} amarillos · ${redLeads} rojos`,
    topRegions.length ? `Mayor concentración: ${topRegions.join(' · ')}` : 'Sin preferencia regional dominante',
  ]
}

function scoreScenarioRecommendation(scenario: EquifaxLeadScenario) {
  const fulfillment = scenario.requested_volume > 0
    ? scenario.generated_count / scenario.requested_volume
    : 0

  return (
    scenario.summary.avg_priority_score * 0.4 +
    scenario.summary.avg_contactability_score * 0.25 +
    scenario.summary.avg_purchase_propensity_score * 0.2 +
    scenario.summary.avg_equifax_fit_score * 0.15 +
    fulfillment * 20
  )
}

function resolveScenarioConfig(scenarioKey?: string | null) {
  return EQUFAX_SCENARIOS.find(scenario => scenario.key === scenarioKey) ?? EQUFAX_SCENARIOS[0]
}

function getMapByRutVariants<T>(map: Map<string, T>, rutid: string) {
  for (const variant of rutLookupVariants(rutid)) {
    const value = map.get(variant)
    if (value) return value
  }

  return undefined
}

async function insertRunItemsInChunks(runId: string, rows: EquifaxLeadResultItem[]) {
  for (let start = 0; start < rows.length; start += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + INSERT_CHUNK_SIZE)
    const { error } = await db
      .from('equifax_generation_run_items')
      .insert(chunk.map(row => ({
        run_id: runId,
        rutid: row.rutid,
        company_name: row.company_name,
        region: row.region,
        comuna: row.comuna,
        best_phone: row.best_phone,
        best_email: row.best_email,
        phone_count: row.phone_count,
        email_count: row.email_count,
        contactability_score: row.contactability_score,
        purchase_propensity_score: row.purchase_propensity_score,
        equifax_fit_score: row.equifax_fit_score,
        priority_score: row.priority_score,
        contact_probability: row.contact_probability,
        interest_probability: row.interest_probability,
        purchase_probability: row.purchase_probability,
        lead_score: row.lead_score,
        lead_temperature: row.lead_temperature,
        recommended_channel: row.recommended_channel,
        recommended_hour: row.recommended_hour,
        is_existing_customer: row.is_existing_customer,
        last_equifax_sale_at: row.last_equifax_sale_at,
        services_bought: row.services_bought,
        reason_tags: row.reason_tags,
        export_payload: row,
      })))

    if (error) {
      console.error('[insertRunItemsInChunks]', error)
      throw new Error('No se pudieron guardar los leads generados.')
    }
  }
}

export async function importEquifaxSalesRows(rows: ImportedSaleRow[]): Promise<EquifaxSalesImportResult> {
  if (!hasSupabaseAdminEnv) {
    throw new Error('Falta configurar las credenciales administrativas de Supabase.')
  }

  if (!rows.length) {
    return { inserted: 0, updated: 0, total_rows: 0, sheets: [] }
  }

  const { data, error } = await db
    .from('equifax_sales_history')
    .upsert(rows, { onConflict: 'source_file,source_sheet,source_row_number' })
    .select('id')

  if (error) {
    console.error('[importEquifaxSalesRows]', error)
    throw new Error('No se pudo guardar el histórico de ventas Equifax.')
  }

  return {
    inserted: data?.length ?? rows.length,
    updated: 0,
    total_rows: rows.length,
    sheets: uniqueStrings(rows.map(row => row.source_sheet)),
  }
}

export async function getEquifaxCatalogSummary(): Promise<EquifaxCatalogSummary> {
  const [salesRes, productsRes] = await Promise.all([
    db
      .from('equifax_sales_history')
      .select('rutid,sale_kind,servicio,valor,fecha_venta'),
    db
      .from('equifax_product_catalog')
      .select('id', { count: 'exact', head: false })
      .eq('is_active', true),
  ])

  if (salesRes.error) {
    console.error('[getEquifaxCatalogSummary:sales]', salesRes.error)
    throw new Error('No se pudo leer el histórico Equifax.')
  }

  if (productsRes.error) {
    console.error('[getEquifaxCatalogSummary:products]', productsRes.error)
    throw new Error('No se pudo leer el catálogo Equifax.')
  }

  const sales = (salesRes.data ?? []) as Array<{
    rutid: string | null
    sale_kind: string | null
    servicio: string | null
    valor: number | null
    fecha_venta: string | null
  }>

  const byService = new Map<string, { count: number; total_amount: number }>()
  let recurrentSales = 0
  let oneTimeSales = 0
  let lastSaleAt: string | null = null
  let totalAmount = 0
  const customers = new Set<string>()

  for (const sale of sales) {
    if (sale.rutid) customers.add(sale.rutid)
    if (sale.sale_kind === 'recurrente') recurrentSales += 1
    if (sale.sale_kind === 'one_time') oneTimeSales += 1
    totalAmount += Number(sale.valor ?? 0)

    if (sale.fecha_venta && (!lastSaleAt || sale.fecha_venta > lastSaleAt)) {
      lastSaleAt = sale.fecha_venta
    }

    const service = sale.servicio ?? 'Sin servicio'
    const current = byService.get(service) ?? { count: 0, total_amount: 0 }
    current.count += 1
    current.total_amount += Number(sale.valor ?? 0)
    byService.set(service, current)
  }

  return {
    total_sales: sales.length,
    total_customers: customers.size,
    recurrent_sales: recurrentSales,
    one_time_sales: oneTimeSales,
    total_products: productsRes.count ?? 0,
    last_sale_at: lastSaleAt,
    top_services: [...byService.entries()]
      .map(([service, metrics]) => ({
        service,
        count: metrics.count,
        total_amount: round(metrics.total_amount, 2),
      }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 6),
  }
}

export async function getEquifaxProductCatalog(): Promise<EquifaxProductCatalogItem[]> {
  const { data, error } = await db
    .from('equifax_product_catalog')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[getEquifaxProductCatalog]', error)
    throw new Error('No se pudo leer el catálogo de productos.')
  }

  return (data ?? []) as EquifaxProductCatalogItem[]
}

export async function saveEquifaxProducts(
  records: Array<Record<string, unknown>>,
  userId?: string
): Promise<{ inserted: number; items: EquifaxProductCatalogItem[] }> {
  if (!records.length) {
    return { inserted: 0, items: [] }
  }

  const rows = records.map(record => {
    const normalized = normalizeProductRecord(record)
    return {
      ...normalized,
      created_by: userId ?? null,
      is_active: true,
    }
  })

  const { data, error } = await db
    .from('equifax_product_catalog')
    .insert(rows)
    .select('*')

  if (error) {
    console.error('[saveEquifaxProducts]', error)
    throw new Error('No se pudo guardar el catálogo de productos.')
  }

  return {
    inserted: data?.length ?? rows.length,
    items: (data ?? []) as EquifaxProductCatalogItem[],
  }
}

async function prepareEquifaxCandidates(
  params: EquifaxLeadGenerationParams
): Promise<PreparedEquifaxCandidates> {
  const volume = clamp(Math.round(params.volume || 1000), 1, MAX_GENERATION_VOLUME)
  const isGreenOnlyScenario = params.scenario_key === 'solo_verdes'
  const universeSource =
    params.universe_source === 'scored_universe' || isGreenOnlyScenario
      ? 'scored_universe'
      : params.universe_source === 'fresh_companies'
        ? 'fresh_companies'
      : params.universe_source === 'sampled_master'
        ? 'sampled_master'
        : 'fresh_companies'
  const includeExistingCustomers = params.include_existing_customers !== false
  const minPhoneCount = Math.max(0, Math.round(params.min_phone_count ?? 1))
  const minEmailCount = Math.max(0, Math.round(params.min_email_count ?? 0))
  const regions = uniqueStrings((params.regions ?? []).map(item => item.trim()).filter(Boolean))
  const allowedTemperatures: Array<'green' | 'yellow' | 'red'> = isGreenOnlyScenario
    ? ['green']
    : normalizeAllowedTemperatures(params.allowed_temperatures)
  const scoredUniverseLimit = Math.min(
    MAX_CANDIDATES,
    Math.max(
      volume,
      Math.round(params.scored_universe_limit ?? Math.max(Math.ceil(volume * 1.6), MIN_SCORED_UNIVERSE_SAMPLE))
    )
  )

  const shouldUseActiveCatalogByDefault =
    (universeSource === 'scored_universe' || universeSource === 'fresh_companies') &&
    !(params.product_ids?.length)
  const storedProducts = params.product_ids?.length
    ? await db
        .from('equifax_product_catalog')
        .select('*')
        .in('id', params.product_ids)
        .eq('is_active', true)
    : shouldUseActiveCatalogByDefault
      ? await db
          .from('equifax_product_catalog')
          .select('*')
          .eq('is_active', true)
      : { data: [], error: null }

  if (storedProducts.error) {
    console.error('[generateEquifaxLeads:storedProducts]', storedProducts.error)
    throw new Error('No se pudieron leer los productos seleccionados.')
  }

  const normalizedTransient = (params.transient_products ?? []).map(record => normalizeProductRecord(record))
  const normalizedStored = ((storedProducts.data ?? []) as EquifaxProductCatalogItem[]).map(item => ({
    name: item.name,
    category: item.category,
    description: item.description,
    target_rubro: item.target_rubro,
    target_company_keywords: item.target_company_keywords ?? [],
    pain_points: item.pain_points ?? [],
    pricing_notes: item.pricing_notes,
    filters: item.filters ?? {},
    raw_payload: item.raw_payload ?? {},
  }))

  const products = [...normalizedStored, ...normalizedTransient]
  if (!products.length && universeSource !== 'scored_universe' && universeSource !== 'fresh_companies') {
    throw new Error('Debes subir o seleccionar al menos un producto para generar leads.')
  }

  const aiProfile = products.length
    ? await buildCampaignProfileWithAI(products, (await getEquifaxCatalogSummary()).top_services, params.prompt)
    : buildScoredUniverseFallbackProfile(params.prompt)

  const ranked: ScoredLeadCandidate[] = []
  let universeAnalyzed = 0

  if (universeSource === 'scored_universe') {
    const scoredUniverseRows = await fetchScoredUniverseRows(scoredUniverseLimit, allowedTemperatures)
    universeAnalyzed = scoredUniverseRows.length

    for (const equifaxLeadScore of scoredUniverseRows) {
      const featureSnapshot = extractEquifaxFeatureSnapshot(equifaxLeadScore)
      const candidate = {
        rutid: equifaxLeadScore.rutid,
        razon_social_empresa: featureSnapshot?.company_name ?? null,
        region_canonica: featureSnapshot?.region ?? null,
        comuna_canonica: featureSnapshot?.comuna ?? null,
        email: featureSnapshot?.best_email ?? null,
        fono_cel: featureSnapshot?.best_phone ?? null,
        score_patrimonial: featureSnapshot?.score_patrimonial ?? null,
        cobertura_pct: featureSnapshot?.cobertura_pct ?? null,
        tiene_empresa: true,
        tiene_autos: (featureSnapshot?.n_autos ?? 0) > 0,
        tiene_bienes_raices: (featureSnapshot?.n_bienes_raices ?? 0) > 0,
        n_autos: featureSnapshot?.n_autos ?? null,
        n_bienes_raices: featureSnapshot?.n_bienes_raices ?? null,
      }

      const rankedCandidate = buildScoredLeadCandidate({
        candidate,
        aiProfile,
        equifaxLeadScore,
        includeExistingCustomers,
        minPhoneCount,
        minEmailCount,
      })

      if (rankedCandidate) ranked.push(rankedCandidate)
    }
  } else if (universeSource === 'fresh_companies') {
    const requestedSampleSize = Number(params.scored_universe_limit ?? 0)
    const sampleSize = Math.min(
      MAX_FRESH_COMPANY_CANDIDATES,
      Math.max(volume * 3, 1000, Number.isFinite(requestedSampleSize) ? requestedSampleSize : 0)
    )
    const candidates = await fetchFreshCompanyCandidates(sampleSize, regions, aiProfile)
    const candidateRutids = candidates.map(row => row.rutid)
    const scoreLookupRutids = uniqueStrings(candidateRutids.flatMap(rutid => rutLookupVariants(rutid)))
    const [scoresMap, customerMap, equifaxScoreMap] = await Promise.all([
      fetchPersonaScoresMap(scoreLookupRutids),
      fetchCustomerSummaryMap(scoreLookupRutids),
      getEquifaxLeadScoresMap(scoreLookupRutids, { refreshIfMissing: false }),
    ])

    universeAnalyzed = candidates.length

    for (const candidate of candidates) {
      const rankedCandidate = buildScoredLeadCandidate({
        candidate,
        aiProfile,
        scoreRow: getMapByRutVariants(scoresMap, candidate.rutid),
        customerSummary: getMapByRutVariants(customerMap, candidate.rutid),
        equifaxLeadScore: getMapByRutVariants(equifaxScoreMap, candidate.rutid),
        includeExistingCustomers,
        minPhoneCount,
        minEmailCount,
      })

      if (rankedCandidate) ranked.push(rankedCandidate)
    }
  } else {
    const sampleSize = Math.min(MAX_CANDIDATES, Math.max(volume * 8, 12000))
    const candidates = await fetchCandidateCompanies(sampleSize, regions, aiProfile)
    const candidateRutids = candidates.map(row => row.rutid)
    const [scoresMap, customerMap, equifaxScoreMap] = await Promise.all([
      fetchPersonaScoresMap(candidateRutids),
      fetchCustomerSummaryMap(candidateRutids),
      getEquifaxLeadScoresMap(candidateRutids),
    ])

    universeAnalyzed = candidates.length

    for (const candidate of candidates) {
      const rankedCandidate = buildScoredLeadCandidate({
        candidate,
        aiProfile,
        scoreRow: scoresMap.get(candidate.rutid),
        customerSummary: customerMap.get(candidate.rutid),
        equifaxLeadScore: equifaxScoreMap.get(candidate.rutid),
        includeExistingCustomers,
        minPhoneCount,
        minEmailCount,
      })

      if (rankedCandidate) ranked.push(rankedCandidate)
    }
  }

  ranked.sort((left, right) => right.base_priority_score - left.base_priority_score)

  return {
    volume,
    aiProfile,
    candidates: ranked,
    universeAnalyzed,
    eligibleMatches: ranked.length,
    universeSource,
  }
}

export async function previewEquifaxLeadScenarios(
  params: EquifaxLeadGenerationParams
): Promise<EquifaxLeadPreviewResult> {
  const prepared = await prepareEquifaxCandidates(params)
  let greenPrepared = prepared

  if (params.scenario_key !== 'solo_verdes') {
    try {
      greenPrepared = await prepareEquifaxCandidates({
        ...params,
        scenario_key: 'solo_verdes',
        universe_source: 'scored_universe',
        allowed_temperatures: ['green'],
      })
    } catch (error) {
      console.warn('[previewEquifaxLeadScenarios:greenPrepared]', error instanceof Error ? error.message : error)
    }
  }

  const scenarios = EQUFAX_SCENARIOS.map<EquifaxLeadScenario>(scenario => {
    const sourcePrepared = scenario.key === 'solo_verdes' && greenPrepared.universeSource === 'scored_universe'
      ? greenPrepared
      : prepared
    const applied = applyScenarioToCandidates(sourcePrepared.candidates, scenario, sourcePrepared.volume)
    return {
      key: scenario.key,
      title: scenario.title,
      description: scenario.description,
      recommendation: scenario.recommendation,
      generated_count: applied.selectedRows.length,
      requested_volume: sourcePrepared.volume,
      summary: applied.summary,
      highlights: buildScenarioHighlights(applied.selectedRows, sourcePrepared.volume),
      sample_rows: applied.selectedRows.slice(0, 12),
    }
  })

  const recommendedScenario = [...scenarios]
    .sort((left, right) => scoreScenarioRecommendation(right) - scoreScenarioRecommendation(left))[0]

  return {
    requested_volume: prepared.volume,
    universe_analyzed: prepared.universeAnalyzed,
    eligible_matches: prepared.eligibleMatches,
    recommended_scenario_key: recommendedScenario?.key ?? EQUFAX_SCENARIOS[0].key,
    universe_source: prepared.universeSource,
    ai_profile: prepared.aiProfile as Record<string, unknown>,
    scenarios,
  }
}

export async function generateEquifaxLeads(
  params: EquifaxLeadGenerationParams,
  userId?: string
): Promise<EquifaxLeadGenerationResult> {
  const prepared = await prepareEquifaxCandidates(params)
  const includeExistingCustomers = params.include_existing_customers !== false
  const minPhoneCount = Math.max(0, Math.round(params.min_phone_count ?? 1))
  const minEmailCount = Math.max(0, Math.round(params.min_email_count ?? 0))
  const regions = uniqueStrings((params.regions ?? []).map(item => item.trim()).filter(Boolean))
  const allowedTemperatures: Array<'green' | 'yellow' | 'red'> = params.scenario_key === 'solo_verdes'
    ? ['green']
    : normalizeAllowedTemperatures(params.allowed_temperatures)
  const scenario = resolveScenarioConfig(params.scenario_key)
  const applied = applyScenarioToCandidates(prepared.candidates, scenario, prepared.volume)
  const selectedRows = applied.selectedRows

  const { data: runData, error: runError } = await db
    .from('equifax_generation_runs')
    .insert({
      requested_volume: prepared.volume,
      include_existing_customers: includeExistingCustomers,
      minimum_phone_count: minPhoneCount,
      minimum_email_count: minEmailCount,
      product_catalog_ids: params.product_ids ?? [],
      product_payload: {
        source: 'equifax-bdd',
        scenario_key: scenario.key,
        scenario_title: scenario.title,
        transient_products: params.transient_products ?? [],
      },
      filter_payload: {
        regions,
        universe_source: prepared.universeSource,
        allowed_temperatures: allowedTemperatures,
        scored_universe_limit: params.scored_universe_limit ?? null,
      },
      ai_profile: {
        ...prepared.aiProfile,
        selected_scenario_key: scenario.key,
        selected_scenario_title: scenario.title,
        universe_source: prepared.universeSource,
        allowed_temperatures: allowedTemperatures,
      },
      summary: applied.summary,
      created_by: userId ?? null,
    })
    .select('id')
    .single()

  if (runError || !runData) {
    console.error('[generateEquifaxLeads:run]', runError)
    throw new Error('No se pudo registrar la corrida de leads.')
  }

  const runId = String(runData.id)

  if (selectedRows.length > 0) {
    try {
      await insertRunItemsInChunks(runId, selectedRows)
    } catch (error) {
      await db
        .from('equifax_generation_runs')
        .delete()
        .eq('id', runId)

      throw error
    }
  }

  return {
    run_id: runId,
    scenario_key: scenario.key,
    scenario_title: scenario.title,
    universe_source: prepared.universeSource,
    generated_count: selectedRows.length,
    requested_volume: prepared.volume,
    ai_profile: {
      ...prepared.aiProfile,
      selected_scenario_key: scenario.key,
      selected_scenario_title: scenario.title,
      universe_source: prepared.universeSource,
      allowed_temperatures: allowedTemperatures,
    } as Record<string, unknown>,
    summary: applied.summary,
    rows: selectedRows,
  }
}

export function toImportedSaleRow(input: {
  sourceFile: string
  sourceSheet: string
  rowNumber: number
  saleKind: 'recurrente' | 'one_time'
  row: Record<string, unknown>
}): ImportedSaleRow {
  return {
    source_file: input.sourceFile,
    source_sheet: input.sourceSheet,
    source_row_number: input.rowNumber,
    sale_kind: input.saleKind,
    mes: toIsoDate(input.row.MES, true),
    rut_raw: toNullableString(input.row.RUT),
    rutid: normalizeRutForDb(toNullableString(input.row.RUT)),
    cliente: toNullableString(input.row.CLIENTE),
    fecha_venta: toIsoDate(input.row.FECHA),
    ejecutiva: toNullableString(input.row.EJECUTIVA),
    origen: toNullableString(input.row.ORIGEN),
    servicio: toNullableString(input.row.SERVICIO),
    servicio_normalized: serviceSlug(toNullableString(input.row.SERVICIO)),
    valor: toNullableNumber(input.row.VALOR),
    periodo: toNullableNumber(input.row.PERIODO),
    metadata: {
      mes_raw: input.row.MES ?? null,
    },
  }
}
