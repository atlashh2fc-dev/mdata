import fs from 'node:fs'
import path from 'node:path'

process.loadEnvFile?.(process.env.ENV_FILE ?? '.env.production')

const INCEPTION_URL = 'https://api.inceptionlabs.ai/v1/chat/completions'
const INCEPTION_MODEL = process.env.INCEPTION_MODEL || 'mercury-2'
const DEFAULT_INPUT = 'exports/crm/base_unificada_dicom_desde_marzo_disponible_propension_2026-04-28.csv'
const DEFAULT_OUTPUT = 'exports/crm/base_unificada_dicom_desde_marzo_disponible_propension_ai_2026-04-28.csv'
const DEFAULT_CHECKPOINT = 'exports/crm/base_unificada_dicom_desde_marzo_disponible_propension_ai_2026-04-28.jsonl'
const AI_COLUMNS = [
  'ai_contactability_score',
  'ai_purchase_propensity_score',
  'ai_temperature',
  'ai_confidence',
  'ai_recommended_action',
  'ai_risk_flags',
  'ai_reason',
  'ai_model',
  'ai_scored_at',
]

function readFlag(name, fallback = null) {
  const arg = process.argv.find(item => item.startsWith(`--${name}=`))
  if (!arg) return fallback
  return arg.split('=').slice(1).join('=')
}

function readBooleanFlag(name, fallback = false) {
  const raw = readFlag(name)
  if (raw === null) return fallback
  return ['1', 'true', 'yes', 'y'].includes(raw.toLowerCase())
}

function parseCsvLine(line) {
  const out = []
  let current = ''
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (char === ',' && !quoted) {
      out.push(current)
      current = ''
    } else {
      current += char
    }
  }

  out.push(current)
  return out
}

function escapeCsv(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}

function readCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim()
  if (!raw) return { headers: [], rows: [] }

  const [headerLine, ...lines] = raw.split(/\r?\n/)
  const headers = parseCsvLine(headerLine)
  const rows = lines.map(line => parseCsvLine(line))
  return { headers, rows }
}

function writeCsv(filePath, headers, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    [
      headers.join(','),
      ...rows.map(row => row.map(escapeCsv).join(',')),
    ].join('\n') + '\n'
  )
}

function buildIndex(headers) {
  return Object.fromEntries(headers.map((header, index) => [header, index]))
}

function ensureColumns(headers, rows, columns) {
  for (const column of columns) {
    if (headers.includes(column)) continue
    headers.push(column)
    for (const row of rows) row.push('')
  }
  return buildIndex(headers)
}

