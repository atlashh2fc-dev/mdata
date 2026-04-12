export {}

async function main() {
  process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.local')
  const { db } = await import('@/lib/db/supabase')
  const {
    refreshEquifaxLeadScoresForRutids,
    trainEquifaxLogisticModels,
  } = await import('@/lib/services/equifax-scoring')

  const rutids = new Set<string>()
  let from = 0
  const pageSize = 1000

  while (true) {
    const { data, error } = await db
      .from('contact_center_feedback')
      .select('rutid,matched_rutid,campaign_name')
      .or([
        'campaign_name.ilike.%equifax%',
        'campaign_name.ilike.%dicom%',
        'campaign_name.ilike.%riesgo comercial%',
        'campaign_name.ilike.%verificacion comercial%',
        'campaign_name.ilike.%informe comercial%',
      ].join(','))
      .range(from, from + pageSize - 1)

    if (error) {
      throw error
    }

    const rows = (data ?? []) as Array<{
      rutid: string | null
      matched_rutid: string | null
      campaign_name: string | null
    }>

    for (const row of rows) {
      const rutid = String(row.matched_rutid ?? row.rutid ?? '').trim()
      if (rutid) rutids.add(rutid)
    }

    if (rows.length < pageSize) break
    from += pageSize
  }

  const allRutids = [...rutids]
  for (let index = 0; index < allRutids.length; index += 500) {
    const subset = allRutids.slice(index, index + 500)
    await refreshEquifaxLeadScoresForRutids(subset)
  }

  const { count: activeModelCount, error: activeModelError } = await db
    .from('equifax_scoring_models')
    .select('*', { count: 'exact', head: true })
    .eq('model_key', 'equifax-lead')
    .eq('is_active', true)

  if (activeModelError) {
    throw activeModelError
  }

  const training = (activeModelCount ?? 0) > 0
    ? null
    : await trainEquifaxLogisticModels({
        activate: true,
      })

  process.stdout.write(JSON.stringify({
    ok: true,
    refreshed_rutids: allRutids.length,
    training,
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
