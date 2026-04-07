import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/db/supabase'
import { search, SafeSearchType } from 'duck-duck-scrape'

const INCEPTION_URL = 'https://api.inceptionlabs.ai/v1/chat/completions'
const INCEPTION_KEY = process.env.INCEPTION_API_KEY

async function fetchStats() {
  const supabase = await createSupabaseServerClient()
  const { data } = await supabase.from('dashboard_stats').select('*').single()
  return data
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    if (!INCEPTION_KEY) {
      return NextResponse.json({ error: 'INCEPTION_API_KEY no configurada' }, { status: 500 })
    }

    const { messages } = await req.json()
    
    // Obtener contexto de BD real
    const stats = await fetchStats()
    const systemPrompt = `Eres el "Cerebro de Negocios" de la plataforma RUT Intelligence. 
Eres un experto de inteligencia de negocios, venta consultiva y análisis estratégico en Chile.
Tienes acceso al volumen total de la base de datos de los 9.5 millones de personas.
El usuario te pedirá sugerencias sobre industrias, cruces de datos, prospección de clientes, etc.
Tu objetivo es sugerir qué segmentos de la base de datos debería crear o exportar para tener ventas exitosas y justificar el razonamiento.
Puedes buscar en internet libremente usando tu tool webSearch.
SIEMPRE usa el formato Markdown para tus respuestas, puedes incluir tablas o listados de segmentos sugeridos. Mantén un tono elegante y premium.

STATUS ACTUAL DE LA BASE DE DATOS (KPIs en vivo):
${JSON.stringify(stats, null, 2)}
`

    let currentMessages = [
      { role: 'system', content: systemPrompt },
      ...(messages || [])
    ]

    const tools = [
      {
        type: 'function',
        function: {
          name: 'webSearch',
          description: 'Busca informacion en la web usando DuckDuckGo. Usa esto para buscar datos sobre industrias de alto valor, ventas de autos, bienes raices, etc que ayuden a enriquecer tu sugerencia de negocio.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'La consulta a buscar en internet'
              }
            },
            required: ['query']
          }
        }
      }
    ]

    // 1. LLamada a InceptionLabs
    let res = await fetch(INCEPTION_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${INCEPTION_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'mercury-2',
        messages: currentMessages,
        tools: tools,
        tool_choice: 'auto'
      })
    })

    let data = await res.json()

    // 2. Ejecutar function calling si lo pide
    if (data.choices?.[0]?.message?.tool_calls) {
      const toolCalls = data.choices[0].message.tool_calls
      currentMessages.push(data.choices[0].message)

      for (const tc of toolCalls) {
        if (tc.function.name === 'webSearch') {
          try {
            const args = JSON.parse(tc.function.arguments)
            console.log('Realizando busqueda:', args.query)
            const searchResults = await search(args.query, { safeSearch: SafeSearchType.OFF })
            const topResults = searchResults.results.slice(0, 3).map(r => `Titulo: ${r.title}\nUrl: ${r.url}\nResumen: ${r.description}`).join('\n\n')
            currentMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: topResults || 'Sin resultados'
            })
          } catch(e) {
             currentMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: 'Error en la busqueda o sin resultados disponibles.'
            })
          }
        }
      }

      // Volver a llamar al LLM con la data de la tool
      res = await fetch(INCEPTION_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${INCEPTION_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'mercury-2',
          messages: currentMessages
        })
      })
      data = await res.json()
    }

    return NextResponse.json({ success: true, message: data.choices[0].message.content })
  } catch (error) {
    console.error('Error en AI Route:', error)
    return NextResponse.json({ error: 'Error procesando solicitud AI' }, { status: 500 })
  }
}
