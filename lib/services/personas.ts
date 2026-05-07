'use server'

import { db } from '@/lib/db/supabase'
import type {
  PaginatedResponse,
  PersonaAddressDetail,
  PersonaContactDetail,
  PersonaDetail360,
  PersonaExecutiveContactDetail,
  PersonaPropertyDetail,
  PersonaSearchParams,
  PersonaVehicleDetail,
  PersonaView,
} from '@/types'
import { normalizeRut } from '@/lib/utils/rut'
import { Pool } from 'pg'

// Columnas permitidas para ordenar (usan los nombres de la vista)
const PERSONA_SORT_FIELDS = new Set([
  'rutid',
  'nombre_completo',
  'email',
  'region_canonica',
  'comuna_canonica',
  'n_autos',
  'n_bienes_raices',
  'n_propiedades_residenciales',
  'n_propiedades_comerciales',
  'n_propiedades_rurales',
  'n_propiedades_indeterminadas',
  'totalavaluos',
  'avaluo_residencial',
  'avaluo_comercial',
  'score_patrimonial',
  'cobertura_pct',
])

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
    pool = new Pool({ connectionString, max: 2 })
  }
  return pool
}

function getSafeSortField(field?: string): string {
  if (!field) return 'score_patrimonial'
  return PERSONA_SORT_FIELDS.has(field) ? field : 'score_patrimonial'
}

function getSearchTokens(term: string): string[] {
  return term
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2)
    .slice(0, 5)
}

