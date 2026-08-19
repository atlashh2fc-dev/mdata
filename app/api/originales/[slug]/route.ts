import { NextRequest, NextResponse } from 'next/server'
import { Pool, type PoolClient } from 'pg'
import { to as copyTo } from 'pg-copy-streams'
import { createGzip, type Gzip } from 'node:zlib'
import { Readable } from 'node:stream'
import {
  RAW_DATASETS,
  RAW_DATASET_SESSION_COOKIE,
  verifyRawDatasetShareToken,
} from '@/lib/raw-datasets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 1800

type RouteContext = {
  params: Promise<{ slug: string }>
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`
}

function createPool() {
  const raw = process.env.POSTGRES_URL_NON_POOLING
    ?? process.env.POSTGRES_URL
    ?? process.env.DATABASE_URL
    ?? process.env.SUPABASE_DB_URL

  if (!raw) return null

  const url = new URL(raw)
  url.searchParams.set('sslmode', 'require')
  url.searchParams.set('uselibpqcompat', 'true')
  return new Pool({ connectionString: url.toString(), max: 1 })
}

class ExportBusyError extends Error {}

async function createDirectExportStream(table: string, signal: AbortSignal) {
  const pool = createPool()
  if (!pool) throw new Error('No hay conexión disponible con Supabase.')
  const exportPool = pool

  let client: PoolClient | null = null
  let copyStream: Readable | null = null
  let gzip: Gzip | null = null
  let cleanupPromise: Promise<void> | null = null

  function cleanup(commit: boolean) {
    if (cleanupPromise) return cleanupPromise

    cleanupPromise = (async () => {
      if (client) {
        try {
          await client.query(`SELECT pg_advisory_unlock(hashtext('mdata_raw_dataset_export'))`)
          await client.query(commit ? 'COMMIT' : 'ROLLBACK')
        } catch (error) {
          console.error('[originales/cleanup]', { table, error })
        }
        client.release()
        client = null
      }

      await exportPool.end()
    })()

    return cleanupPromise
  }

  try {
    client = await exportPool.connect()
    await client.query('BEGIN READ ONLY')
    await client.query('SET LOCAL statement_timeout = 0')

    const lockResult = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('mdata_raw_dataset_export')) AS acquired`
    )
    if (!lockResult.rows[0]?.acquired) throw new ExportBusyError('Hay otra descarga en curso.')

    const tableRef = `${quoteIdentifier('public')}.${quoteIdentifier(table)}`
    const copySql = `COPY (SELECT * FROM ${tableRef}) TO STDOUT WITH (FORMAT csv, HEADER true)`
    copyStream = (client as any).query(copyTo(copySql)) as Readable
    gzip = createGzip({ level: 1 })
    copyStream.pipe(gzip)

    copyStream.once('end', () => void cleanup(true))
    copyStream.once('error', error => {
      gzip?.destroy(error)
      void cleanup(false)
    })
    gzip.once('error', () => {
      copyStream?.destroy()
      void cleanup(false)
    })
    signal.addEventListener('abort', () => {
      copyStream?.destroy()
      gzip?.destroy()
      void cleanup(false)
    }, { once: true })

    return Readable.toWeb(gzip) as ReadableStream<Uint8Array>
  } catch (error) {
    await cleanup(false)
    throw error
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  const sessionToken = request.cookies.get(RAW_DATASET_SESSION_COOKIE)?.value ?? null
  if (!verifyRawDatasetShareToken(sessionToken)) {
    return new NextResponse('No encontrado', { status: 404 })
  }

  const { slug } = await context.params
  const dataset = RAW_DATASETS.find(item => item.slug === slug)
  if (!dataset) return new NextResponse('No encontrado', { status: 404 })

  try {
    const stream = await createDirectExportStream(dataset.table, request.signal)
    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${dataset.objectName}"`,
        'Cache-Control': 'private, no-store, max-age=0',
        'Referrer-Policy': 'no-referrer',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    if (error instanceof ExportBusyError) {
      return new NextResponse('Hay otra descarga en curso. Intenta nuevamente cuando termine.', {
        status: 429,
        headers: { 'Retry-After': '60' },
      })
    }

    console.error('[originales/export]', { slug, table: dataset.table, error })
    return new NextResponse('No se pudo iniciar la descarga.', { status: 503 })
  }
}
