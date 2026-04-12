import { db, hasSupabaseAdminEnv } from '@/lib/db/supabase'
import { cleanRut } from '@/lib/utils/rut'
import type {
  EquifaxCatalogSummary,
  EquifaxLeadGenerationParams,
  EquifaxLeadPreviewResult,
  EquifaxLeadGenerationResult,
  EquifaxLeadResultItem,
  EquifaxLeadScenario,
  EquifaxProductCatalogItem,
  EquifaxSalesImportResult,
} from '@/types/equifax'

const INCEPTION_API_URL = 'https://api.inceptionlabs.ai/v1/chat/completions'
const INCEPTION_MODEL = 'mercury-2'
const FETCH_CHUNK_SIZE = 1000
const MAX_CANDIDATES = 60000
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
}

type PromptDirectives = {
  sizePreference: 'any' | 'pyme' | 'enterprise'
  avoidEnterpriseKeywords: string[]
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
]

function normalizeRutForDb(value: string | null | undefined): string | null {
  if (!value) return null
  const cleaned = cleanRut(value)
  if (cleaned.length < 2) return null
  return cleaned.padStart(10, '0')
}

function normalizeKeyword(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
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

async function fetchPersonaScoresMap(rutids: string[]) {
  const map = new Map<string, PersonaScoreRow>()
  if (rutids.length === 0) return map

  for (let start = 0; start < rutids.length; start += FETCH_CHUNK_SIZE) {
    const chunk = rutids.slice(start, start + FETCH_CHUNK_SIZE)
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

  for (let start = 0; start < rutids.length; start += FETCH_CHUNK_SIZE) {
    const chunk = rutids.slice(start, start + FETCH_CHUNK_SIZE)
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
  }
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
  const volume = clamp(Math.round(params.volume || 1000), 1, 10000)
  const includeExistingCustomers = params.include_existing_customers !== false
  const minPhoneCount = Math.max(0, Math.round(params.min_phone_count ?? 1))
  const minEmailCount = Math.max(0, Math.round(params.min_email_count ?? 0))
  const regions = uniqueStrings((params.regions ?? []).map(item => item.trim()).filter(Boolean))

  const storedProducts = params.product_ids?.length
    ? await db
        .from('equifax_product_catalog')
        .select('*')
        .in('id', params.product_ids)
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
  if (!products.length) {
    throw new Error('Debes subir o seleccionar al menos un producto para generar leads.')
  }

  const summary = await getEquifaxCatalogSummary()
  const aiProfile = await buildCampaignProfileWithAI(products, summary.top_services, params.prompt)
  const sampleSize = Math.min(MAX_CANDIDATES, Math.max(volume * 8, 12000))

  const candidates = await fetchCandidateCompanies(sampleSize, regions, aiProfile)
  const candidateRutids = candidates.map(row => row.rutid)
  const [scoresMap, customerMap] = await Promise.all([
    fetchPersonaScoresMap(candidateRutids),
    fetchCustomerSummaryMap(candidateRutids),
  ])

  const ranked: ScoredLeadCandidate[] = []

  for (const candidate of candidates) {
    const companyName = candidate.razon_social_empresa?.trim()
    if (!companyName) continue

    const scoreRow = scoresMap.get(candidate.rutid)
    const customerSummary = customerMap.get(candidate.rutid)
    const isExistingCustomer = Boolean(customerSummary)
    if (!includeExistingCustomers && isExistingCustomer) continue

    const phoneCount = Math.max(
      Number(scoreRow?.known_phone_count ?? 0),
      candidate.fono_cel ? 1 : 0
    )
    const emailCount = Math.max(
      Number(scoreRow?.known_email_count ?? 0),
      candidate.email ? 1 : 0
    )

    if (phoneCount < minPhoneCount) continue
    if (emailCount < minEmailCount) continue

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

    const keywordMetrics = scoreKeywordMatches(
      companyName,
      aiProfile.include_keywords,
      aiProfile.exclude_keywords
    )

    const enterprisePenalty = scoreEnterprisePenalty(companyName, aiProfile)

    if (keywordMetrics.excludeHits > 0) continue
    if (aiProfile.size_preference === 'pyme' && enterprisePenalty >= 85) continue

    const equifaxFit = clamp(
      keywordMetrics.score * aiProfile.weights.keyword_match +
      (isExistingCustomer
        ? (aiProfile.prefer_existing_customers ? 100 : 0) * aiProfile.weights.existing_customer
        : 30 * aiProfile.weights.existing_customer) +
      (candidate.tiene_empresa ? 100 : 0) * aiProfile.weights.company_presence +
      Number(candidate.cobertura_pct ?? 0) * aiProfile.weights.coverage -
      enterprisePenalty * 0.2
    )

    const priorityScore = clamp(
      contactability * aiProfile.weights.contactability +
      purchase * aiProfile.weights.purchase +
      Number(candidate.cobertura_pct ?? 0) * aiProfile.weights.coverage +
      (isExistingCustomer ? 100 : 20) * aiProfile.weights.existing_customer +
      keywordMetrics.score * aiProfile.weights.keyword_match +
      (candidate.tiene_empresa ? 100 : 0) * aiProfile.weights.company_presence -
      enterprisePenalty * 0.45
    )

    ranked.push({
      rutid: candidate.rutid,
      company_name: companyName,
      region: candidate.region_canonica,
      comuna: candidate.comuna_canonica,
      best_phone: scoreRow?.best_phone ?? candidate.fono_cel ?? null,
      best_email: scoreRow?.best_email ?? candidate.email ?? null,
      phone_count: phoneCount,
      email_count: emailCount,
      contactability_score: round(contactability, 2),
      purchase_propensity_score: round(purchase, 2),
      equifax_fit_score: round(equifaxFit, 2),
      priority_score: round(priorityScore, 2),
      base_priority_score: round(priorityScore, 2),
      coverage_score: round(Number(candidate.cobertura_pct ?? 0), 2),
      keyword_hits: keywordMetrics.includeHits,
      is_existing_customer: isExistingCustomer,
      last_equifax_sale_at: customerSummary?.last_sale_at ?? null,
      services_bought: customerSummary?.services_bought ?? [],
      reason_tags: buildLeadReasons({
        phoneCount,
        emailCount,
        isExistingCustomer,
        keywordHits: keywordMetrics.includeHits,
        contactability,
        purchase,
        company: candidate,
        customerSummary,
      }),
    })
  }

  ranked.sort((left, right) => right.base_priority_score - left.base_priority_score)

  return {
    volume,
    aiProfile,
    candidates: ranked,
    universeAnalyzed: candidates.length,
    eligibleMatches: ranked.length,
  }
}

export async function previewEquifaxLeadScenarios(
  params: EquifaxLeadGenerationParams
): Promise<EquifaxLeadPreviewResult> {
  const prepared = await prepareEquifaxCandidates(params)

  const scenarios = EQUFAX_SCENARIOS.map<EquifaxLeadScenario>(scenario => {
    const applied = applyScenarioToCandidates(prepared.candidates, scenario, prepared.volume)
    return {
      key: scenario.key,
      title: scenario.title,
      description: scenario.description,
      recommendation: scenario.recommendation,
      generated_count: applied.selectedRows.length,
      requested_volume: prepared.volume,
      summary: applied.summary,
      highlights: buildScenarioHighlights(applied.selectedRows, prepared.volume),
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
      filter_payload: { regions },
      ai_profile: {
        ...prepared.aiProfile,
        selected_scenario_key: scenario.key,
        selected_scenario_title: scenario.title,
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
    generated_count: selectedRows.length,
    requested_volume: prepared.volume,
    ai_profile: {
      ...prepared.aiProfile,
      selected_scenario_key: scenario.key,
      selected_scenario_title: scenario.title,
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
