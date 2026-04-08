'use server'

import { search, SafeSearchType } from 'duck-duck-scrape'
import { db, hasSupabaseAdminEnv } from '@/lib/db/supabase'
import { normalizeCompanyName } from '@/lib/utils/company-match'

const INCEPTION_API_URL = 'https://api.inceptionlabs.ai/v1/chat/completions'
const INCEPTION_MODEL = 'mercury-2'
const SEARCH_RESULTS_PER_COMPANY = 5
const FETCH_RESULTS_PER_COMPANY = 3
const MAX_FETCH_CHARS = 12000
const MAX_COMPANIES_PER_REQUEST = 15
const ENRICH_CONCURRENCY = 2

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
  source: 'cache' | 'web' | 'web_ai' | 'none' | 'error'
  searchProvider?: 'brave' | 'duckduckgo' | 'bing' | 'none' | 'error'
}

type SearchResultItem = {
  title: string
  url: string
  description: string
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/')
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeObfuscatedText(value: string): string {
  return value
    .replace(/\s*\[\s*at\s*\]\s*/gi, '@')
    .replace(/\s*\(\s*at\s*\)\s*/gi, '@')
    .replace(/\s+arroba\s+/gi, '@')
    .replace(/\s*\[\s*dot\s*\]\s*/gi, '.')
    .replace(/\s*\(\s*dot\s*\)\s*/gi, '.')
    .replace(/\s+punto\s+/gi, '.')
}

function extractEmails(text: string): string[] {
  const normalized = normalizeObfuscatedText(text)
  const matches = normalized.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []
  return uniq(matches)
    .filter(email => !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(email))
    .slice(0, 10)
}

function extractEmailsFromHtml(html: string): string[] {
  const mailtoMatches = [...html.matchAll(/mailto:([^"'?#>\s]+)/gi)]
    .map(match => decodeHtmlEntities(match[1] ?? ''))

  return uniq([
    ...mailtoMatches,
    ...extractEmails(html),
    ...extractEmails(stripHtml(html)),
  ]).slice(0, 10)
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

function extractPhonesFromHtml(html: string): string[] {
  return uniq([
    ...extractPhones(html),
    ...extractPhones(stripHtml(html)),
  ]).slice(0, 10)
}

function isBlockedDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
    return [
      'facebook.com',
      'instagram.com',
      'linkedin.com',
      'x.com',
      'twitter.com',
      'youtube.com',
      'tiktok.com',
      'mercadolibre.cl',
      'mercadolibre.com',
      'duckduckgo.com',
      'bing.com',
    ].some(domain => host === domain || host.endsWith(`.${domain}`))
  } catch {
    return true
  }
}

function normalizeSearchUrl(url: string): string | null {
  const trimmed = decodeHtmlEntities(url).trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

function scoreSearchResult(result: SearchResultItem, companyName: string): number {
  let score = 0
  const text = `${result.title} ${result.description}`.toLowerCase()
  const normalizedCompany = companyName.toLowerCase()

  if (text.includes(normalizedCompany)) score += 6
  if (/contact|contacto|telefono|email|correo/.test(text)) score += 3
  if (/oficial|sitio oficial/.test(text)) score += 2

  try {
    const url = new URL(result.url)
    const path = url.pathname.toLowerCase()
    if (path === '/' || path === '') score += 2
    if (/contact|contacto|empresa|nosotros/.test(path)) score += 2
  } catch {}

  return score
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

async function searchWithBrave(query: string): Promise<SearchResultItem[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY
  if (!apiKey) return []

  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({
      q: query,
      count: String(Math.max(SEARCH_RESULTS_PER_COMPANY, 10)),
      country: 'CL',
      search_lang: 'es',
      spellcheck: '1',
      extra_snippets: 'true',
    })}`,
    {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    }
  )

  if (!response.ok) {
    throw new Error(`Brave search failed with status ${response.status}`)
  }

  const data = await response.json()
  const results = Array.isArray(data?.web?.results) ? data.web.results : []

  return results
    .map((item: {
      title?: string
      url?: string
      description?: string
      extra_snippets?: string[]
    }) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      description: [item.description, ...(item.extra_snippets ?? [])]
        .filter(Boolean)
        .join(' '),
    }))
    .filter(item => item.url && !isBlockedDomain(item.url))
}

async function searchWithBing(query: string): Promise<SearchResultItem[]> {
  const response = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10&setlang=es-CL`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; RUT-Intelligence/1.0; +https://rut-intelligence.local)',
    },
  })

  if (!response.ok) {
    throw new Error(`Bing search failed with status ${response.status}`)
  }

  const html = await response.text()
  const matches = [...html.matchAll(/<li class="b_algo"[\s\S]*?<a href="([^"]+)"[\s\S]*?>([\s\S]*?)<\/a>[\s\S]*?(?:<p>([\s\S]*?)<\/p>)?/gi)]

  return matches
    .map(match => ({
      url: normalizeSearchUrl(match[1] ?? '') ?? '',
      title: stripHtml(decodeHtmlEntities(match[2] ?? '')),
      description: stripHtml(decodeHtmlEntities(match[3] ?? '')),
    }))
    .filter(item => item.url && !isBlockedDomain(item.url))
}

async function searchCompanyResults(companyName: string): Promise<{
  results: SearchResultItem[]
  provider: 'brave' | 'duckduckgo' | 'bing' | 'none'
}> {
  const queries = [
    `"${companyName}" sitio oficial contacto`,
    `${companyName} contacto email telefono sitio oficial chile`,
    `"${companyName}" contacto`,
  ]

  const collected: SearchResultItem[] = []
  const seen = new Set<string>()

  let winningProvider: 'brave' | 'duckduckgo' | 'bing' | 'none' = 'none'

  for (const query of queries) {
    let results: SearchResultItem[] = []

    try {
      results = await searchWithBrave(query)
      if (results.length > 0) winningProvider = 'brave'
    } catch (error) {
      console.error('[company-contact-enrichment:brave]', {
        companyName,
        query,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    if (results.length === 0) {
      try {
        const ddg = await search(query, { safeSearch: SafeSearchType.OFF })
        results = ddg.results.map(item => ({
          title: item.title,
          url: item.url,
          description: item.description,
        }))
        if (results.length > 0) winningProvider = 'duckduckgo'
      } catch (error) {
        console.error('[company-contact-enrichment:duckduckgo]', {
          companyName,
          query,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (results.length === 0) {
      try {
        results = await searchWithBing(query)
        if (results.length > 0) winningProvider = 'bing'
      } catch (error) {
        console.error('[company-contact-enrichment:bing]', {
          companyName,
          query,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    for (const result of results) {
      const normalizedUrl = normalizeSearchUrl(result.url)
      if (!normalizedUrl || seen.has(normalizedUrl) || isBlockedDomain(normalizedUrl)) continue
      seen.add(normalizedUrl)
      collected.push({ ...result, url: normalizedUrl })
    }

    if (collected.length >= SEARCH_RESULTS_PER_COMPANY) break
  }

  return {
    results: collected
      .sort((left, right) => scoreSearchResult(right, companyName) - scoreSearchResult(left, companyName))
      .slice(0, SEARCH_RESULTS_PER_COMPANY),
    provider: collected.length > 0 ? winningProvider : 'none',
  }
}

async function fetchPageHtml(url: string): Promise<string> {
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

    return (await res.text()).slice(0, MAX_FETCH_CHARS * 2)
  } catch {
    return ''
  } finally {
    clearTimeout(timeout)
  }
}

function buildContactPageCandidates(url: string, html: string): string[] {
  let base: URL

  try {
    base = new URL(url)
  } catch {
    return []
  }

  const hrefMatches = [...html.matchAll(/href=["']([^"'#]+)["']/gi)]
    .map(match => match[1] ?? '')

  const commonPaths = [
    '/contacto',
    '/contact',
    '/contact-us',
    '/empresa/contacto',
    '/nosotros',
  ]

  return uniq([...hrefMatches, ...commonPaths].flatMap(candidate => {
    try {
      const resolved = new URL(candidate, base)
      const path = resolved.pathname.toLowerCase()
      if (!/contact|contacto|empresa|nosotros/.test(path)) return []
      return [resolved.toString()]
    } catch {
      return []
    }
  })).slice(0, FETCH_RESULTS_PER_COMPANY)
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

  const rows = items
    .filter(item => item.source !== 'error')
    .map(item => ({
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

  if (rows.length === 0) return

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
  try {
    const searchResults = await searchCompanyResults(companyName)
    const topResults = searchResults.results

    const snippets = topResults.map(item => `${item.title}\n${item.url}\n${item.description}`)
    const sourceUrls = uniq(topResults.map(item => item.url)).slice(0, FETCH_RESULTS_PER_COMPANY)

    let emails = uniq(topResults.flatMap(item => extractEmails(`${item.title} ${item.description}`)))
    let phones = uniq(topResults.flatMap(item => extractPhones(`${item.title} ${item.description}`)))

    for (const url of sourceUrls) {
      const html = await fetchPageHtml(url)
      if (!html) continue

      emails = uniq([...emails, ...extractEmailsFromHtml(html)])
      phones = uniq([...phones, ...extractPhonesFromHtml(html)])

      const contactUrls = buildContactPageCandidates(url, html)
      for (const contactUrl of contactUrls) {
        const contactHtml = await fetchPageHtml(contactUrl)
        if (!contactHtml) continue

        emails = uniq([...emails, ...extractEmailsFromHtml(contactHtml)])
        phones = uniq([...phones, ...extractPhonesFromHtml(contactHtml)])
      }
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
      searchProvider: searchResults.provider,
    }
  } catch (error) {
    console.error('[company-contact-enrichment:search]', {
      companyName,
      rutid: rutid ?? null,
      error: error instanceof Error ? error.message : String(error),
    })

    return {
      matchKey,
      rutid: rutid ?? null,
      companyName,
      website: null,
      emails: [],
      phones: [],
      sourceUrls: [],
      source: 'error',
      searchProvider: 'error',
    }
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
  providers: {
    brave: number
    duckduckgo: number
    bing: number
    none: number
    error: number
  }
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

  const providers = {
    brave: fetched.filter(item => item.searchProvider === 'brave').length,
    duckduckgo: fetched.filter(item => item.searchProvider === 'duckduckgo').length,
    bing: fetched.filter(item => item.searchProvider === 'bing').length,
    none: fetched.filter(item => item.searchProvider === 'none').length,
    error: fetched.filter(item => item.searchProvider === 'error').length,
  }

  return {
    items,
    candidates: uniqueCompanies.length,
    attempted: toProcess.length,
    fromCache: cached.size,
    limited: missing.length > toProcess.length,
    withoutResult: fetched.filter(
      item => item.emails.length === 0 && item.phones.length === 0
    ).length,
    providers,
  }
}
