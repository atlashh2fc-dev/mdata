export {}

async function main() {
  process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.local')
  const { refreshEquifaxLeadScoresForRutids } = await import('@/lib/services/equifax-scoring')
  const rutids = process.argv.slice(2)
  if (rutids.length === 0) {
    console.error('Uso: npm run ops:equifax:refresh:scores -- <rutid1> <rutid2> ...')
    process.exit(1)
  }

  const result = await refreshEquifaxLeadScoresForRutids(rutids)
  process.stdout.write(JSON.stringify({
    ok: true,
    refreshed: result.size,
    rutids: [...result.keys()],
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
