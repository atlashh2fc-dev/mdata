export {}

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.production')

function readFlag(name: string) {
  return process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`)
}

function parsePrefixes(value?: string | null) {
  const normalized = String(value ?? '').trim()
  if (!normalized) {
    return Array.from({ length: 100 }, (_, index) => String(index).padStart(2, '0'))
  }

  return uniqueStrings(
    normalized
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => item.padStart(2, '0').slice(0, 2))
  )
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))]
}

async function main() {
  const batchSize = Math.max(100, Math.min(2000, Number(readFlag('batch-size') ?? 500)))
  const refreshLimit = readFlag('limit') ? Number(readFlag('limit')) : null
  const requireContact = hasFlag('require-contact')
  const dryRun = hasFlag('dry-run')
  const startAfter = readFlag('start-after') ?? null
  const prefixes = parsePrefixes(readFlag('prefixes'))
  const startedAt = new Date().toISOString()

  const { db } = await import('@/lib/db/supabase')
  const { refreshEquifaxLeadScoresForRutids } = await import('@/lib/services/equifax-scoring')

  let selectedRutids = 0
  let refreshedRutids = 0
  let refreshedBatches = 0
  let lastRutid = startAfter

  for (const prefix of prefixes) {
    const nextPrefix = String(Number(prefix) + 1).padStart(2, '0')
    let prefixLastRutid = lastRutid && lastRutid.startsWith(prefix) ? lastRutid : null

    while (refreshLimit === null || selectedRutids < refreshLimit) {
      const limit = refreshLimit === null
        ? batchSize
        : Math.min(batchSize, Math.max(refreshLimit - selectedRutids, 0))

      if (limit <= 0) break

      let query = db
        .from('personas_master')
        .select('rutid')
        .not('razon_social_empresa', 'is', null)
        .gte('rutid', prefix)
        .lt('rutid', nextPrefix)
        .order('rutid', { ascending: true })
        .limit(limit)

      if (prefixLastRutid) {
        query = query.gt('rutid', prefixLastRutid)
      }

      if (requireContact) {
        query = query.or('email.not.is.null,fono_cel.not.is.null')
      }

      const { data, error } = await query

      if (error) {
        console.error('[refresh-master-pyme-universe]', error)
        throw new Error(`No se pudo leer el universo PyME desde personas_master para el prefijo ${prefix}.`)
      }

      const subset = uniqueStrings((data ?? []).map(row => row.rutid))
      if (!subset.length) break

      selectedRutids += subset.length
      prefixLastRutid = subset[subset.length - 1] ?? prefixLastRutid
      lastRutid = prefixLastRutid

      if (!dryRun) {
        await refreshEquifaxLeadScoresForRutids(subset)
        refreshedRutids += subset.length
        refreshedBatches += 1
      }

      if ((dryRun ? selectedRutids : refreshedRutids) % (batchSize * 20) === 0) {
        process.stdout.write(`${JSON.stringify({
          prefix,
          selected_rutids: selectedRutids,
          refreshed_rutids: refreshedRutids,
          refreshed_batches: refreshedBatches,
          last_rutid: lastRutid,
        })}\n`)
      }

      if (subset.length < limit) break
    }

    if (refreshLimit !== null && selectedRutids >= refreshLimit) {
      break
    }
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    strategy: 'personas_master-prefix-keyset-supabase',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    selected_rutids: selectedRutids,
    refreshed_rutids: dryRun ? 0 : refreshedRutids,
    refreshed_batches: dryRun ? 0 : refreshedBatches,
    dry_run: dryRun,
    filters: {
      batch_size: batchSize,
      limit: refreshLimit,
      require_contact: requireContact,
      start_after: startAfter,
      prefixes,
    },
    last_rutid: lastRutid,
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
