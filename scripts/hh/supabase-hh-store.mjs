import { createClient } from '@supabase/supabase-js'

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
  if (!url || !key) return null
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  )
}

async function upsertChunked(supabase, table, rows, options, chunkSize = 500) {
  if (!rows.length) return { count: 0 }
  let count = 0
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    const { error } = await supabase.from(table).upsert(chunk, options)
    if (error) throw new Error(`${table}: ${error.message}`)
    count += chunk.length
  }
  return { count }
}

export async function persistHistoricalRun(payload, { jsonPath = null, reportPath = null } = {}) {
  const supabase = getSupabaseClient()
  if (!supabase) {
    return { skipped: true, reason: 'missing_supabase_env' }
  }

  const meetings = payload.historical.meetings.map(meeting => compactObject({
    source_id: meeting.source,
    meeting_date: meeting.date,
    hippodrome: 'Valparaiso Sporting',
    description: meeting.meeting,
    program_status: meeting.programLinks?.length ? 'available' : 'unknown',
    raw_payload: meeting,
  }))

  await upsertChunked(supabase, 'hh_racing_meetings', meetings, {
    onConflict: 'source_id,meeting_date,hippodrome',
  })

  const meetingIdByKey = new Map()
  if (meetings.length) {
    const dates = [...new Set(meetings.map(item => item.meeting_date))]
    const { data, error } = await supabase
      .from('hh_racing_meetings')
      .select('id, source_id, meeting_date, hippodrome')
      .in('meeting_date', dates)
    if (error) throw new Error(`hh_racing_meetings select: ${error.message}`)
    for (const row of data ?? []) {
      meetingIdByKey.set(`${row.source_id}::${row.meeting_date}::${row.hippodrome}`, row.id)
    }
  }

  const races = payload.historical.races.map(race => compactObject({
    source_id: race.source,
    meeting_id: meetingIdByKey.get(`${race.source}::${race.date}::${race.hippodrome}`),
    race_date: race.date,
    hippodrome: race.hippodrome,
    race_number: race.race_number,
    title: race.title,
    race_type: race.race_type,
    distance_meters: race.distance_meters,
    surface: race.surface,
    track_condition: race.track_condition,
    participants_count: race.participants_count,
    winner: race.winner,
    final_time: race.final_time,
    favorite: race.favorite,
    retirements: race.retirements,
    source_url: race.source_url,
    raw_payload: race,
  }))

  await upsertChunked(supabase, 'hh_racing_races', races, {
    onConflict: 'source_id,race_date,hippodrome,race_number,source_url',
  })

  const raceIdByKey = new Map()
  if (races.length) {
    const dates = [...new Set(races.map(item => item.race_date))]
    const { data, error } = await supabase
      .from('hh_racing_races')
      .select('id, source_id, race_date, hippodrome, race_number, source_url')
      .in('race_date', dates)
    if (error) throw new Error(`hh_racing_races select: ${error.message}`)
    for (const row of data ?? []) {
      raceIdByKey.set(`${row.source_id}::${row.race_date}::${row.hippodrome}::${row.race_number}::${row.source_url ?? ''}`, row.id)
    }
  }

  const results = payload.historical.races.flatMap(race => (
    race.participants.map(result => compactObject({
      race_id: raceIdByKey.get(`${race.source}::${race.date}::${race.hippodrome}::${race.race_number}::${race.source_url ?? ''}`),
      source_id: result.source,
      source_url: result.source_url,
      race_date: result.date,
      hippodrome: result.hippodrome,
      race_number: result.race_number,
      horse: result.horse,
      horse_key: result.horse_key,
      final_position: result.final_position,
      saddle_number: result.saddle_number,
      jockey: result.jockey,
      jockey_key: result.jockey_key,
      trainer: result.trainer,
      trainer_key: result.trainer_key,
      stud: result.stud,
      age: result.age,
      assigned_weight_kg: result.assigned_weight_kg,
      horse_weight_kg: result.horse_weight_kg,
      jockey_weight_kg: result.jockey_weight_kg,
      dividend: result.dividend,
      beaten_margin: result.beaten_margin,
      raw_payload: result,
    }))
  ))

  await upsertChunked(supabase, 'hh_racing_results', results, {
    onConflict: 'source_id,race_date,hippodrome,race_number,horse_key',
  })

  return {
    skipped: false,
    jsonPath,
    reportPath,
    meetings: meetings.length,
    races: races.length,
    results: results.length,
  }
}

