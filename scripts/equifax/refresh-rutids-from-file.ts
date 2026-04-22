export {}

import { readFileSync } from 'node:fs'

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.production')

function readFlag(name: string) {
  return process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))]
}

function chunk<T>(items: T[], size: number) {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

async function main() {
  const inputPath = readFlag('input')
  if (!inputPath) {
    throw new Error('Falta --input=/ruta/al/archivo.txt')
  }

  const batchSize = Math.max(100, Math.min(2000, Number(readFlag('batch-size') ?? 500)))
  const startBatch = Math.max(0, Number(readFlag('start-batch') ?? 0))
  const maxBatches = readFlag('max-batches') ? Number(readFlag('max-batches')) : null
  const startedAt = new Date().toISOString()

  const raw = readFileSync(inputPath, 'utf8')
  const rutids = uniqueStrings(raw.split(/\r?\n/))
  const batches = chunk(rutids, batchSize)

  const { refreshEquifaxLeadScoresForRutids } = await import('@/lib/services/equifax-scoring')

  let refreshedRutids = 0
  let refreshedBatches = 0
  let lastRutid: string | null = null

  for (let index = startBatch; index < batches.length; index += 1) {
    if (maxBatches !== null && refreshedBatches >= maxBatches) break

    const subset = batches[index]
    if (!subset?.length) continue

    await refreshEquifaxLeadScoresForRutids(subset)
    refreshedRutids += subset.length
    refreshedBatches += 1
    lastRutid = subset[subset.length - 1] ?? lastRutid

    if (refreshedBatches % 20 === 0) {
      process.stdout.write(`${JSON.stringify({
        batch_index: index,
        refreshed_rutids: refreshedRutids,
        refreshed_batches: refreshedBatches,
        last_rutid: lastRutid,
      })}\n`)
    }
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    total_rutids_in_file: rutids.length,
    refreshed_rutids: refreshedRutids,
    refreshed_batches: refreshedBatches,
    batch_size: batchSize,
    start_batch: startBatch,
    max_batches: maxBatches,
    last_rutid: lastRutid,
    input_path: inputPath,
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
