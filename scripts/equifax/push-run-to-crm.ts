export {}

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.local')

async function main() {
  const runId = process.argv[2]
  if (!runId) {
    throw new Error('Debes indicar el run_id de Equifax.')
  }

  const { pushEquifaxRunToCrm } = await import('@/lib/services/equifax-crm')
  const result = await pushEquifaxRunToCrm(runId)
  process.stdout.write(JSON.stringify(result, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
