'use server'

import { search, SafeSearchType } from 'duck-duck-scrape'
import { db, hasSupabaseAdminEnv } from '@/lib/db/supabase'
import { normalizeCompanyName } from '@/lib/utils/company-match'

const INCEPTION_API_URL = 'https://api.inceptionlabs.ai/v1/chat/completions'
const INCEPTION_MODEL = 'mercury-2'
const SEARCH_RESULTS_PER_COMPANY = 5
const FETCH_RESULTS_PER_COMPANY = 3
const MAX_FETCH_CHARS = 12000
const MAX_COMPANIES_PER_REQUEST = 25
const ENRICH_CONCURRENCY = 3

type CacheRow = {
  match_key: string
  rutid: string | null
  company_name: string
  website: string | null
  emails: string[] | null
  phones: string[] | null
  source_urls: string[] | null
  enrichment_status: string | null
}

export type CompanyContactEnrichment = {
  matchKey: string
  rutid?: string | null
  companyName: string
  website: string | null
  emails: string[]
  phones: string[]
  sourceUrls: string[]
  source: 'cache' | 'web' | 'web_ai' | 'none'
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function extractEmails(text: string): string[] {
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []
  return uniq(matches)
    .filter(email => !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(email))
    .slice(0, 10)
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '')
  const normalized = digits.startsWith('+') ? `+${digits.slice(1).replace(/\D/g, '')}` : digits.replace(/\D/g, '')

  if (normalized.length < 8) return null
  if (normalized.startsWith('56') && normalized.length >= 11) return `+${normalized}`
  if (normalized.length === 9 && normalized.startsWith('9')) return `+56${normalized}`
  if (normalized.length === 8) return `+562${normalized}`
  if (normalized.startsWith('+56') && normalized.length >= 11) return normalized
  return normalized.length <= 14 ? normalized : null
}

function extractPhones(text: string): string[] {
  const matches = text.match(/(?:\+?56)?[\s().-]*\d(?:[\s().-]*\d){7,10}/g) ?? []
  return uniq(matches.map(match => normalizePhone(match)).filter(Boolean) as string[]).slice(0, 10)
}

function scoreEmail(email: string, website: string | null): number {
  let score = 0
  if (/^(contacto|ventas|comercial|info|hola|hello|admin)@/i.test(email)) score += 3
  if (website) {
    try {
      const host = new URL(website).hostname.replace(/^www\./, '')
      if (email.toLowerCase().endsWith(`@${host}`)) score += 5
    } catch {}
  }
  if (/gmail\.com|hotmail\.com|yahoo\./i.test(email)) score -= 1
  return score
}

function scorePhone(phone: string): number {
  let score = 0
  if (phone.startsWith('+569')) score += 4
  if (phone.startsWith('+562')) score += 3
  if (phone.startsWith('+56')) score += 2
  return score
}

function pickBest(values: string[], scorer: (value: string) => number): string | null {
  if (values.length === 0) return null
  return [...values].sort((a, b) => scorer(b) - scorer(a))[0] ?? null
}

async function fetchPageText(url: string): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RUT-Intelligence/1.0; +https://rut-intelligence.local)',
      },
      signal: controller.signal,
    })

    const contentType = res.headers.get('content-type') ?? ''
    if (!res.ok || !contentType.includes('text/html')) return ''

    const html = await res.text()
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, MAX_FETCH_CHARS)
  } catch {
    return ''
  } finally {
    clearTimeout(timeout)
  }
}

