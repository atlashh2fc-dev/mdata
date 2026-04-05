'use server'

import { supabaseAdmin } from '@/lib/db/supabase'
import type { AIAnalysisRequest, AIAnalysisResponse, AIAnalysisType } from '@/types'

const INCEPTION_API_URL = 'https://api.inceptionlabs.ai/v1/chat/completions'
const INCEPTION_MODEL = 'mercury-2'

interface InceptionMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface InceptionResponse {
  id: string
  choices: {
    message: { role: string; content: string }
    finish_reason: string
  }[]
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/**
 * Llama al API de Inception AI
 */
async function callInceptionAI(
  messages: InceptionMessage[],
  maxTokens = 1000
): Promise<{ content: string; tokens: number; durationMs: number }> {
  const apiKey = process.env.INCEPTION_API_KEY
  if (!apiKey) throw new Error('INCEPTION_API_KEY no configurado')

  const start = Date.now()

  const response = await fetch(INCEPTION_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: INCEPTION_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Inception AI error ${response.status}: ${errorText}`)
  }

  const result: InceptionResponse = await response.json()
  const content = result.choices?.[0]?.message?.content ?? ''
  const tokens = result.usage?.total_tokens ?? 0
  const durationMs = Date.now() - start

  return { content, tokens, durationMs }
}

/**
 * Servicio principal de análisis IA
 */
export async function analyzeWithAI(
  request: AIAnalysisRequest,
  userId?: string
): Promise<AIAnalysisResponse> {
  const start = Date.now()

  let messages: InceptionMessage[]
  let result: Record<string, unknown> = {}

  switch (request.type) {
    case 'enrichment':
      messages = buildEnrichmentPrompt(request)
      break
    case 'classification':
      messages = buildClassificationPrompt(request)
      break
    case 'scoring':
      messages = buildScoringPrompt(request)
      break
    case 'dataset':
      messages = buildDatasetAnalysisPrompt(request)
      break
    default:
      throw new Error(`Tipo de análisis no soportado: ${request.type}`)
  }

  const { content, tokens, durationMs } = await callInceptionAI(messages)

  // Intentar parsear JSON de la respuesta
  try {
    const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) ||
                      content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      result = JSON.parse(jsonMatch[1] ?? jsonMatch[0])
    } else {
      result = { text: content }
    }
  } catch {
    result = { text: content }
  }

  // Log en BD
  if (userId) {
    await supabaseAdmin.from('ai_analysis_logs').insert({
      analysis_type: request.type,
      input_data: request.data as Record<string, unknown>,
      output_data: result,
      model: INCEPTION_MODEL,
      tokens_used: tokens,
      duration_ms: durationMs,
      created_by: userId,
    })
  }

  return {
    type: request.type,
    result,
    model: INCEPTION_MODEL,
    tokens_used: tokens,
    duration_ms: durationMs,
  }
}

// ============================================================
// PROMPTS POR TIPO
// ============================================================

function buildEnrichmentPrompt(req: AIAnalysisRequest): InceptionMessage[] {
  const persona = req.data

  return [
    {
      role: 'system',
      content: `Eres un sistema de inteligencia de datos para el mercado chileno.
Tu tarea es enriquecer perfiles de personas basándote en datos disponibles.
Devuelve SIEMPRE un JSON estructurado con las inferencias.
Contexto adicional: ${req.context ?? 'ninguno'}`,
    },
    {
      role: 'user',
      content: `Enriquece el siguiente perfil con inferencias basadas en los datos disponibles:

${JSON.stringify(persona, null, 2)}

Devuelve un JSON con:
{
  "segmento_socioeconomico": "A|B|C1|C2|C3|D|E",
  "nivel_patrimonial": "alto|medio_alto|medio|medio_bajo|bajo",
  "perfil_empresarial": "empresario|profesional|empleado|independiente|desconocido",
  "zona_geografica": "inferencia de zona",
  "insights": ["insight 1", "insight 2", "insight 3"],
  "confianza": 0.0-1.0
}`,
    },
  ]
}

function buildClassificationPrompt(req: AIAnalysisRequest): InceptionMessage[] {
  return [
    {
      role: 'system',
      content: `Eres un clasificador de datos para el mercado chileno.
Clasifica personas en segmentos de negocio precisos.
Devuelve SIEMPRE un JSON estructurado.`,
    },
    {
      role: 'user',
      content: `Clasifica el siguiente perfil en segmentos de negocio:

${JSON.stringify(req.data, null, 2)}

Devuelve un JSON con:
{
  "categoria_principal": "string",
  "categorias_secundarias": ["cat1", "cat2"],
  "propension_compra": {
    "auto_nuevo": 0.0-1.0,
    "inmobiliario": 0.0-1.0,
    "productos_financieros": 0.0-1.0,
    "seguros": 0.0-1.0
  },
  "tags": ["tag1", "tag2"],
  "razon": "explicacion breve"
}`,
    },
  ]
}

function buildScoringPrompt(req: AIAnalysisRequest): InceptionMessage[] {
  return [
    {
      role: 'system',
      content: `Eres un motor de scoring patrimonial y crediticio para el mercado chileno.
Genera scores numéricos precisos basados en los datos disponibles.
Devuelve SIEMPRE un JSON estructurado.`,
    },
    {
      role: 'user',
      content: `Genera el scoring del siguiente perfil:

${JSON.stringify(req.data, null, 2)}

Devuelve un JSON con:
{
  "score_total": 0-1000,
  "score_patrimonial": 0-100,
  "score_empresarial": 0-100,
  "score_contactabilidad": 0-100,
  "riesgo": "bajo|medio|alto|muy_alto",
  "factores_positivos": ["factor1", "factor2"],
  "factores_negativos": ["factor1"],
  "recomendaciones": ["rec1", "rec2"]
}`,
    },
  ]
}

function buildDatasetAnalysisPrompt(req: AIAnalysisRequest): InceptionMessage[] {
  return [
    {
      role: 'system',
      content: `Eres un analista de datasets para una plataforma de inteligencia de datos.
Analiza la calidad, estructura y valor de negocio de datasets.
Devuelve SIEMPRE un JSON estructurado.`,
    },
    {
      role: 'user',
      content: `Analiza el siguiente dataset y genera un reporte de calidad:

${JSON.stringify(req.data, null, 2)}

Devuelve un JSON con:
{
  "calidad_general": 0-100,
  "columnas_valiosas": ["col1", "col2"],
  "columnas_problematicas": ["col1"],
  "duplicados_estimados_pct": 0-100,
  "completitud_pct": 0-100,
  "recomendaciones_limpieza": ["rec1", "rec2"],
  "valor_negocio": "alto|medio|bajo",
  "casos_uso_sugeridos": ["caso1", "caso2"]
}`,
    },
  ]
}
