import { NextRequest, NextResponse } from 'next/server'
import { Readable } from 'node:stream'
import { createSupabaseServerClient, db } from '@/lib/db/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

type ExportableSource = {
  id: string
  name?: string | null
  slug?: string | null
  canonical_table?: string | null
  source_table_name?: string | null
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function resolveExportTable(source: {
  canonical_table?: string | null
  source_table_name?: string | null
}) {
  const candidate = source.canonical_table ?? source.source_table_name ?? null
  if (!candidate || !TABLE_NAME_PATTERN.test(candidate)) return null
  return candidate
}

function buildCsvFileName(source: {
  slug?: string | null
  name?: string | null
  canonical_table?: string | null
  source_table_name?: string | null
}) {
  const baseName = source.slug
    || (source.name ? slugify(source.name) : null)
    || source.canonical_table
    || source.source_table_name
    || 'dataset'

  return `${baseName}.csv`
}

async function getSourceById(id: string): Promise<{
  source: ExportableSource | null
  error: unknown
}> {
  const overviewQuery = await db
    .from('dataset_overview')
    .select('id, name, slug, canonical_table, source_table_name')
    .eq('id', id)
    .maybeSingle()

  if (overviewQuery.data) {
    return { source: overviewQuery.data as ExportableSource, error: null }
  }

  const fallbackQuery = await db
    .from('data_sources')
    .select('id, name, slug, canonical_table, source_table_name')
    .eq('id', id)
    .maybeSingle()

  if (fallbackQuery.error) {
    return {
      source: null,
      error: {
        overview: overviewQuery.error,
        fallback: fallbackQuery.error,
      },
    }
  }

  return {
    source: (fallbackQuery.data as ExportableSource | null) ?? null,
    error: overviewQuery.error,
  }
}

async function streamFromPostgres(tableName: string): Promise<ReadableStream<Uint8Array> | null> {
  const connectionString = process.env.POSTGRES_URL_NON_POOLING
    ?? process.env.POSTGRES_URL
    ?? process.env.DATABASE_URL
    ?? process.env.SUPABASE_DB_URL

  if (!connectionString) {
    return null
  }

  const { Pool } = require('pg') as typeof import('pg')
  const { to: copyTo } = require('pg-copy-streams') as { to: (sql: string) => unknown }

  const pool = new Pool({ connectionString, max: 1 })
  const client = await pool.connect()

  try {
    const copyStream = client.query(
      copyTo(`COPY (SELECT * FROM public.${tableName}) TO STDOUT WITH CSV HEADER`)
    ) as NodeJS.ReadableStream

    const cleanup = async () => {
      client.release()
      await pool.end()
    }

    copyStream.once('end', () => {
      void cleanup()
    })

    copyStream.once('error', () => {
      void cleanup()
    })

    return Readable.toWeb(copyStream as Readable) as unknown as ReadableStream<Uint8Array>
  } catch (error) {
    client.release()
    await pool.end()
    throw error
  }
}

async function streamFromSupabaseRest(tableName: string): Promise<ReadableStream<Uint8Array> | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    return null
  }

  const url = new URL(`/rest/v1/${tableName}`, supabaseUrl)
  url.searchParams.set('select', '*')

  const response = await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: 'text/csv',
      'Accept-Profile': 'public',
    },
    cache: 'no-store',
  })

  if (!response.ok || !response.body) {
    const details = await response.text()
    throw new Error(details || 'No se pudo exportar el dataset.')
  }

  return response.body as ReadableStream<Uint8Array>
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const { id } = await context.params

  const { source, error } = await getSourceById(id)

  if (!source) {
    if (error) {
      console.error('[fuentes/export][source_lookup]', { id, error })
    }
    return NextResponse.json({ error: 'Dataset no encontrado' }, { status: 404 })
  }

  const tableName = resolveExportTable(source)
  if (!tableName) {
    return NextResponse.json(
      { error: 'Este dataset no tiene una tabla exportable a CSV.' },
      { status: 400 }
    )
  }

  try {
    const stream = await streamFromPostgres(tableName) ?? await streamFromSupabaseRest(tableName)

    if (!stream) {
      return NextResponse.json(
        { error: 'No hay una conexion disponible para exportar CSV.' },
        { status: 500 }
      )
    }

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${buildCsvFileName(source)}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (streamError) {
    console.error('[fuentes/export]', streamError)
    return NextResponse.json(
      { error: 'No se pudo generar el CSV del dataset.' },
      { status: 500 }
    )
  }
}
