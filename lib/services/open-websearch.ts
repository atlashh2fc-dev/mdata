import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 25000
const DEFAULT_SEARCH_ENGINES = ['startpage', 'duckduckgo', 'brave']
let openWebSearchRuntime: {
  services: {
    search: {
      execute(args: {
        query: string
        limit: number
        engines: string[]
        searchMode?: 'request' | 'auto' | 'playwright'
      }): Promise<SearchEnvelopeData>
    }
    fetchWeb: {
      execute(args: {
        url: string
        maxChars: number
        readability?: boolean
        includeLinks?: boolean
      }): Promise<FetchEnvelopeData>
    }
  }
} | null = null

export type OpenWebSearchResult = {
  title: string
  url: string
  description: string
  source: string | null
  engine: string | null
}

export type OpenWebSearchFetchResult = {
  url: string
  finalUrl: string | null
  title: string | null
  content: string
  excerpt: string | null
  siteName: string | null
  retrievalMethod: string | null
  truncated: boolean
}

type OpenWebSearchEnvelope<T> = {
  status: 'ok' | 'error'
  data: T | null
  error?: { code?: string; message?: string } | null
  hint?: string | null
}

type SearchEnvelopeData = {
  query?: string
  engines?: string[]
  totalResults?: number
  results?: Array<{
    title?: string
    url?: string
    description?: string
    source?: string
    engine?: string
  }>
  partialFailures?: unknown[]
}

type FetchEnvelopeData = {
  url?: string
  finalUrl?: string
  title?: string
  content?: string
  excerpt?: string
  siteName?: string
  retrievalMethod?: string
  truncated?: boolean
}

function readPositiveIntEnv(name: string, fallback: number, max: number): number {
  const raw = process.env[name]
  const parsed = raw ? Number.parseInt(raw, 10) : fallback
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, max)
}

function parseEngines(): string[] {
  const raw = process.env.OPEN_WEBSEARCH_SEARCH_ENGINES
  const values = raw
    ? raw.split(',').map(item => item.trim()).filter(Boolean)
    : DEFAULT_SEARCH_ENGINES

  return values.length > 0 ? values : DEFAULT_SEARCH_ENGINES
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&#x27;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/')
}

function parseJsonEnvelope<T>(raw: string): OpenWebSearchEnvelope<T> {
  const trimmed = raw.trim()
  const start = trimmed.indexOf('{')

  if (start < 0) {
    throw new Error('open-websearch did not return JSON output')
  }

  let depth = 0
  let inString = false
  let escaping = false

  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index]

    if (escaping) {
      escaping = false
      continue
    }

    if (char === '\\') {
      escaping = inString
      continue
    }

    if (char === '"') {
      inString = !inString
      continue
    }

    if (inString) continue

    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return JSON.parse(trimmed.slice(start, index + 1)) as OpenWebSearchEnvelope<T>
      }
    }
  }

  throw new Error('open-websearch returned incomplete JSON output')
}

async function postDaemon<T>(
  path: '/search' | '/fetch-web',
  body: Record<string, unknown>
): Promise<OpenWebSearchEnvelope<T> | null> {
  const baseUrl = process.env.OPEN_WEBSEARCH_DAEMON_URL
  if (!baseUrl) return null

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    readPositiveIntEnv('OPEN_WEBSEARCH_DAEMON_TIMEOUT_MS', 12000, 60000)
  )

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    return await response.json() as OpenWebSearchEnvelope<T>
  } finally {
    clearTimeout(timeout)
  }
}

