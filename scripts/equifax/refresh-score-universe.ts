export {}

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.local')

function readFlag(name: string) {
  return process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`)
}

function parseRegions(value?: string | null) {
  return String(value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function normalizeOrder(value?: string | null): 'score_patrimonial' | 'cobertura_pct' | 'rutid' {
  const normalized = String(value ?? 'rutid').trim().toLowerCase()
  if (normalized === 'coverage-first' || normalized === 'cobertura_pct') return 'cobertura_pct'
  if (normalized === 'rutid') return 'rutid'
  return 'score_patrimonial'
}

function normalizeRequireContact(value?: string | null): 'any' | 'phone' | 'email' | 'none' {
  const normalized = String(value ?? 'any').trim().toLowerCase()
  if (normalized === 'phone' || normalized === 'email' || normalized === 'none') return normalized
  return 'any'
}

async function main() {
  const { refreshEquifaxLeadScoresForUniverse } = await import('@/lib/services/equifax-scoring')

  const result = await refreshEquifaxLeadScoresForUniverse({
    limit: readFlag('limit') ? Number(readFlag('limit')) : null,
    regions: parseRegions(readFlag('regions')),
    requireContact: normalizeRequireContact(readFlag('require-contact')),
    batchSize: readFlag('batch-size') ? Number(readFlag('batch-size')) : undefined,
    orderBy: normalizeOrder(readFlag('order')),
    dryRun: hasFlag('dry-run'),
  })

  process.stdout.write(JSON.stringify({
    ok: true,
    ...result,
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
