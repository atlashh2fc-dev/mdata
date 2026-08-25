#!/usr/bin/env node

// Reconstruye de punta a punta la capa de telefonos y la BDD discable de credito B2B.
//
//   Paso 0  refresca base_contact + sync CRM + repara fonos ECU (padding)
//   Paso 1  public.empresa_telefonos       -> una fila por (empresa, telefono, fuente)
//   Paso 2  public.equifax_bdd_credito_b2b -> una fila por telefono, deduplicado y scoreado
//
// Las funciones SQL viven en la base (ver docs/bdd-credito-b2b.md). Este script solo
// las orquesta en el orden correcto y respetando los chunks, porque el pool de Supabase
// corta las consultas largas.
//
// Uso:
//   node scripts/equifax/rebuild-bdd-credito-b2b.mjs             # todo
//   node scripts/equifax/rebuild-bdd-credito-b2b.mjs --solo-bdd  # salta paso 0 y 1

import pg from 'pg'
import {
  forceHeavyJobOutsideWindow,
  runGuardedHeavyJob,
} from '../../lib/services/heavy-job-guard.mjs'

const { Client } = pg
const soloBdd = process.argv.includes('--solo-bdd')
const forceOutsideWindow = forceHeavyJobOutsideWindow()
const JOB_NAME = 'equifax_bdd_rebuild'

function dbUrl() {
  const raw = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || process.env.DATABASE_URL
  if (!raw) throw new Error('Falta POSTGRES_URL_NON_POOLING/POSTGRES_URL/DATABASE_URL')
  const url = new URL(raw)
  url.searchParams.delete('sslmode')
  return url.toString()
}

// Rangos sobre malla_ubo.rutid_sociedad_norm. OJO: la comparacion es de TEXTO, no numerica,
// por eso el limite superior es 'Z' y no '1000000000'.
const RANGOS_SOCIOS = [
  ['000000000', '760000000'],
  ['760000000', '760500000'],
  ['760500000', '761000000'],
  ['761000000', '762000000'],
  ['762000000', '763000000'],
  ['763000000', '764000000'],
  ['764000000', '765000000'],
  ['765000000', '766000000'],
  ['766000000', '767000000'],
  ['767000000', '768000000'],
  ['768000000', '769000000'],
  ['769000000', '770000000'],
  ['770000000', '771000000'],
  ['771000000', '772000000'],
  ['772000000', '773000000'],
  ['773000000', '774000000'],
  ['774000000', '776000000'],
  ['776000000', '778000000'],
  ['778000000', '786000000'],
  ['786000000', '800000000'],
  ['800000000', '966000000'],
  ['966000000', '968000000'],
  ['968000000', 'Z'],
]

const PASOS_DIRECTOS = ['master', 'ecu', 'ejecutivo_comer', 'ejecutivo_cel']

const client = new Client({ connectionString: dbUrl(), ssl: { rejectUnauthorized: false } })
await client.connect()
const steps = []

async function run(label, sql, params = []) {
  const inicio = Date.now()
  const { rows } = await client.query(sql, params)
  const ms = Date.now() - inicio
  const salida = rows[0] ? Object.values(rows[0])[0] : 'ok'
  console.log(`[${label}] ${ms} ms ->`, JSON.stringify(salida))
  steps.push({ label, elapsed_ms: ms, result: salida })
  return rows[0]
}

try {
  const execution = await runGuardedHeavyJob(
    client,
    JOB_NAME,
    { forceOutsideWindow },
    async ({ assertMayContinue }) => {
      await assertMayContinue()

      if (!soloBdd) {
        // Paso 0. base_contact es una matview y es la UNICA fuente del sync CRM de
        // empresas_master. Si no se refresca, el sync corre sobre una foto vieja.
        console.log('== Paso 0: refresco de fuentes ==')
        await run('refresh:base_contact', 'select public.refresh_base_contact_dataset()')
        await assertMayContinue()
        await run('sync:crm', 'select public.refresh_empresas_master_crm()')
        await assertMayContinue()
        await run('fix:fonos_ecu', 'select public.repair_empresas_master_fonos_ecu()')

        console.log('== Paso 1: capa de telefonos ==')
        await client.query('truncate public.empresa_telefonos')

        for (const paso of PASOS_DIRECTOS) {
          await assertMayContinue()
          await run(`directas:${paso}`, 'select public.load_empresa_telefonos_directas($1)', [paso])
        }

        for (const [desde, hasta] of RANGOS_SOCIOS) {
          await assertMayContinue()
          await run(
            `socios:${desde}`,
            'select public.build_empresa_telefonos_socios_chunk($1, $2)',
            [desde, hasta]
          )
        }

        await client.query('analyze public.empresa_telefonos')
      }

      await assertMayContinue()
      console.log('== Paso 2: BDD discable ==')
      await client.query('truncate public.equifax_bdd_credito_b2b')

      const bddSteps = [
        ['exclusiones', "select public.build_bdd_credito_b2b('exclusiones')"],
        ['empresas', "select public.build_bdd_credito_b2b('empresas')"],
        ['conteo_tel', "select public.build_bdd_credito_b2b('conteo_tel')"],
        ['ola_1', "select public.build_bdd_insert_ola(1, 4, 'ola_1')"],
        ['ola_2', "select public.build_bdd_insert_ola(5, 7, 'ola_2')"],
        ['ola_3', 'select public.build_bdd_insert_ola3_rescate()'],
        ['marcar_compartidos', 'select public.marcar_telefonos_compartidos(20)'],
        ['numerar_cascada', 'select public.numerar_telefonos_por_empresa()'],
      ]

      for (const [label, sql] of bddSteps) {
        await assertMayContinue()
        await run(label, sql)
      }

      const { rows: [resumen] } = await client.query(`
        select jsonb_build_object(
          'telefonos', count(*),
          'empresas', count(distinct rutid),
          'por_tier', (select jsonb_object_agg(tier, n) from (select tier, count(*) n from public.equifax_bdd_credito_b2b group by 1) t),
          'por_ola', (select jsonb_object_agg(ola, n) from (select ola, count(*) n from public.equifax_bdd_credito_b2b group by 1) t),
          'rm', count(*) filter (where region ilike '%metropolitana%'),
          'regiones', count(*) filter (where region not ilike '%metropolitana%')
        ) resumen
        from public.equifax_bdd_credito_b2b
      `)
      console.log(JSON.stringify(resumen.resumen, null, 2))
      return { solo_bdd: soloBdd, steps, resumen: resumen.resumen }
    }
  )

  if (execution.skipped) {
    console.log(`[${JOB_NAME}] omitido: ${execution.reason}`)
  }
} finally {
  await client.end()
}
