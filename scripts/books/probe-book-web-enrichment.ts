export {}

import fs from 'node:fs/promises'
import path from 'node:path'
import {
  enrichBookWithOpenWebSearch,
  type BookSearchInput,
  type BookWebEnrichment,
} from '@/lib/services/book-web-enrichment'

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.local')

function parseArgs(argv: string[]) {
  const read = (name: string) => argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=')

  return {
    title: read('title'),
    author: read('author'),
    isbn: read('isbn'),
    publisher: read('publisher'),
    year: read('year'),
    output: read('output') ?? 'outputs/book-web-enrichment-probe.json',
  }
}

function defaultBooks(): BookSearchInput[] {
  return [
    {
      title: 'Harry Potter and the Sorcerer\'s Stone',
      author: 'J. K. Rowling',
      isbn: '9780439708180',
      publisher: 'Scholastic',
      year: 1999,
    },
    {
      title: 'The Pragmatic Programmer',
      author: 'Andrew Hunt David Thomas',
      isbn: '9780201616224',
      publisher: 'Addison-Wesley',
      year: 1999,
    },
  ]
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const books: BookSearchInput[] = args.title
    ? [{
        title: args.title,
        author: args.author,
        isbn: args.isbn,
        publisher: args.publisher,
        year: args.year,
      }]
    : defaultBooks()

  const startedAt = new Date().toISOString()
  const results: BookWebEnrichment[] = []

  for (let index = 0; index < books.length; index += 1) {
    const book = books[index]
    results.push(await enrichBookWithOpenWebSearch(book))
    if (index < books.length - 1) {
      await sleep(1200)
    }
  }

  const report = {
    ok: true,
    provider: 'open-websearch',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    books: results.length,
    found: results.filter(item => item.status === 'found').length,
    with_fetched_content: results.filter(item => item.results.some(result => result.fetched)).length,
    results,
  }

  const outputPath = path.resolve(args.output)
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2))

  process.stdout.write(JSON.stringify({
    ok: true,
    output: outputPath,
    books: report.books,
    found: report.found,
    with_fetched_content: report.with_fetched_content,
    top_results: results.map(item => ({
      title: item.input.title,
      status: item.status,
      best_sources: item.bestSources,
      detected_isbns: item.detectedIsbns,
      top_url: item.results[0]?.url ?? null,
      top_score: item.results[0]?.score ?? null,
    })),
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
