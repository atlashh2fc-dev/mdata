import { fetchWithOpenWebSearch, searchWithOpenWebSearch } from '@/lib/services/open-websearch'

const MAX_RESULTS_PER_BOOK = 8
const TARGET_RESULTS_BEFORE_STOP = 4
const MAX_FETCH_RESULTS_PER_BOOK = 3
const MAX_FETCH_CHARS = 12000

export type BookSearchInput = {
  title: string
  author?: string | null
  isbn?: string | null
  publisher?: string | null
  year?: string | number | null
}

export type BookWebEvidence = {
  title: string
  url: string
  description: string
  source: string | null
  engine: string | null
  score: number
  fetched: boolean
  fetchedTitle?: string | null
  excerpt?: string | null
  contentSample?: string
  detectedIsbns: string[]
}

export type BookWebEnrichment = {
  input: BookSearchInput
  queries: string[]
  results: BookWebEvidence[]
  bestSources: string[]
  detectedIsbns: string[]
  status: 'found' | 'not_found' | 'error'
  error?: string
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function compactText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function normalizeIsbn(value: string): string {
  return value.replace(/[^0-9X]/gi, '').toUpperCase()
}

function extractIsbns(text: string): string[] {
  const matches = text.match(/(?:ISBN(?:-1[03])?:?\s*)?(97[89][-\s]?)?\d[-\s]?\d{2,5}[-\s]?\d{2,7}[-\s]?[\dX]/gi) ?? []
  return uniq(matches.map(normalizeIsbn).filter(value => value.length === 10 || value.length === 13))
}

function buildBookQueries(input: BookSearchInput): string[] {
  const title = compactText(input.title)
  const author = compactText(input.author)
  const isbn = compactText(input.isbn)
  const publisher = compactText(input.publisher)
  const year = compactText(input.year)

  return uniq([
    isbn ? `"${isbn}" book metadata` : '',
    isbn ? `"${isbn}" Open Library Google Books` : '',
    title && author ? `"${title}" "${author}" book` : '',
    title && author ? `"${title}" "${author}" Open Library` : '',
    title && publisher ? `"${title}" "${publisher}" ${year}` : '',
    title ? `"${title}" site:openlibrary.org` : '',
    title ? `"${title}" site:books.google.com` : '',
  ]).slice(0, 6)
}

function scoreBookResult(result: { title: string; url: string; description: string }, input: BookSearchInput): number {
  const text = `${result.title} ${result.description} ${result.url}`.toLowerCase()
  const title = compactText(input.title).toLowerCase()
  const author = compactText(input.author).toLowerCase()
  const isbn = normalizeIsbn(compactText(input.isbn))
  let score = 0

  if (title && text.includes(title)) score += 8
  if (author && text.includes(author)) score += 5
  if (isbn && normalizeIsbn(text).includes(isbn)) score += 8
  if (/openlibrary\.org|books\.google\./.test(text)) score += 5
  if (/worldcat\.org|archive\.org|goodreads\.com|overdrive\.com/.test(text)) score += 2
  if (/pdf|download|drive\.google|vk\.com|torrent/.test(text)) score -= 5

  return score
}

function sourceFromUrl(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export async function enrichBookWithOpenWebSearch(input: BookSearchInput): Promise<BookWebEnrichment> {
  const queries = buildBookQueries(input)
  const seen = new Set<string>()
  const collected: BookWebEvidence[] = []

  try {
    for (const query of queries) {
      const results = await searchWithOpenWebSearch(query, { limit: MAX_RESULTS_PER_BOOK })

      for (const result of results) {
        if (seen.has(result.url)) continue
        seen.add(result.url)

        const evidenceText = `${result.title} ${result.description} ${result.url}`
        collected.push({
          title: result.title,
          url: result.url,
          description: result.description,
          source: result.source,
          engine: result.engine,
          score: scoreBookResult(result, input),
          fetched: false,
          detectedIsbns: extractIsbns(evidenceText),
        })
      }

      if (collected.length >= TARGET_RESULTS_BEFORE_STOP) break
    }

    const ranked = collected
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_RESULTS_PER_BOOK)

    for (const item of ranked.slice(0, MAX_FETCH_RESULTS_PER_BOOK)) {
      try {
        const fetched = await fetchWithOpenWebSearch(item.url, {
          maxChars: MAX_FETCH_CHARS,
          readability: true,
        })
        const content = compactText(fetched.content)
        item.fetched = true
        item.fetchedTitle = fetched.title
        item.excerpt = fetched.excerpt
        item.contentSample = content.slice(0, 1000)
        item.detectedIsbns = uniq([
          ...item.detectedIsbns,
          ...extractIsbns(`${fetched.title ?? ''} ${fetched.excerpt ?? ''} ${content}`),
        ])
      } catch {}
    }

    return {
      input,
      queries,
      results: ranked,
      bestSources: uniq(ranked.slice(0, 5).map(item => item.source ?? sourceFromUrl(item.url))),
      detectedIsbns: uniq(ranked.flatMap(item => item.detectedIsbns)),
      status: ranked.length > 0 ? 'found' : 'not_found',
    }
  } catch (error) {
    return {
      input,
      queries,
      results: collected,
      bestSources: [],
      detectedIsbns: uniq(collected.flatMap(item => item.detectedIsbns)),
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
