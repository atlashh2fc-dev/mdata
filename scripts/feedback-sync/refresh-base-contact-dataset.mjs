import pg from 'pg'
import {
  forceHeavyJobOutsideWindow,
  runGuardedHeavyJob,
} from '../../lib/services/heavy-job-guard.mjs'

const { Client } = pg

function postgresConnectionString() {
  const raw = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || process.env.DATABASE_URL
  if (!raw) throw new Error('Falta POSTGRES_URL_NON_POOLING/POSTGRES_URL/DATABASE_URL')
  const url = new URL(raw)
  url.searchParams.delete('sslmode')
  return url.toString()
}

const client = new Client({
  connectionString: postgresConnectionString(),
  ssl: { rejectUnauthorized: false },
})

await client.connect()

try {
  const execution = await runGuardedHeavyJob(
    client,
    'base_contact_pipeline',
    {
      forceOutsideWindow: forceHeavyJobOutsideWindow(),
      telemetryResult: value => ({
        dataset: value.dataset,
        empresas_master_crm: value.empresas_master_crm,
      }),
    },
    async ({ assertMayContinue }) => {
      const { rows: datasetRows } = await client.query(
        'select public.refresh_base_contact_dataset() as result'
      )
      await assertMayContinue()
      const { rows: crmRows } = await client.query(
        'select public.refresh_empresas_master_crm() as result'
      )
      return {
        dataset: datasetRows[0]?.result ?? null,
        empresas_master_crm: crmRows[0]?.result ?? null,
      }
    }
  )
  console.log(JSON.stringify(execution, null, 2))
} finally {
  await client.end()
}
