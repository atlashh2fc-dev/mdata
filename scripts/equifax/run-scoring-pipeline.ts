export {}

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.local')

async function main() {
  const modeArg = process.argv.find(arg => arg.startsWith('--mode='))
  const activationMode = modeArg?.split('=')[1] as 'safe' | 'force' | 'dry-run' | undefined

  const { runEquifaxScoringPipeline } = await import('@/lib/services/equifax-scoring')
  const result = await runEquifaxScoringPipeline({
    triggerSource: 'script',
    activationMode: activationMode ?? 'safe',
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
