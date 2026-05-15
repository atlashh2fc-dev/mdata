import pg from 'pg'

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
await client.query('set statement_timeout = 0')

try {
  const { rows } = await client.query('select public.refresh_base_contact_dataset() as result')
  console.log(JSON.stringify(rows[0]?.result ?? null, null, 2))
} finally {
  await client.end()
}