async function chooseBestWithAI(
  companyName: string,
  candidates: {
    websites: string[]
    emails: string[]
    phones: string[]
    snippets: string[]
  }
): Promise<{ website: string | null; email: string | null; phone: string | null } | null> {
  const apiKey = process.env.INCEPTION_API_KEY
  if (!apiKey) return null

  try {
    const response = await fetch(INCEPTION_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: INCEPTION_MODEL,
        max_tokens: 250,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: 'Elige el mejor sitio web, email y telefono de contacto para una empresa chilena. Devuelve solo JSON valido.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              company_name: companyName,
              candidates,
              expected_json: {
                website: 'string|null',
                email: 'string|null',
                phone: 'string|null',
              },
            }),
          },
        ],
      }),
    })

    if (!response.ok) return null
    const json = await response.json()
    const content = json.choices?.[0]?.message?.content ?? ''
    const match = content.match(/\{[\s\S]*\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0])
    return {
      website: typeof parsed.website === 'string' ? parsed.website : null,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      phone: typeof parsed.phone === 'string' ? parsed.phone : null,
    }
  } catch {
    return null
  }
}

async function readCache(matchKeys: string[]): Promise<Map<string, CompanyContactEnrichment>> {
  const byKey = new Map<string, CompanyContactEnrichment>()
  if (!hasSupabaseAdminEnv || matchKeys.length === 0) return byKey

  const { data, error } = await db
    .from('company_contact_enrichment_cache')
    .select('match_key,rutid,company_name,website,emails,phones,source_urls,enrichment_status')
    .in('match_key', matchKeys)

  if (error) {
    console.error('[company-contact-cache:read]', error)
    return byKey
  }

  for (const row of (data ?? []) as CacheRow[]) {
    byKey.set(row.match_key, {
      matchKey: row.match_key,
      rutid: row.rutid,
      companyName: row.company_name,
      website: row.website,
      emails: row.emails ?? [],
      phones: row.phones ?? [],
      sourceUrls: row.source_urls ?? [],
      source: row.enrichment_status === 'none' ? 'none' : 'cache',
    })
  }

  return byKey
}

async function writeCache(items: CompanyContactEnrichment[]) {
  if (!hasSupabaseAdminEnv || items.length === 0) return

  const rows = items.map(item => ({
    match_key: item.matchKey,
    rutid: item.rutid ?? null,
    company_name: item.companyName,
    website: item.website,
    emails: item.emails,
    phones: item.phones,
    source_urls: item.sourceUrls,
    enrichment_status: item.source === 'none' ? 'none' : item.source,
    searched_at: new Date().toISOString(),
  }))

  const { error } = await db
    .from('company_contact_enrichment_cache')
    .upsert(rows, { onConflict: 'match_key' })

  if (error) {
    console.error('[company-contact-cache:write]', error)
  }
}

async function persistIntoMaster(items: CompanyContactEnrichment[]) {
  if (!hasSupabaseAdminEnv || items.length === 0) return

  for (const item of items) {
    if (!item.rutid) continue

    const bestEmail = item.emails[0] ?? null
    const bestPhone = item.phones[0] ?? null
    if (!bestEmail && !bestPhone) continue

    const { data: existing, error: readError } = await db
      .from('personas_master')
      .select('rutid,email,fono_cel,razon_social_empresa')
      .eq('rutid', item.rutid)
      .maybeSingle()

    if (readError) {
      console.error('[company-contact-master:read]', readError)
      continue
    }

    const payload: Record<string, string | boolean> = {}
    if (!existing?.email && bestEmail) payload.email = bestEmail
    if (!existing?.fono_cel && bestPhone) payload.fono_cel = bestPhone
    if (!existing?.razon_social_empresa && item.companyName) {
      payload.razon_social_empresa = item.companyName
      payload.tiene_empresa = true
    }

    if (Object.keys(payload).length === 0) continue

    const { error: upsertError } = await db
      .from('personas_master')
      .upsert({ rutid: item.rutid, ...payload }, { onConflict: 'rutid' })

    if (upsertError) {
      console.error('[company-contact-master:write]', upsertError)
    }
  }
}