function normalizePersonNameTerm(term: string): string {
  return term
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([A-Za-z])\1{2,}/g, '$1$1')
    .replace(/[^a-z0-9]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

function buildEmptyPaginatedResponse<T>(
  from: number,
  to: number
): PaginatedResponse<T> {
  const pageSize = Math.max(to - from + 1, 1)
  const page = Math.floor(from / pageSize) + 1

  return {
    data: [],
    total: 0,
    page,
    page_size: pageSize,
    total_pages: 0,
  }
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeRutForDb(value: string): string | null {
  const cleaned = value.replace(/[.\-\s]/g, '').toUpperCase()
  if (cleaned.length < 2) return null
  return cleaned.padStart(10, '0')
}

function normalizeRutKey(value: string): string | null {
  const normalized = normalizeRutForDb(value)
  if (!normalized) return null
  return normalized.replace(/^0+/, '') || normalized
}

function normalizePgPersonaRow(row: Record<string, unknown>): PersonaView {
  return {
    ...row,
    n_autos: toNumber(row.n_autos),
    n_bienes_raices: toNumber(row.n_bienes_raices),
    totalavaluos: toNumber(row.totalavaluos),
    score_patrimonial: toNumber(row.score_patrimonial),
    cobertura_pct: toNumber(row.cobertura_pct),
    n_propiedades_detalle: toNumber(row.n_propiedades_detalle),
    n_propiedades_residenciales: toNumber(row.n_propiedades_residenciales),
    n_propiedades_comerciales: toNumber(row.n_propiedades_comerciales),
    n_propiedades_rurales: toNumber(row.n_propiedades_rurales),
    n_propiedades_indeterminadas: toNumber(row.n_propiedades_indeterminadas),
    avaluo_residencial: toNumber(row.avaluo_residencial),
    avaluo_comercial: toNumber(row.avaluo_comercial),
    avaluo_rural: toNumber(row.avaluo_rural),
    avaluo_indeterminado: toNumber(row.avaluo_indeterminado),
    bbrr_destinos: Array.isArray(row.bbrr_destinos) ? row.bbrr_destinos as string[] : [],
  } as PersonaView
}

function normalizeVehicleDetail(row: Record<string, unknown>): PersonaVehicleDetail {
  return {
    id: toNumber(row.id),
    ppu: row.ppu as string | null,
    ppu_dv: row.ppu_dv as string | null,
    marca: row.marca as string | null,
    modelo: row.modelo as string | null,
    tipo_vehiculo: row.tipo_vehiculo as string | null,
    anio_fabricacion: toNullableNumber(row.anio_fabricacion),
    fecha_transferencia: row.fecha_transferencia as string | null,
    color: row.color as string | null,
    clasificacion: row.clasificacion as string | null,
    avaluo_fiscal: toNumber(row.avaluo_fiscal),
    avaluo_comercial: toNumber(row.avaluo_comercial),
  }
}

function normalizePropertyDetail(row: Record<string, unknown>): PersonaPropertyDetail {
  return {
    id: String(row.id ?? ''),
    rol: row.rol as string | null,
    direccion: row.direccion as string | null,
    comuna: row.comuna as string | null,
    tipo_propiedad: row.tipo_propiedad as string | null,
    destino: row.destino as string | null,
    avaluo_fiscal: toNumber(row.avaluo_fiscal),
    fono_comercial: row.fono_comercial as string | null,
    fono_particular: row.fono_particular as string | null,
    fono_celular: row.fono_celular as string | null,
    email: row.email as string | null,
  }
}

function normalizeAddressDetail(row: Record<string, unknown>): PersonaAddressDetail {
  return {
    source: String(row.source ?? 'fuente_interna'),
    direccion: row.direccion as string | null,
    comuna: row.comuna as string | null,
    region: row.region as string | null,
    seen_at: row.seen_at as string | null,
  }
}

function normalizeContactDetail(row: Record<string, unknown>): PersonaContactDetail {
  return {
    id: String(row.id ?? ''),
    contact_type: row.contact_type === 'email' ? 'email' : 'phone',
    contact_value: String(row.contact_value ?? ''),
    source_name: row.source_name as string | null,
    quality_score: toNullableNumber(row.quality_score),
    is_primary: row.is_primary as boolean | null,
    is_verified: row.is_verified as boolean | null,
    last_seen_at: row.last_seen_at as string | null,
    metadata: (row.metadata ?? null) as Record<string, unknown> | null,
  }
}

function normalizeExecutiveContactDetail(
  row: Record<string, unknown> | null | undefined
): PersonaExecutiveContactDetail | null {
  if (!row) return null
  return {
    rutid: String(row.rutid ?? ''),
    razon_social: row.razon_social as string | null,
    rutid_ejecutivo: row.rutid_ejecutivo as string | null,
    nombre_ejecutivo: row.nombre_ejecutivo as string | null,
    area: row.area as string | null,
    cargo: row.cargo as string | null,
    email: row.email as string | null,
    celular: row.celular as string | null,
    telefono_comercial: row.telefono_comercial as string | null,
    mejor_telefono: row.mejor_telefono as string | null,
    contact_priority: toNullableNumber(row.contact_priority),
  }
}

async function getPersonaDetailFromPostgres(
  rutid: string,
  rutKey: string
): Promise<PersonaDetail360 | null> {
  const pgPool = getPool()
  if (!pgPool) return null

  try {
    const [
      addressesResult,
      vehiclesResult,
      propertiesResult,
      contactsResult,
      executiveResult,
    ] = await Promise.all([
      pgPool.query(`
        select source, direccion, comuna, region, seen_at
        from (
          select
            'domicilio_preferido'::text as source,
            direccion,
            comuna,
            region,
            source_seen_at as seen_at,
            120 as rank
          from public.empresas_direccion_preferida
          where rutid = $2

          union all

          select
            'padron_personas_raw'::text as source,
            nullif(btrim(direccion), '') as direccion,
            nullif(btrim(comuna), '') as comuna,
            nullif(btrim(region), '') as region,
            coalesce(updated_at, loaded_at, created_at) as seen_at,
            80 as rank
          from public.padron_personas_raw
          where nullif(ltrim(regexp_replace(upper(rutid), '[^0-9K]', '', 'g'), '0'), '') = $2

          union all

          select
            'bbrr_propiedades'::text as source,
            nullif(btrim(direccion), '') as direccion,
            nullif(btrim(comuna), '') as comuna,
            null::text as region,
            coalesce(updated_at, source_loaded_at, created_at) as seen_at,
            60 as rank
          from public.bbrr_propiedades
          where nullif(ltrim(regexp_replace(upper(rutid), '[^0-9K]', '', 'g'), '0'), '') = $2
        ) address_candidates
        where direccion is not null or comuna is not null or region is not null
        order by (direccion is not null) desc, rank desc, seen_at desc nulls last
        limit 8
      `, [rutid, rutKey]),
      pgPool.query(`
        select
          id,
          nullif(btrim(ppu), '') as ppu,
          nullif(btrim(ppu_dv), '') as ppu_dv,
          nullif(btrim(marca), '') as marca,
          nullif(btrim(modelo), '') as modelo,
          nullif(btrim(tipo_vehiculo), '') as tipo_vehiculo,
          anio_fabricacion,
          fecha_transferencia,
          nullif(btrim(color), '') as color,
          nullif(btrim(clasificacion), '') as clasificacion,
          avaluo_fiscal,
          avaluo_comercial
        from public.automoviles2025
        where rutid = $1
        order by avaluo_fiscal desc nulls last, anio_fabricacion desc nulls last, id asc
        limit 50
      `, [rutid]),
      pgPool.query(`
        select
          id,
          nullif(btrim(rol), '') as rol,
          nullif(btrim(direccion), '') as direccion,
          nullif(btrim(comuna), '') as comuna,
          nullif(btrim(tipo_propiedad), '') as tipo_propiedad,
          nullif(btrim(destino), '') as destino,
          avaluo_fiscal,
          nullif(btrim(concat_ws('', fono_area_comer, fono_numero_comer)), '') as fono_comercial,
          nullif(btrim(concat_ws('', fono_area_part, fono_numero_part)), '') as fono_particular,
          nullif(btrim(concat_ws('', fono_area_cel, fono_numero_cel)), '') as fono_celular,
          nullif(btrim(email), '') as email
        from public.bbrr_propiedades
        where nullif(ltrim(regexp_replace(upper(rutid), '[^0-9K]', '', 'g'), '0'), '') = $2
        order by avaluo_fiscal desc nulls last, rol asc
        limit 50
      `, [rutid, rutKey]),
      pgPool.query(`
        select
          id,
          contact_type,
          contact_value,
          source_name,
          quality_score,
          is_primary,
          is_verified,
          last_seen_at,
          metadata
        from public.persona_contact_points
        where rutid = $1
        order by is_primary desc, quality_score desc nulls last, last_seen_at desc nulls last
        limit 40
      `, [rutid]),
      pgPool.query(`
        select
          rutid,
          razon_social,
          rutid_ejecutivo,
          nombre_ejecutivo,
          area,
          cargo,
          email,
          celular,
          telefono_comercial,
          mejor_telefono,
          contact_priority
        from public.company_best_executive_contact
        where rutid = $1
        limit 1
      `, [rutid]),
    ])

    return {
      rutid,
      addresses: addressesResult.rows.map(normalizeAddressDetail),
      vehicles: vehiclesResult.rows.map(normalizeVehicleDetail),
      properties: propertiesResult.rows.map(normalizePropertyDetail),
      contact_points: contactsResult.rows.map(normalizeContactDetail),
      executive_contact: normalizeExecutiveContactDetail(executiveResult.rows[0]),
    }
  } catch (error) {
    console.error('[getPersonaDetailFromPostgres]', error)
    return null
  }
}

async function getPersonaDetailFromSupabase(rutid: string): Promise<PersonaDetail360> {
  const [
    vehiclesResult,
    propertiesResult,
    contactsResult,
    executiveResult,
  ] = await Promise.all([
    db
      .from('automoviles2025')
      .select('id,ppu,ppu_dv,marca,modelo,tipo_vehiculo,anio_fabricacion,fecha_transferencia,color,clasificacion,avaluo_fiscal,avaluo_comercial')
      .eq('rutid', rutid)
      .order('avaluo_fiscal', { ascending: false })
      .limit(50),
    db
      .from('bbrr_propiedades')
      .select('id,rol,direccion,comuna,tipo_propiedad,destino,avaluo_fiscal,email,fono_area_comer,fono_numero_comer,fono_area_part,fono_numero_part,fono_area_cel,fono_numero_cel')
      .eq('rutid', rutid)
      .order('avaluo_fiscal', { ascending: false })
      .limit(50),
    db
      .from('persona_contact_points')
      .select('id,contact_type,contact_value,source_name,quality_score,is_primary,is_verified,last_seen_at,metadata')
      .eq('rutid', rutid)
      .order('is_primary', { ascending: false })
      .order('quality_score', { ascending: false })
      .limit(40),
    db
      .from('company_best_executive_contact')
      .select('rutid,razon_social,rutid_ejecutivo,nombre_ejecutivo,area,cargo,email,celular,telefono_comercial,mejor_telefono,contact_priority')
      .eq('rutid', rutid)
      .limit(1)
      .maybeSingle(),
  ])

  const propertyRows = (propertiesResult.data ?? []) as Array<Record<string, unknown>>

  return {
    rutid,
    addresses: propertyRows
      .filter(row => row.direccion || row.comuna)
      .slice(0, 8)
      .map(row => normalizeAddressDetail({
        source: 'bbrr_propiedades',
        direccion: row.direccion,
        comuna: row.comuna,
        region: null,
        seen_at: null,
      })),
    vehicles: ((vehiclesResult.data ?? []) as Array<Record<string, unknown>>).map(normalizeVehicleDetail),
    properties: propertyRows.map(row => normalizePropertyDetail({
      ...row,
      fono_comercial: `${row.fono_area_comer ?? ''}${row.fono_numero_comer ?? ''}` || null,
      fono_particular: `${row.fono_area_part ?? ''}${row.fono_numero_part ?? ''}` || null,
      fono_celular: `${row.fono_area_cel ?? ''}${row.fono_numero_cel ?? ''}` || null,
    })),
    contact_points: ((contactsResult.data ?? []) as Array<Record<string, unknown>>).map(normalizeContactDetail),
    executive_contact: normalizeExecutiveContactDetail(executiveResult.data as Record<string, unknown> | null),
  }
}

function shouldUseBbrrFastPath(params: PersonaSearchParams) {
  return Boolean(params.uso_propiedad || params.destino_propiedad)
}

function getBbrrSortExpression(sortBy: string) {
  if (sortBy === 'score_patrimonial') return 'score_patrimonial'
  if (sortBy === 'n_bienes_raices') return 'n_bienes_raices'
  if (sortBy === 'totalavaluos') return 'totalavaluos'
  if (sortBy === 'n_propiedades_residenciales') return 'n_propiedades_residenciales'
  if (sortBy === 'n_propiedades_comerciales') return 'n_propiedades_comerciales'
  if (sortBy === 'n_propiedades_rurales') return 'n_propiedades_rurales'
  if (sortBy === 'n_propiedades_indeterminadas') return 'n_propiedades_indeterminadas'
  if (sortBy === 'avaluo_residencial') return 'avaluo_residencial'
  if (sortBy === 'avaluo_comercial') return 'avaluo_comercial'
  if (sortBy === 'cobertura_pct') return 'cobertura_pct'
  if (sortBy === 'rutid') return 'rutid'
  if (sortBy === 'nombre_completo') return 'nombre_completo'
  if (sortBy === 'email') return 'email'
  if (sortBy === 'region_canonica') return 'region_canonica'
  if (sortBy === 'comuna_canonica') return 'comuna_canonica'
  if (sortBy === 'n_autos') return 'n_autos'
  return 'score_patrimonial'
}

async function searchPersonasBbrrFastPath(
  params: PersonaSearchParams
): Promise<PaginatedResponse<PersonaView> | null> {
  const pgPool = getPool()
  if (!pgPool) return null

  const {
    q,
    page = 1,
    page_size = 50,
    sort_by,
    sort_order = 'desc',
    region,
    comuna,
    tiene_autos,
    tiene_empresa,
    tiene_bienes_raices,
    uso_propiedad,
    destino_propiedad,
    score_min,
    score_max,
  } = params

  if (tiene_bienes_raices === false) {
    return { data: [], total: 0, page, page_size, total_pages: 0 }
  }

  const hasPersonaFilters = Boolean(
    q?.trim() ||
    region ||
    comuna ||
    tiene_autos !== undefined ||
    tiene_empresa !== undefined ||
    score_min !== undefined ||
    score_max !== undefined
  )

  if (!hasPersonaFilters) {
    const buValues: unknown[] = []
    const buWhere: string[] = []
    const addBuValue = (value: unknown) => {
      buValues.push(value)
      return `$${buValues.length}`
    }

    if (uso_propiedad === 'con_residencial') {
      buWhere.push('n_propiedades_residenciales > 0')
    } else if (uso_propiedad === 'con_comercial') {
      buWhere.push('n_propiedades_comerciales > 0')
    } else if (uso_propiedad === 'solo_residencial') {
      buWhere.push(`uso_propiedad_inferido = ${addBuValue('residencial')}`)
    } else if (uso_propiedad === 'solo_comercial') {
      buWhere.push(`uso_propiedad_inferido = ${addBuValue('comercial')}`)
    } else if (uso_propiedad) {
      buWhere.push(`uso_propiedad_inferido = ${addBuValue(uso_propiedad)}`)
    }

    if (destino_propiedad) {
      buWhere.push(`bbrr_destinos @> array[${addBuValue(destino_propiedad)}]::text[]`)
    }

    const buWhereSql = buWhere.length > 0 ? `where ${buWhere.join(' and ')}` : ''
    const offset = (page - 1) * page_size
    const limitParam = addBuValue(page_size)
    const offsetParam = addBuValue(offset)
    const buOrder = uso_propiedad === 'con_residencial'
      ? 'n_propiedades_residenciales'
      : uso_propiedad === 'rural_productivo'
        ? 'n_propiedades_rurales'
        : uso_propiedad === 'indeterminado_o_especial'
          ? 'n_propiedades_indeterminadas'
          : 'n_propiedades_comerciales'

    const sql = `
      with total as (
        select count(*)::bigint as total_count
        from public.bbrr_uso_propiedad_por_rut
        ${buWhereSql}
      ),
      bu_page as (
        select *
        from public.bbrr_uso_propiedad_por_rut
        ${buWhereSql}
        order by ${buOrder} desc nulls last, rutid asc
        limit ${limitParam}
        offset ${offsetParam}
      )
      select
        pm.rutid,
        nullif(trim(pm.nombres), '') as nombres,
        nullif(trim(pm.paterno), '') as paterno,
        nullif(trim(pm.materno), '') as materno,
        nullif(trim(
          coalesce(nullif(trim(pm.nombres),''), '') || ' ' ||
          coalesce(nullif(trim(pm.paterno),''), '') || ' ' ||
          coalesce(nullif(trim(pm.materno),''), '')
        ), '') as nombre_completo,
        nullif(trim(pm.email), '') as email,
        nullif(trim(pm.fono_cel), '') as fono_cel,
        nullif(trim(pm.comuna_part), '') as comuna_part,
        nullif(trim(pm.region_part), '') as region_part,
        pm.n_autos,
        (pm.n_autos > 0) as tiene_autos,
        pm.razon_social_empresa,
        (pm.razon_social_empresa is not null) as tiene_empresa,
        pm.domicilio_comuna,
        pm.domicilio_region,
        pm.n_bienes_raices,
        pm.totalavaluos,
        (pm.n_bienes_raices > 0) as tiene_bienes_raices,
        (
          coalesce(pm.n_autos, 0) * 10 +
          coalesce(pm.n_bienes_raices, 0) * 20 +
          case when pm.razon_social_empresa is not null then 15 else 0 end +
          case when nullif(trim(pm.email), '') is not null then 5 else 0 end +
          case when nullif(trim(pm.fono_cel), '') is not null then 5 else 0 end
        )::integer as score_patrimonial,
        (
          (case when nullif(trim(pm.nombres), '') is not null then 1 else 0 end +
           case when nullif(trim(pm.email), '') is not null then 1 else 0 end +
           case when nullif(trim(pm.fono_cel), '') is not null then 1 else 0 end +
           case when nullif(trim(pm.region_part), '') is not null then 1 else 0 end +
           case when pm.n_autos > 0 then 1 else 0 end +
           case when pm.razon_social_empresa is not null then 1 else 0 end +
           case when pm.domicilio_region is not null then 1 else 0 end +
           case when pm.n_bienes_raices > 0 then 1 else 0 end
          )::float / 8.0 * 100
        )::integer as cobertura_pct,
        coalesce(nullif(trim(pm.region_part), ''), pm.domicilio_region) as region_canonica,
        coalesce(nullif(trim(pm.comuna_part), ''), pm.domicilio_comuna) as comuna_canonica,
        pm.loaded_at as created_at,
        pm.loaded_at as updated_at,
        bu.uso_propiedad_inferido,
        coalesce(bu.bbrr_destinos, array[]::text[]) as bbrr_destinos,
        bu.n_propiedades_detalle,
        bu.n_propiedades_residenciales,
        bu.n_propiedades_comerciales,
        bu.n_propiedades_rurales,
        bu.n_propiedades_indeterminadas,
        bu.avaluo_residencial,
        bu.avaluo_comercial,
        bu.avaluo_rural,
        bu.avaluo_indeterminado,
        total.total_count
      from bu_page bu
      cross join total
      join public.personas_master pm
        on pm.rutid = lpad(bu.rutid, 10, '0')
    `

    try {
      const result = await pgPool.query(sql, buValues)
      const total = result.rows.length > 0 ? toNumber(result.rows[0].total_count) : 0
      return {
        data: result.rows.map(row => {
          const persona = { ...row }
          delete persona.total_count
          return normalizePgPersonaRow(persona)
        }),
        total,
        page,
        page_size,
        total_pages: Math.ceil(total / page_size),
      }
    } catch (error) {
      console.error('[searchPersonasBbrrFastPath.simple]', error)
      return { data: [], total: 0, page, page_size, total_pages: 0 }
    }
  }

  const values: unknown[] = []
  const where: string[] = []
  const addValue = (value: unknown) => {
    values.push(value)
    return `$${values.length}`
  }

  if (uso_propiedad === 'con_residencial') {
    where.push('bu.n_propiedades_residenciales > 0')
  } else if (uso_propiedad === 'con_comercial') {
    where.push('bu.n_propiedades_comerciales > 0')
  } else if (uso_propiedad === 'solo_residencial') {
    where.push(`bu.uso_propiedad_inferido = ${addValue('residencial')}`)
  } else if (uso_propiedad === 'solo_comercial') {
    where.push(`bu.uso_propiedad_inferido = ${addValue('comercial')}`)
  } else if (uso_propiedad) {
    where.push(`bu.uso_propiedad_inferido = ${addValue(uso_propiedad)}`)
  }

  if (destino_propiedad) {
    where.push(`bu.bbrr_destinos @> array[${addValue(destino_propiedad)}]::text[]`)
  }

  if (tiene_autos !== undefined) {
    where.push(tiene_autos ? 'pm.n_autos > 0' : 'coalesce(pm.n_autos, 0) = 0')
  }

  if (tiene_empresa !== undefined) {
    where.push(tiene_empresa ? 'pm.razon_social_empresa is not null' : 'pm.razon_social_empresa is null')
  }

  if (region) {
    where.push(`coalesce(nullif(trim(pm.region_part), ''), pm.domicilio_region) ilike ${addValue(`%${region}%`)}`)
  }

  if (comuna) {
    where.push(`coalesce(nullif(trim(pm.comuna_part), ''), pm.domicilio_comuna) ilike ${addValue(`%${comuna}%`)}`)
  }

  if (score_min !== undefined) {
    where.push(`(
      coalesce(pm.n_autos, 0) * 10 +
      coalesce(pm.n_bienes_raices, 0) * 20 +
      case when pm.razon_social_empresa is not null then 15 else 0 end +
      case when nullif(trim(pm.email), '') is not null then 5 else 0 end +
      case when nullif(trim(pm.fono_cel), '') is not null then 5 else 0 end
    ) >= ${addValue(score_min)}`)
  }

  if (score_max !== undefined) {
    where.push(`(
      coalesce(pm.n_autos, 0) * 10 +
      coalesce(pm.n_bienes_raices, 0) * 20 +
      case when pm.razon_social_empresa is not null then 15 else 0 end +
      case when nullif(trim(pm.email), '') is not null then 5 else 0 end +
      case when nullif(trim(pm.fono_cel), '') is not null then 5 else 0 end
    ) <= ${addValue(score_max)}`)
  }

  if (q?.trim()) {
    const term = q.trim()
    if (/^\d[\d.\-kK]*$/.test(term)) {
      where.push(`pm.rutid = ${addValue(term.replace(/[.\-\s]/g, '').toUpperCase().padStart(10, '0'))}`)
    } else {
      const normalizedTerm = normalizePersonNameTerm(term)
      const pattern = `%${normalizedTerm || term}%`
      where.push(`(
        nullif(trim(pm.nombres), '') ilike ${addValue(pattern)}
        or nullif(trim(pm.paterno), '') ilike ${addValue(pattern)}
        or nullif(trim(pm.materno), '') ilike ${addValue(pattern)}
        or nullif(trim(pm.email), '') ilike ${addValue(`%${term}%`)}
        or pm.razon_social_empresa ilike ${addValue(`%${term}%`)}
      )`)
    }
  }

  const offset = (page - 1) * page_size
  const orderDirection = sort_order === 'asc' ? 'asc' : 'desc'
  const orderExpression = getBbrrSortExpression(getSafeSortField(sort_by))
  const whereSql = where.length > 0 ? `where ${where.join(' and ')}` : ''
  const limitParam = addValue(page_size)
  const offsetParam = addValue(offset)

  const sql = `
    with filtered as (
      select
        pm.rutid,
        nullif(trim(pm.nombres), '') as nombres,
        nullif(trim(pm.paterno), '') as paterno,
        nullif(trim(pm.materno), '') as materno,
        nullif(trim(
          coalesce(nullif(trim(pm.nombres),''), '') || ' ' ||
          coalesce(nullif(trim(pm.paterno),''), '') || ' ' ||
          coalesce(nullif(trim(pm.materno),''), '')
        ), '') as nombre_completo,
        nullif(trim(pm.email), '') as email,
        nullif(trim(pm.fono_cel), '') as fono_cel,
        nullif(trim(pm.comuna_part), '') as comuna_part,
        nullif(trim(pm.region_part), '') as region_part,
        pm.n_autos,
        (pm.n_autos > 0) as tiene_autos,
        pm.razon_social_empresa,
        (pm.razon_social_empresa is not null) as tiene_empresa,
        pm.domicilio_comuna,
        pm.domicilio_region,
        pm.n_bienes_raices,
        pm.totalavaluos,
        (pm.n_bienes_raices > 0) as tiene_bienes_raices,
        (
          coalesce(pm.n_autos, 0) * 10 +
          coalesce(pm.n_bienes_raices, 0) * 20 +
          case when pm.razon_social_empresa is not null then 15 else 0 end +
          case when nullif(trim(pm.email), '') is not null then 5 else 0 end +
          case when nullif(trim(pm.fono_cel), '') is not null then 5 else 0 end
        )::integer as score_patrimonial,
        (
          (case when nullif(trim(pm.nombres), '') is not null then 1 else 0 end +
           case when nullif(trim(pm.email), '') is not null then 1 else 0 end +
           case when nullif(trim(pm.fono_cel), '') is not null then 1 else 0 end +
           case when nullif(trim(pm.region_part), '') is not null then 1 else 0 end +
           case when pm.n_autos > 0 then 1 else 0 end +
           case when pm.razon_social_empresa is not null then 1 else 0 end +
           case when pm.domicilio_region is not null then 1 else 0 end +
           case when pm.n_bienes_raices > 0 then 1 else 0 end
          )::float / 8.0 * 100
        )::integer as cobertura_pct,
        coalesce(nullif(trim(pm.region_part), ''), pm.domicilio_region) as region_canonica,
        coalesce(nullif(trim(pm.comuna_part), ''), pm.domicilio_comuna) as comuna_canonica,
        pm.loaded_at as created_at,
        pm.loaded_at as updated_at,
        bu.uso_propiedad_inferido,
        coalesce(bu.bbrr_destinos, array[]::text[]) as bbrr_destinos,
        bu.n_propiedades_detalle,
        bu.n_propiedades_residenciales,
        bu.n_propiedades_comerciales,
        bu.n_propiedades_rurales,
        bu.n_propiedades_indeterminadas,
        bu.avaluo_residencial,
        bu.avaluo_comercial,
        bu.avaluo_rural,
        bu.avaluo_indeterminado
      from public.bbrr_uso_propiedad_por_rut bu
      join public.personas_master pm
        on nullif(ltrim(upper(pm.rutid), '0'), '') = bu.rutid
      ${whereSql}
    )
    select *, count(*) over()::bigint as total_count
    from filtered
    order by ${orderExpression} ${orderDirection} nulls last
    limit ${limitParam}
    offset ${offsetParam}
  `

  try {
    const result = await pgPool.query(sql, values)
    const total = result.rows.length > 0 ? toNumber(result.rows[0].total_count) : 0
    return {
      data: result.rows.map(row => {
        const persona = { ...row }
        delete persona.total_count
        return normalizePgPersonaRow(persona)
      }),
      total,
      page,
      page_size,
      total_pages: Math.ceil(total / page_size),
    }
  } catch (error) {
    console.error('[searchPersonasBbrrFastPath]', error)
    return { data: [], total: 0, page, page_size, total_pages: 0 }
  }
}

async function searchPersonasByNameMatch(
  term: string,
  from: number,
  to: number,
  sortBy: string,
  sortOrder: 'asc' | 'desc'
): Promise<PaginatedResponse<PersonaView> | null> {
  const normalizedTerm = normalizePersonNameTerm(term)
  const tokens = getSearchTokens(normalizedTerm)

  if (tokens.length < 2) return null

  const { data: matches, error } = await db.rpc('match_person_names', {
    input_names: [normalizedTerm],
  })

  if (error) {
    if (error.code !== 'PGRST202') {
      console.error('[searchPersonasByNameMatch]', error)
    }
    return null
  }

  const uniqueRutIds = [...new Set(
    ((matches ?? []) as Array<{ rutid: string | null }>).map(item => item.rutid).filter(Boolean)
  )] as string[]

  if (uniqueRutIds.length === 0) {
    return buildEmptyPaginatedResponse(from, to)
  }

  const { data, error: fetchError } = await db
    .from('master_personas_view')
    .select('*', { count: 'exact' })
    .in('rutid', uniqueRutIds)
    .order(sortBy, { ascending: sortOrder === 'asc' })
    .range(from, to)

  if (fetchError) {
    console.error('[searchPersonasByNameMatch.fetch]', fetchError)
    return null
  }

  const total = uniqueRutIds.length
  const pageSize = Math.max(to - from + 1, 1)
  const page = Math.floor(from / pageSize) + 1

  return {
    data: (data ?? []) as PersonaView[],
    total,
    page,
    page_size: pageSize,
    total_pages: Math.ceil(total / pageSize),
  }
}

/**
 * Obtiene el perfil 360 completo de una persona por RUT.
 * Consulta master_personas_view (que transforma personas_master).
 */
export async function getPersonaByRut(rut: string): Promise<PersonaView | null> {
  // DB stores RUT zero-padded to 10 chars, no dots/dashes: "12.345.678-9" → "0123456789"
  // Using exact PK match (padStart) to hit the PRIMARY KEY index — instant on 9.5M rows
  const padded = rut.replace(/[.\-\s]/g, '').toUpperCase().padStart(10, '0')

  const { data, error } = await db
    .from('master_personas_view')
    .select('*')
    .eq('rutid', padded)
    .limit(1)
    .single()

  if (error || !data) return null
  return data as PersonaView
}

/**
 * Obtiene el detalle granular del RUT desde las fuentes internas disponibles.
 * Mantiene límites altos pero acotados para que la ficha no arrastre tablas completas.
 */
export async function getPersonaDetail360(rut: string): Promise<PersonaDetail360 | null> {
  const rutid = normalizeRutForDb(rut)
  const rutKey = normalizeRutKey(rut)
  if (!rutid || !rutKey) return null

  const pgDetail = await getPersonaDetailFromPostgres(rutid, rutKey)
  if (pgDetail) return pgDetail

  return getPersonaDetailFromSupabase(rutid)
}

/**
 * Búsqueda de personas con filtros avanzados y paginación.
 * Consulta master_personas_view para aprovechar las columnas computadas.
 */
export async function searchPersonas(
  params: PersonaSearchParams
): Promise<PaginatedResponse<PersonaView>> {
  const {
    q,
    page = 1,
    page_size = 50,
    sort_by,
    sort_order = 'desc',
    region,
    comuna,
    tiene_autos,
    tiene_empresa,
    tiene_bienes_raices,
    uso_propiedad,
    destino_propiedad,
    score_min,
    score_max,
  } = params

  const from = (page - 1) * page_size
  const to = from + page_size - 1

  if (shouldUseBbrrFastPath(params)) {
    const fastResult = await searchPersonasBbrrFastPath(params)
    if (fastResult) return fastResult
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = (db as any)
    .from('master_personas_view')
    .select('*', { count: 'exact' })

  const safeSortBy = getSafeSortField(sort_by)

  // Búsqueda por texto libre (RUT, nombre, email)
  if (q && q.trim()) {
    const term = q.trim()
    // Si parece RUT (empieza con dígito o tiene formato chileno con puntos/guión)
    if (/^\d[\d.\-kK]*$/.test(term)) {
      // DB almacena sin puntos ni guión, zero-padded a 10 chars.
      // Búsqueda exacta por PK: "12.345.678-9" → "0123456789" → eq() usa el índice PRIMARY KEY
      const padded = term.replace(/[.\-\s]/g, '').toUpperCase().padStart(10, '0')
      query = query.eq('rutid', padded)
    } else {
      const normalizedTerm = normalizePersonNameTerm(term)
      const tokens = getSearchTokens(normalizedTerm)
      if (tokens.length >= 2 && !term.includes('@')) {
        const directNameMatch = await searchPersonasByNameMatch(
          normalizedTerm,
          from,
          to,
          safeSortBy,
          sort_order
        )

        if (directNameMatch !== null) {
          return directNameMatch
        }

        for (const token of tokens) {
          query = query.or(
            `nombre_completo.ilike.%${token}%,nombres.ilike.%${token}%,paterno.ilike.%${token}%,materno.ilike.%${token}%`
          )
        }
      } else {
        query = query.or(
          `nombre_completo.ilike.%${normalizedTerm}%,nombres.ilike.%${normalizedTerm}%,paterno.ilike.%${normalizedTerm}%,materno.ilike.%${normalizedTerm}%,email.ilike.%${term}%,razon_social_empresa.ilike.%${term}%`
        )
      }
    }
  }

  // Filtros por ubicación
  if (region) query = query.ilike('region_canonica', `%${region}%`)
  if (comuna) query = query.ilike('comuna_canonica', `%${comuna}%`)

  // Filtros booleanos (columna computada en la vista)
  if (tiene_autos !== undefined) query = query.eq('tiene_autos', tiene_autos)
  if (tiene_empresa !== undefined) query = query.eq('tiene_empresa', tiene_empresa)
  if (tiene_bienes_raices !== undefined)
    query = query.eq('tiene_bienes_raices', tiene_bienes_raices)
  if (uso_propiedad === 'con_residencial') {
    query = query.gt('n_propiedades_residenciales', 0)
  } else if (uso_propiedad === 'con_comercial') {
    query = query.gt('n_propiedades_comerciales', 0)
  } else if (uso_propiedad === 'solo_residencial') {
    query = query.eq('uso_propiedad_inferido', 'residencial')
  } else if (uso_propiedad === 'solo_comercial') {
    query = query.eq('uso_propiedad_inferido', 'comercial')
  } else if (uso_propiedad) {
    query = query.eq('uso_propiedad_inferido', uso_propiedad)
  }
  if (destino_propiedad) query = query.contains('bbrr_destinos', [destino_propiedad])

  // Filtro por score
  if (score_min !== undefined) query = query.gte('score_patrimonial', score_min)
  if (score_max !== undefined) query = query.lte('score_patrimonial', score_max)

  const { data, error, count } = await query
    .order(safeSortBy, { ascending: sort_order === 'asc' })
    .range(from, to)

  if (error) {
    console.error('[searchPersonas]', error)
    return { data: [], total: 0, page, page_size, total_pages: 0 }
  }

  const total = count ?? 0
  return {
    data: (data ?? []) as PersonaView[],
    total,
    page,
    page_size,
    total_pages: Math.ceil(total / page_size),
  }
}

/**
 * Obtiene estadísticas por región.
 */
export async function getPersonasByRegion(): Promise<
  { region: string; count: number }[]
> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('stats_por_region')
    .select('region, total')
    .order('total', { ascending: false })

  if (!error && Array.isArray(data)) {
    return data.map((row: { region: string; total: number }) => ({
      region: row.region,
      count: row.total,
    }))
  }

  console.warn('[getPersonasByRegion] stats_por_region not available:', error?.message)
  return []
}

/**
 * Obtiene distribución de score patrimonial.
 */
export async function getScoreDistribution(): Promise<
  { range: string; count: number }[]
> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('stats_score_dist')
    .select('range, count')
    .order('range', { ascending: true })

  if (!error && Array.isArray(data)) {
    return data.map((row: { range: string; count: number }) => ({
      range: row.range,
      count: row.count,
    }))
  }

  console.warn('[getScoreDistribution] stats_score_dist not available:', error?.message)
  return []
}

/**
 * Verifica si un RUT existe en personas_master.
 */
export async function rutExists(rut: string): Promise<boolean> {
  const rutNorm = normalizeRut(rut)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count } = await (db as any)
    .from('personas_master')
    .select('rutid', { count: 'exact', head: true })
    .eq('rutid', rutNorm)
  return (count ?? 0) > 0
}