function readCheckpoint(filePath) {
  const map = new Map()
  if (!fs.existsSync(filePath)) return map

  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    try {
      const record = JSON.parse(line)
      if (record?.rutid) map.set(String(record.rutid), record)
    } catch {
      // Ignore partial/corrupt checkpoint lines.
    }
  }

  return map
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function appendCheckpoint(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`)
}

function rowValue(row, idx, column) {
  const index = idx[column]
  return index === undefined ? '' : row[index]
}

function toNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value))
}

function normalizeTemperature(value) {
  const normalized = String(value ?? '').toLowerCase()
  if (normalized === 'green' || normalized === 'verde') return 'green'
  if (normalized === 'yellow' || normalized === 'amarillo') return 'yellow'
  return 'red'
}

function normalizeConfidence(value) {
  const normalized = String(value ?? '').toLowerCase()
  if (normalized === 'alta' || normalized === 'high') return 'alta'
  if (normalized === 'media' || normalized === 'medium') return 'media'
  return 'baja'
}

function fallbackAssessment(row, idx) {
  const contactability = toNumber(rowValue(row, idx, 'contact_probability'))
  const purchase = toNumber(rowValue(row, idx, 'purchase_probability'))
  const commercialTemperature = rowValue(row, idx, 'commercial_temperature') || rowValue(row, idx, 'lead_temperature')
  const confidence = rowValue(row, idx, 'score_confidence') || 'baja'

  return {
    contactability_score: clamp(contactability),
    purchase_propensity_score: clamp(purchase),
    temperature: normalizeTemperature(commercialTemperature),
    confidence: normalizeConfidence(confidence),
    recommended_action: confidence === 'baja' ? 'enriquecer_antes_de_contactar' : 'contactar',
    risk_flags: confidence === 'baja' ? ['baja_calidad_features'] : [],
    reason: 'Fallback deterministico por error o modo dry-run.',
  }
}

function buildPrompt(row, idx) {
  const payload = {
    rutid: rowValue(row, idx, 'rutid'),
    nombre_o_razon_social: rowValue(row, idx, 'name'),
    region: rowValue(row, idx, 'region'),
    comuna: rowValue(row, idx, 'comuna'),
    tiene_telefono: Boolean(rowValue(row, idx, 'phone')),
    tiene_email: Boolean(rowValue(row, idx, 'email')),
    estado_disponible: rowValue(row, idx, 'estado_disponible'),
    bases_origen: rowValue(row, idx, 'source_bases'),
    modelo_tabular: {
      lead_temperature: rowValue(row, idx, 'lead_temperature'),
      commercial_temperature: rowValue(row, idx, 'commercial_temperature'),
      lead_score: toNumber(rowValue(row, idx, 'lead_score')),
      contact_probability: toNumber(rowValue(row, idx, 'contact_probability')),
      interest_probability: toNumber(rowValue(row, idx, 'interest_probability')),
      purchase_probability: toNumber(rowValue(row, idx, 'purchase_probability')),
      score_confidence: rowValue(row, idx, 'score_confidence'),
      score_basis: rowValue(row, idx, 'score_basis'),
    },
  }

  return [
    {
      role: 'system',
      content: [
        'Eres un analista senior de propension comercial B2B para Equifax Chile.',
        'Evalua UNA fila de una base limpia Dicom/CRM y valida el semaforo de propension.',
        'Prioriza proteger contactabilidad y venta: ante poca evidencia, baja confianza y recomienda enriquecimiento.',
        'No inventes datos externos. Usa solo el JSON entregado.',
        'Devuelve solo JSON valido, sin markdown.',
      ].join(' '),
    },
    {
      role: 'user',
      content: `Evalua esta fila y responde con este esquema exacto:
{
  "contactability_score": 0-100,
  "purchase_propensity_score": 0-100,
  "temperature": "green|yellow|red",
  "confidence": "alta|media|baja",
  "recommended_action": "contactar|contactar_suave|enriquecer_antes_de_contactar|descartar_temporal",
  "risk_flags": ["string"],
  "reason": "maximo 220 caracteres"
}

Reglas comerciales:
- green solo si hay buena probabilidad de contacto y compra, y evidencia suficiente.
- yellow si hay potencial pero falta maduracion o evidencia.
- red si falta evidencia, hay baja compra, mala contactabilidad o conviene proteger operacion.
- Si score_basis es pobre o score_confidence es baja, no marques green salvo que telefono/email y probabilidades sean muy fuertes.

Fila:
${JSON.stringify(payload)}`,
    },
  ]
}

function buildBatchPrompt(rows, idx) {
  const payload = rows.map((row, index) => ({
    row_number: index + 1,
    rutid: rowValue(row, idx, 'rutid'),
    nombre_o_razon_social: rowValue(row, idx, 'name'),
    region: rowValue(row, idx, 'region'),
    comuna: rowValue(row, idx, 'comuna'),
    tiene_telefono: Boolean(rowValue(row, idx, 'phone')),
    tiene_email: Boolean(rowValue(row, idx, 'email')),
    estado_disponible: rowValue(row, idx, 'estado_disponible'),
    bases_origen: rowValue(row, idx, 'source_bases'),
    modelo_tabular: {
      lead_temperature: rowValue(row, idx, 'lead_temperature'),
      commercial_temperature: rowValue(row, idx, 'commercial_temperature'),
      lead_score: toNumber(rowValue(row, idx, 'lead_score')),
      contact_probability: toNumber(rowValue(row, idx, 'contact_probability')),
      interest_probability: toNumber(rowValue(row, idx, 'interest_probability')),
      purchase_probability: toNumber(rowValue(row, idx, 'purchase_probability')),
      score_confidence: rowValue(row, idx, 'score_confidence'),
      score_basis: rowValue(row, idx, 'score_basis'),
    },
  }))

  return [
    {
      role: 'system',
      content: [
        'Eres un analista senior de propension comercial B2B para Equifax Chile.',
        'Evalua cada fila de forma independiente y valida el semaforo de propension.',
        'Prioriza proteger contactabilidad y venta: ante poca evidencia, baja confianza y recomienda enriquecimiento.',
        'No inventes datos externos. Usa solo el JSON entregado.',
        'Devuelve solo JSON valido, sin markdown.',
      ].join(' '),
    },
    {
      role: 'user',
      content: `Evalua cada fila y responde con este esquema exacto:
{
  "rows": [
    {
      "rutid": "string",
      "contactability_score": 0-100,
      "purchase_propensity_score": 0-100,
      "temperature": "green|yellow|red",
      "confidence": "alta|media|baja",
      "recommended_action": "contactar|contactar_suave|enriquecer_antes_de_contactar|descartar_temporal",
      "risk_flags": ["string"],
      "reason": "maximo 180 caracteres"
    }
  ]
}

Reglas comerciales:
- Evalua fila por fila; no promedies el lote.
- green solo si hay buena probabilidad de contacto y compra, y evidencia suficiente.
- yellow si hay potencial pero falta maduracion o evidencia.
- red si falta evidencia, hay baja compra, mala contactabilidad o conviene proteger operacion.
- Si no hay telefono ni email, no marques green aunque compra sea alta.
- Si score_basis es pobre o score_confidence es baja, no marques green salvo que telefono/email y probabilidades sean muy fuertes.
- Debes devolver exactamente ${rows.length} objetos, uno por rutid.

Filas:
${JSON.stringify(payload)}`,
    },
  ]
}

function parseModelJson(content) {
  const text = String(content ?? '').trim()
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/) || text.match(/\[[\s\S]*\]/)
  const raw = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text
  return JSON.parse(raw)
}

async function callInception(messages, maxTokens, retries) {
  const apiKey = process.env.INCEPTION_API_KEY
  if (!apiKey) throw new Error('INCEPTION_API_KEY no configurado.')

  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(INCEPTION_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: INCEPTION_MODEL,
          messages,
          max_tokens: maxTokens,
          temperature: 0.5,
        }),
      })

      if (!response.ok) {
        const text = await response.text()
        if (response.status === 429 && attempt < retries) {
          await sleep(Math.min(120000, 30000 * (attempt + 1)))
          continue
        }
        throw new Error(`Inception ${response.status}: ${text.slice(0, 500)}`)
      }

      const result = await response.json()
      const content = result.choices?.[0]?.message?.content ?? ''
      if (!content.trim()) {
        throw new Error('Respuesta IA vacia.')
      }
      return {
        parsed: parseModelJson(content),
        raw_content: content,
        tokens: result.usage?.total_tokens ?? 0,
      }
    } catch (error) {
      lastError = error
      if (attempt < retries) {
        const message = error instanceof Error ? error.message : String(error)
        const delay = message.includes('429') || message.includes('rate_limit')
          ? Math.min(120000, 30000 * (attempt + 1))
          : 1000 * (attempt + 1)
        await sleep(delay)
      }
    }
  }

  throw lastError
}

function normalizeAssessment(parsed, fallback) {
  return {
    contactability_score: clamp(toNumber(parsed?.contactability_score ?? fallback.contactability_score)),
    purchase_propensity_score: clamp(toNumber(parsed?.purchase_propensity_score ?? fallback.purchase_propensity_score)),
    temperature: normalizeTemperature(parsed?.temperature ?? fallback.temperature),
    confidence: normalizeConfidence(parsed?.confidence ?? fallback.confidence),
    recommended_action: String(parsed?.recommended_action ?? fallback.recommended_action).slice(0, 80),
    risk_flags: Array.isArray(parsed?.risk_flags)
      ? parsed.risk_flags.map(item => String(item).slice(0, 80)).slice(0, 8)
      : fallback.risk_flags,
    reason: String(parsed?.reason ?? fallback.reason).slice(0, 260),
  }
}

function applyAssessment(row, idx, assessment, model, scoredAt) {
  row[idx.ai_contactability_score] = String(assessment.contactability_score)
  row[idx.ai_purchase_propensity_score] = String(assessment.purchase_propensity_score)
  row[idx.ai_temperature] = assessment.temperature
  row[idx.ai_confidence] = assessment.confidence
  row[idx.ai_recommended_action] = assessment.recommended_action
  row[idx.ai_risk_flags] = assessment.risk_flags.join('|')
  row[idx.ai_reason] = assessment.reason
  row[idx.ai_model] = model
  row[idx.ai_scored_at] = scoredAt
}

async function main() {
  const inputPath = readFlag('input', DEFAULT_INPUT)
  const outputPath = readFlag('output', DEFAULT_OUTPUT)
  const checkpointPath = readFlag('checkpoint', DEFAULT_CHECKPOINT)
  const limit = readFlag('limit') === null ? null : Math.max(0, Number(readFlag('limit')))
  const offset = Math.max(0, Number(readFlag('offset', 0)))
  const maxTokens = Math.max(300, Number(readFlag('max-tokens', 500)))
  const retries = Math.max(0, Number(readFlag('retries', 5)))
  const dryRun = readBooleanFlag('dry-run', false)
  const flushEvery = Math.max(1, Number(readFlag('flush-every', 25)))
  const concurrency = Math.max(1, Math.min(12, Number(readFlag('concurrency', 1))))
  const rowBatchSize = Math.max(1, Math.min(20, Number(readFlag('row-batch-size', 1))))

  const { headers, rows } = readCsv(inputPath)
  if (!headers.length) throw new Error(`CSV vacio o no encontrado: ${inputPath}`)
  let idx = ensureColumns(headers, rows, AI_COLUMNS)
  const checkpoint = readCheckpoint(checkpointPath)

  for (const row of rows) {
    const existing = checkpoint.get(rowValue(row, idx, 'rutid'))
    if (existing?.assessment) {
      applyAssessment(row, idx, existing.assessment, existing.model ?? INCEPTION_MODEL, existing.scored_at ?? '')
    }
  }

  let processed = 0
  let failed = 0
  let deferred = 0
  let skipped = 0
  const targetRows = rows.slice(offset, limit === null ? undefined : offset + limit)
  const pendingRows = []
  for (const row of targetRows) {
    const rutid = rowValue(row, idx, 'rutid')
    if (!rutid) {
      skipped += 1
      continue
    }
    if (checkpoint.has(rutid)) {
      skipped += 1
      continue
    }
    pendingRows.push(row)
  }

  const pendingBatches = []
  for (let index = 0; index < pendingRows.length; index += rowBatchSize) {
    pendingBatches.push(pendingRows.slice(index, index + rowBatchSize))
  }

  let nextIndex = 0
  let completedSinceFlush = 0
  let lastRutid = null

  async function processRow(row) {
    const rutid = rowValue(row, idx, 'rutid')

    const fallback = fallbackAssessment(row, idx)
    const scoredAt = new Date().toISOString()

    try {
      const response = dryRun
        ? { parsed: fallback, raw_content: JSON.stringify(fallback), tokens: 0 }
        : await callInception(buildPrompt(row, idx), maxTokens, retries)

      const assessment = normalizeAssessment(response.parsed, fallback)
      applyAssessment(row, idx, assessment, INCEPTION_MODEL, scoredAt)
      appendCheckpoint(checkpointPath, {
        rutid,
        model: INCEPTION_MODEL,
        scored_at: scoredAt,
        tokens: response.tokens,
        assessment,
      })
      processed += 1
      lastRutid = rutid
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('429') || message.includes('rate_limit')) {
        deferred += 1
      await sleep(60000)
      return
      }
      const assessment = {
        ...fallback,
        risk_flags: [...fallback.risk_flags, 'ai_error'],
        reason: message.slice(0, 240),
      }
      applyAssessment(row, idx, assessment, 'fallback-error', scoredAt)
      appendCheckpoint(checkpointPath, {
        rutid,
        model: 'fallback-error',
        scored_at: scoredAt,
        error: message,
        assessment,
      })
      failed += 1
      lastRutid = rutid
    }
  }

  async function processBatch(batch) {
    if (batch.length === 1) {
      await processRow(batch[0])
      return
    }

    const scoredAt = new Date().toISOString()
    const fallbacks = new Map(batch.map(row => [rowValue(row, idx, 'rutid'), fallbackAssessment(row, idx)]))

    try {
      const response = dryRun
        ? {
            parsed: {
              rows: batch.map(row => ({
                rutid: rowValue(row, idx, 'rutid'),
                ...fallbacks.get(rowValue(row, idx, 'rutid')),
              })),
            },
            raw_content: '',
            tokens: 0,
          }
        : await callInception(buildBatchPrompt(batch, idx), Math.max(maxTokens, 1800), retries)

      const parsedRows = Array.isArray(response.parsed)
        ? response.parsed
        : Array.isArray(response.parsed?.rows)
          ? response.parsed.rows
          : []
      const parsedByRutid = new Map(parsedRows.map(item => [String(item?.rutid ?? ''), item]))

      for (const row of batch) {
        const rutid = rowValue(row, idx, 'rutid')
        const fallback = fallbacks.get(rutid)
        const parsed = parsedByRutid.get(rutid)
        if (!parsed) {
          await processRow(row)
          continue
        }

        const assessment = normalizeAssessment(parsed, fallback)
        applyAssessment(row, idx, assessment, INCEPTION_MODEL, scoredAt)
        appendCheckpoint(checkpointPath, {
          rutid,
          model: INCEPTION_MODEL,
          scored_at: scoredAt,
          tokens: response.tokens,
          assessment,
          batch_size: batch.length,
        })
        processed += 1
        lastRutid = rutid
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('429') || message.includes('rate_limit')) {
        deferred += batch.length
        await sleep(60000)
        return
      }

      for (const row of batch) {
        await processRow(row)
      }
    }
  }

  async function worker() {
    while (nextIndex < pendingBatches.length) {
      const batch = pendingBatches[nextIndex]
      nextIndex += 1
      await processBatch(batch)
      completedSinceFlush += batch.length

      if (completedSinceFlush >= flushEvery) {
        completedSinceFlush = 0
        writeCsv(outputPath, headers, rows)
        process.stdout.write(`${JSON.stringify({
          processed,
          failed,
          skipped,
          pending: pendingRows.length - processed - failed - deferred,
          deferred,
          concurrency,
          row_batch_size: rowBatchSize,
          last_rutid: lastRutid,
          output: outputPath,
        })}\n`)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pendingRows.length) }, () => worker())
  )

  writeCsv(outputPath, headers, rows)
  idx = buildIndex(headers)

  const summary = {
    ok: true,
    input: inputPath,
    output: outputPath,
    checkpoint: checkpointPath,
    model: INCEPTION_MODEL,
    dry_run: dryRun,
    concurrency,
    row_batch_size: rowBatchSize,
    rows_in_file: rows.length,
    processed,
    failed,
    deferred,
    skipped,
    ai_green: rows.filter(row => row[idx.ai_temperature] === 'green').length,
    ai_yellow: rows.filter(row => row[idx.ai_temperature] === 'yellow').length,
    ai_red: rows.filter(row => row[idx.ai_temperature] === 'red').length,
    ai_high_confidence: rows.filter(row => row[idx.ai_confidence] === 'alta').length,
    ai_medium_confidence: rows.filter(row => row[idx.ai_confidence] === 'media').length,
    ai_low_confidence: rows.filter(row => row[idx.ai_confidence] === 'baja').length,
    finished_at: new Date().toISOString(),
  }

  process.stdout.write(JSON.stringify(summary, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