export async function persistWeekRun(payload, { jsonPath = null, reportPath = null } = {}) {
  const supabase = getSupabaseClient()
  if (!supabase) {
    return { skipped: true, reason: 'missing_supabase_env' }
  }

  const meetings = payload.races.map(race => compactObject({
    source_id: race.hipodromo_id === 3 ? 'clubhipico'
      : race.hipodromo_id === 4 ? 'hipodromo-chile'
        : race.hipodromo_id === 1 ? 'concepcion'
          : race.hipodromo_id === 2 ? 'sporting'
            : 'teletrak',
    meeting_date: race.fecha,
    hippodrome: race.hipodromo,
    description: race.descripcion,
    scheduled_time: race.hora,
    program_url: race.programa_pdf || null,
    program_status: race.programa_pdf ? 'available' : 'pending',
    raw_payload: race,
  }))

  await upsertChunked(supabase, 'hh_racing_meetings', meetings, {
    onConflict: 'source_id,meeting_date,hippodrome',
  })

  const { data: run, error: runError } = await supabase
    .from('hh_racing_prediction_runs')
    .insert({
      run_type: 'week',
      from_date: payload.options.from,
      to_date: payload.options.to,
      status: 'completed',
      model_version: 'hh-week-pdf-baseline-0.1',
      report_path: reportPath,
      json_path: jsonPath,
      summary: {
        meetings: meetings.length,
        projected_programs: payload.projections.filter(item => item.status === 'proyectado').length,
      },
      completed_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (runError) throw new Error(`hh_racing_prediction_runs: ${runError.message}`)

  const programEntries = []
  const predictions = []

  for (const projection of payload.projections) {
    const sourceId = projection.hipodromo_id === 3 ? 'clubhipico'
      : projection.hipodromo_id === 4 ? 'hipodromo-chile'
        : projection.hipodromo_id === 1 ? 'concepcion'
          : projection.hipodromo_id === 2 ? 'sporting'
            : 'teletrak'

    for (const race of projection.races ?? []) {
      for (const row of race.predictions ?? []) {
        const entryCommon = {
          source_id: sourceId,
          race_date: projection.fecha,
          hippodrome: projection.hipodromo,
          race_number: race.race_number,
          horse: row.horse,
          horse_key: row.horse_key,
          saddle_number: row.number,
          jockey: row.jockey,
          trainer: row.trainer,
          program_url: projection.pdf_url,
          recent_positions: row.recent_positions ?? [],
          last_dividend: row.last_dividend,
          raw_payload: row,
        }
        programEntries.push(compactObject({
          ...entryCommon,
          scheduled_time: race.time,
        }))
        predictions.push(compactObject({
          run_id: run.id,
          source_id: sourceId,
          race_date: projection.fecha,
          hippodrome: projection.hipodromo,
          race_number: race.race_number,
          horse: row.horse,
          horse_key: row.horse_key,
          saddle_number: row.number,
          jockey: row.jockey,
          trainer: row.trainer,
          win_probability: row.win_probability,
          podium_probability: row.podium_probability,
          risk: row.risk,
          score: row.raw_score,
          signal: row.signal,
          raw_payload: row,
        }))
      }
    }
  }

  await upsertChunked(supabase, 'hh_racing_program_entries', programEntries, {
    onConflict: 'source_id,race_date,hippodrome,race_number,horse_key',
  })
  await upsertChunked(supabase, 'hh_racing_predictions', predictions, {
    onConflict: 'run_id,source_id,race_date,hippodrome,race_number,horse_key',
  })

  return {
    skipped: false,
    runId: run.id,
    meetings: meetings.length,
    programEntries: programEntries.length,
    predictions: predictions.length,
  }
}