async function runCli<T>(args: string[]): Promise<OpenWebSearchEnvelope<T>> {
  const timeout = readPositiveIntEnv('OPEN_WEBSEARCH_CLI_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 120000)
  const { stdout, stderr } = await execFileAsync(
    'npx',
    ['open-websearch', ...args, '--json'],
    {
      cwd: process.cwd(),
      timeout,
      maxBuffer: 1024 * 1024 * 8,
      env: {
        ...process.env,
        OPEN_WEBSEARCH_QUIET_STARTUP: 'true',
        SEARCH_MODE: process.env.OPEN_WEBSEARCH_SEARCH_MODE ?? 'request',
      },
    }
  )

  return parseJsonEnvelope<T>(`${stdout}\n${stderr}`)
}

async function withMutedOpenWebSearchLogs<T>(work: () => Promise<T>): Promise<T> {
  if (process.env.OPEN_WEBSEARCH_VERBOSE === 'true') {
    return work()
  }

  const originalError = console.error
  const originalWarn = console.warn
  console.error = () => {}
  console.warn = () => {}

  try {
    return await work()
  } finally {
    console.error = originalError
    console.warn = originalWarn
  }
}

async function getOpenWebSearchRuntime() {
  if (!openWebSearchRuntime) {
    await withMutedOpenWebSearchLogs(async () => {
      const mod = await import('open-websearch/build/runtime/createRuntime.js')
      openWebSearchRuntime = mod.createOpenWebSearchRuntime()
    })
  }

  return openWebSearchRuntime as NonNullable<typeof openWebSearchRuntime>
}

function assertOk<T>(envelope: OpenWebSearchEnvelope<T>, action: string): T {
  if (envelope.status === 'ok' && envelope.data) return envelope.data
  const message = envelope.error?.message ?? envelope.hint ?? `${action} failed`
  throw new Error(`open-websearch ${action} failed: ${message}`)
}

export async function searchWithOpenWebSearch(
  query: string,
  options: { limit?: number; engines?: string[] } = {}
): Promise<OpenWebSearchResult[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 10, 50))
  const engines = options.engines?.length ? options.engines : parseEngines()
  const body = { query, limit, engines }
  const envelope = await postDaemon<SearchEnvelopeData>('/search', body)
  const data = envelope
    ? assertOk(envelope, 'search')
    : process.env.OPEN_WEBSEARCH_USE_CLI === 'true'
      ? assertOk(await runCli<SearchEnvelopeData>([
      'search',
      query,
      '--limit',
      String(limit),
      '--engines',
      engines.join(','),
    ]), 'search')
      : await withMutedOpenWebSearchLogs(async () => (await getOpenWebSearchRuntime()).services.search.execute({
        query,
        limit,
        engines,
        searchMode: (process.env.OPEN_WEBSEARCH_SEARCH_MODE as 'request' | 'auto' | 'playwright' | undefined) ?? 'request',
      }))

  return (data.results ?? [])
    .map(item => ({
      title: stripHtml(decodeHtmlEntities(item.title ?? '')),
      url: item.url ?? '',
      description: stripHtml(decodeHtmlEntities(item.description ?? '')),
      source: item.source ?? null,
      engine: item.engine ?? null,
    }))
    .filter(item => item.url)
}

export async function fetchWithOpenWebSearch(
  url: string,
  options: { maxChars?: number; readability?: boolean; includeLinks?: boolean } = {}
): Promise<OpenWebSearchFetchResult> {
  const maxChars = Math.max(1000, Math.min(options.maxChars ?? 30000, 200000))
  const body = {
    url,
    maxChars,
    readability: options.readability ?? true,
    includeLinks: options.includeLinks ?? false,
  }
  const envelope = await postDaemon<FetchEnvelopeData>('/fetch-web', body)
  const data = envelope
    ? assertOk(envelope, 'fetch-web')
    : process.env.OPEN_WEBSEARCH_USE_CLI === 'true'
      ? assertOk(await runCli<FetchEnvelopeData>([
      'fetch-web',
      url,
      '--max-chars',
      String(maxChars),
      ...(body.readability ? ['--readability'] : []),
      ...(body.includeLinks ? ['--include-links'] : []),
    ]), 'fetch-web')
      : await withMutedOpenWebSearchLogs(async () => (await getOpenWebSearchRuntime()).services.fetchWeb.execute(body))

  return {
    url: data.url ?? url,
    finalUrl: data.finalUrl ?? null,
    title: data.title ?? null,
    content: data.content ?? '',
    excerpt: data.excerpt ?? null,
    siteName: data.siteName ?? null,
    retrievalMethod: data.retrievalMethod ?? null,
    truncated: Boolean(data.truncated),
  }
}
