export {}

async function main() {
  process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.local')
  const { trainEquifaxLogisticModels } = await import('@/lib/services/equifax-scoring')
  const result = await trainEquifaxLogisticModels({
    activate: true,
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
