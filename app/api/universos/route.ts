import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import { refreshStats } from '@/lib/services/dashboard'
import { Pool } from 'pg'

export const runtime = 'nodejs'

let pool: Pool | null = null

function getPostgresConnectionString() {
  const connectionString = process.env.POSTGRES_URL_NON_POOLING
    ?? process.env.POSTGRES_URL
    ?? process.env.DATABASE_URL
    ?? process.env.SUPABASE_DB_URL

  if (!connectionString) return null

  const url = new URL(connectionString)
  url.searchParams.set('sslmode', 'require')
  url.searchParams.set('uselibpqcompat', 'true')
  return url.toString()
}

function getPool() {
  if (!pool) {
    const connectionString = getPostgresConnectionString()
    if (!connectionString) return null
    pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10000 })
  }

  return pool
}

async function getUpdatedUniversos() {
  const pgPool = getPool()
  if (!pgPool) return null

  const { rows } = await pgPool.query(`
    WITH persona_rows AS (
      SELECT
        entidad_tipo::text,
        con_nombre,
        con_email,
        con_fono,
        con_autos,
        con_empresa,
        con_domicilio,
        con_bienes_raices,
        total::bigint
      FROM public.stats_universos
      WHERE entidad_tipo <> 'persona_juridica'
    ),
    empresa_rows AS (
      SELECT
        entidad_tipo::text,
        con_nombre,
        con_email,
        con_fono,
        con_autos,
        con_empresa,
        con_domicilio,
        con_bienes_raices,
        total::bigint
      FROM public.stats_universos_empresas
    )
    SELECT *
    FROM persona_rows
    UNION ALL
    SELECT *
    FROM empresa_rows
  `)

  return rows.map(row => ({
    ...row,
    total: Number(row.total ?? 0),
  }))
}

async function getStoredUniversos(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>) {
  const { data, error } = await supabase
    .from('stats_universos')
    .select('*')

  if (error) throw error
  return data
}

export async function GET(req: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    // if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const data = await getUpdatedUniversos() ?? await getStoredUniversos(supabase)

    return NextResponse.json({ success: true, data })
  } catch (error) {
    console.error('[API/Universos]', error)
    return NextResponse.json({ success: false, error: 'Internal Server Error' }, { status: 500 })
  }
}

export async function POST() {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    await refreshStats()

    const data = await getUpdatedUniversos() ?? await getStoredUniversos(supabase)

    return NextResponse.json({ success: true, data })
  } catch (error) {
    console.error('[API/Universos refresh]', error)
    return NextResponse.json({ success: false, error: 'Internal Server Error' }, { status: 500 })
  }
}