async function enrichOneCompany(
  companyName: string,
  rutid?: string | null
): Promise<CompanyContactEnrichment> {
  const matchKey = normalizeCompanyName(companyName)
  const searchQuery = `${companyName} contacto telefono email sitio oficial chile`
  const result = await search(searchQuery, { safeSearch: SafeSearchType.OFF })
  const topResults = result.results.slice(0, SEARCH_RESULTS_PER_COMPANY)

  const snippets = topResults.map(item => `${item.title}\n${item.url}\n${item.description}`)
  const sourceUrls = uniq(topResults.map(item => item.url)).slice(0, FETCH_RESULTS_PER_COMPANY)

  let emails = uniq(topResults.flatMap(item => extractEmails(`${item.title} ${item.description}`)))
  let phones = uniq(topResults.flatMap(item => extractPhones(`${item.title} ${item.description}`)))

  for (const url of sourceUrls) {
    const pageText = await fetchPageText(url)
    emails = uniq([...emails, ...extractEmails(pageText)])
    phones = uniq([...phones, ...extractPhones(pageText)])
  }

  const aiPick = await chooseBestWithAI(companyName, {
    websites: sourceUrls,
    emails,
    phones,
    snippets,
  })

  const bestWebsite = aiPick?.website && sourceUrls.includes(aiPick.website)
    ? aiPick.website
    : sourceUrls[0] ?? null
  const bestEmail = aiPick?.email && emails.includes(aiPick.email)
    ? aiPick.email
    : pickBest(emails, email => scoreEmail(email, bestWebsite))
  const bestPhone = aiPick?.phone && phones.includes(aiPick.phone)
    ? aiPick.phone
    : pickBest(phones, scorePhone)

  return {
    matchKey,
    rutid: rutid ?? null,
    companyName,
    website: bestWebsite,
    emails: bestEmail ? [bestEmail, ...emails.filter(item => item !== bestEmail)] : emails,
    phones: bestPhone ? [bestPhone, ...phones.filter(item => item !== bestPhone)] : phones,
    sourceUrls,
    source: aiPick ? 'web_ai' : (emails.length > 0 || phones.length > 0 || bestWebsite ? 'web' : 'none'),
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let index = 0

  async function run() {
    while (index < items.length) {
      const current = items[index]
      index += 1
      results.push(await worker(current))
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()))
  return results
}

export async function enrichCompanyContacts(
  companies: { companyName: string; rutid?: string | null }[]
): Promise<{
  items: Map<string, CompanyContactEnrichment>
  candidates: number
  attempted: number
  fromCache: number
  limited: boolean
  withoutResult: number
}> {
  const normalizedCompanies = companies
    .map(item => ({
      companyName: item.companyName.trim(),
      rutid: item.rutid ?? null,
      matchKey: normalizeCompanyName(item.companyName),
    }))
    .filter(item => item.matchKey)

  const uniqueCompanies = [...new Map(
    normalizedCompanies.map(item => [item.matchKey, item])
  ).values()]

  const cached = await readCache(uniqueCompanies.map(item => item.matchKey))
  const missing = uniqueCompanies.filter(item => !cached.has(item.matchKey))
  const toProcess = missing.slice(0, MAX_COMPANIES_PER_REQUEST)

  const fetched = await mapWithConcurrency(
    toProcess,
    ENRICH_CONCURRENCY,
    async item => enrichOneCompany(item.companyName, item.rutid)
  )

  const items = new Map<string, CompanyContactEnrichment>()

  for (const company of uniqueCompanies) {
    const cachedItem = cached.get(company.matchKey)
    if (!cachedItem) continue

    items.set(company.matchKey, {
      ...cachedItem,
      rutid: company.rutid ?? cachedItem.rutid ?? null,
      companyName: company.companyName || cachedItem.companyName,
    })
  }

  for (const item of fetched) {
    items.set(item.matchKey, item)
  }

  const resolvedItems = [...items.values()]

  await writeCache(fetched)
  await persistIntoMaster(resolvedItems)

  return {
    items,
    candidates: uniqueCompanies.length,
    attempted: toProcess.length,
    fromCache: cached.size,
    limited: missing.length > toProcess.length,
    withoutResult: fetched.filter(
      item => item.emails.length === 0 && item.phones.length === 0
    ).length,
  }
}
