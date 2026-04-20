export {}

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.local')

function readFlag(name: string) {
  return process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`)
}

function parseList(value?: string | null) {
  return String(value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function normalizeOrder(value?: string | null): 'score_patrimonial' | 'cobertura_pct' | 'rutid' {
  const normalized = String(value ?? 'patrimonial-first').trim().toLowerCase()
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
  const { generateEquifaxLeads } = await import('@/lib/services/equifax-bdd')

  const refreshUniverse = hasFlag('refresh-universe')
  const volume = Number(readFlag('volume') ?? 2000)
  const regions = parseList(readFlag('regions'))
  const productIds = parseList(readFlag('product-ids'))
  const minPhoneCount = Number(readFlag('min-phone-count') ?? 1)
  const minEmailCount = Number(readFlag('min-email-count') ?? 0)
  const scoredUniverseLimit = Number(readFlag('scored-universe-limit') ?? Math.max(volume * 12, 8000))

  const refreshResult = refreshUniverse
    ? await refreshEquifaxLeadScoresForUniverse({
        limit: readFlag('refresh-limit') ? Number(readFlag('refresh-limit')) : null,
        regions,
        requireContact: normalizeRequireContact(readFlag('refresh-require-contact')),
        batchSize: readFlag('refresh-batch-size') ? Number(readFlag('refresh-batch-size')) : undefined,
        orderBy: normalizeOrder(readFlag('refresh-order')),
        dryRun: hasFlag('dry-run'),
      })
    : null

  if (hasFlag('dry-run')) {
    process.stdout.write(JSON.stringify({
      ok: true,
      dry_run: true,
      refresh: refreshResult,
    }, null, 2))
    return
  }

  const result = await generateEquifaxLeads({
    volume,
    product_ids: productIds,
    prompt: readFlag('prompt') ?? null,
    regions,
    include_existing_customers: !hasFlag('exclude-existing-customers'),
    min_phone_count: minPhoneCount,
    min_email_count: minEmailCount,
    scenario_key: 'solo_verdes',
    universe_source: 'scored_universe',
    allowed_temperatures: ['green'],
    scored_universe_limit: Number.isFinite(scoredUniverseLimit) ? scoredUniverseLimit : null,
  })

  process.stdout.write(JSON.stringify({
    ok: true,
    refresh: refreshResult,
    result,
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
