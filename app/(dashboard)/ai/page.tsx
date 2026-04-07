'use client'

import React, { useState, useRef, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { BrainCircuit, Send, Sparkles, Globe, Target, Building2, ChevronRight, UserCircle2, Bot, Database } from 'lucide-react'

type Message = {
  role: 'user' | 'assistant' | 'tool'
  content: string
}

export default function CerebroDeNegociosPage() {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: `¡Hola! Soy InceptionLabs, tu **Cerebro Inteligente de Negocios**. \n\nTengo acceso en tiempo real a los 9.5 millones de perfiles, 5.2M de vehículos y 315K empresas en tu maestro de datos.\n\n¿En qué industria te gustaría que encontremos tu próximo segmento de alto valor hoy?` }
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages, loading])

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    if (!input.trim() || loading) return

    const userMsg = input.trim()
    setInput('')
    const newMessages = [...messages, { role: 'user', content: userMsg } as Message]
    setMessages(newMessages)
    setLoading(true)

    try {
      // Filtrar mensajes 'system' u otros ocultos si es necesario, pero mantenemos simple:
      const payload = newMessages.filter(m => m.role !== 'tool').map(m => ({
        role: m.role,
        content: m.content
      }))

      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: payload })
      })

      const data = await res.json()
      if (data.message) {
        setMessages(prev => [...prev, { role: 'assistant', content: data.message }])
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: 'Lo siento, ocurrió un error procesando la consulta.' }])
      }
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Error de conexión con la IA.' }])
    }
    setLoading(false)
  }

  // Helper para renderizar markdown súper simple: negritas y viñetas
  const renderMarkdown = (text: string) => {
    return text.split('\n').map((line, i) => {
      // Strong: **texto**
      const formatted = line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      
      if (formatted.startsWith('- ')) {
        return <li key={i} className="ml-4 list-disc marker:text-cyan-500 mb-1" dangerouslySetInnerHTML={{ __html: formatted.substring(2) }} />
      }
      return <p key={i} className="mb-2 last:mb-0" dangerouslySetInnerHTML={{ __html: formatted }} />
    })
  }

  return (
    <>
      <Header
        title="Cerebro de Negocios"
        subtitle="Inteligencia Artificial InceptionLabs + DuckDuckGo conectada a tus datos."
      />

      <div className="p-6 h-[calc(100vh-5rem)] flex gap-6">
        
        {/* Panel Izquierdo: Chat */}
        <div className="glass-panel flex-1 flex flex-col overflow-hidden relative group">
          <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/5 to-transparent pointer-events-none" />
          
          <div className="p-4 border-b border-white/10 flex items-center justify-between z-10 bg-[#0f172a]/50">
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="w-10 h-10 rounded-full bg-cyan-500/20 flex items-center justify-center border border-cyan-500/40 animate-glow">
                  <BrainCircuit className="w-5 h-5 text-cyan-400" />
                </div>
                <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-[#1e293b]" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  Inception Analyst
                  <span className="badge-brand text-[9px] px-1.5 py-0">Mercury-2</span>
                </h3>
                <p className="text-xs text-slate-400">En línea • Capacidad de búsqueda web habilitada</p>
              </div>
            </div>
            <Globe className="w-4 h-4 text-slate-500" />
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-6 z-10 scrollbar-thin">
            {messages.map((msg, idx) => (
              <div key={idx} className={`flex gap-4 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <div className="flex-shrink-0">
                  {msg.role === 'user' ? (
                    <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center">
                      <UserCircle2 className="w-5 h-5 text-slate-300" />
                    </div>
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-cyan-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
                      <Bot className="w-5 h-5 text-white" />
                    </div>
                  )}
                </div>
                <div className={`max-w-[80%] rounded-2xl p-4 ${
                  msg.role === 'user' 
                    ? 'bg-brand-600 text-white rounded-tr-sm shadow-md' 
                    : 'bg-[#1e293b]/80 border border-slate-700/50 text-slate-200 rounded-tl-sm shadow-[0_4px_20px_rgba(0,0,0,0.2)]'
                }`}>
                  <div className="text-sm leading-relaxed whitespace-pre-wrap">
                    {msg.role === 'assistant' ? renderMarkdown(msg.content) : msg.content}
                  </div>
                </div>
              </div>
            ))}
            
            {loading && (
              <div className="flex gap-4">
                <div className="w-8 h-8 rounded-full bg-cyan-600 flex items-center justify-center">
                  <Bot className="w-5 h-5 text-white animate-pulse" />
                </div>
                <div className="bg-[#1e293b]/80 border border-slate-700/50 text-slate-200 rounded-2xl rounded-tl-sm p-4 flex items-center gap-2 w-24">
                  <div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" />
                  <div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s'}} />
                  <div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s'}} />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <form onSubmit={handleSend} className="p-4 bg-[#0f172a]/60 border-t border-white/5 z-10">
            <div className="relative flex items-center">
              <input
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="Ej: Busca tendencias de aseguradoras y cruza un segmento..."
                disabled={loading}
                className="w-full bg-[#1e293b]/80 border border-[#334155] rounded-full pl-5 pr-12 py-3.5 text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500 transition-all shadow-inner"
              />
              <button
                type="submit"
                disabled={!input.trim() || loading}
                className="absolute right-2 p-2 bg-cyan-500 hover:bg-cyan-400 text-white rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_10px_rgba(6,182,212,0.3)]"
              >
                <Send className="w-4 h-4 ml-0.5" />
              </button>
            </div>
            <div className="flex justify-center gap-6 mt-3 text-[10px] text-slate-500 font-medium">
              <span className="flex items-center gap-1"><Sparkles className="w-3 h-3 text-amber-400" /> IA Contextual</span>
              <span className="flex items-center gap-1"><Globe className="w-3 h-3 text-blue-400" /> Búsqueda Web</span>
              <span className="flex items-center gap-1"><Database className="w-3 h-3 text-purple-400" /> 9.5M Registros</span>
            </div>
          </form>
        </div>

        {/* Panel Derecho: Sugerencias Rápidas */}
        <div className="w-80 flex flex-col gap-4">
          <div className="glass-panel p-5">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2 mb-4">
              <Target className="w-4 h-4 text-cyan-400" />
              Estrategias Sugeridas
            </h3>
            <div className="space-y-3">
              {[
                { title: 'Sector Inmobiliario', desc: 'RUTs con +2 propiedades para seguro hogar.' },
                { title: 'Seguros de Vida Pyme', desc: 'Dueños de empresa con patrimonio positivo.' },
                { title: 'Renovación Automotriz', desc: 'Propietarios de vehículos en la RM.' }
              ].map((sug, i) => (
                <button 
                  key={i}
                  onClick={() => setInput(`Analiza el ${sug.title.toLowerCase()}: ${sug.desc}`)}
                  className="w-full text-left p-3 rounded-lg border border-slate-700/50 bg-[#1e293b]/40 hover:bg-[#1e293b] hover:border-cyan-500/50 transition-all group"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-semibold text-white">{sug.title}</span>
                    <ChevronRight className="w-3 h-3 text-slate-500 group-hover:text-cyan-400 transition-colors" />
                  </div>
                  <p className="text-[10px] text-slate-400">{sug.desc}</p>
                </button>
              ))}
            </div>
          </div>

          <div className="glass-panel p-5 flex-1 relative overflow-hidden flex flex-col justify-end">
            <Building2 className="w-32 h-32 absolute -right-6 -bottom-6 text-slate-800/50" />
            <div className="relative z-10">
              <h4 className="text-sm font-bold text-white mb-2">Poder de los Datos</h4>
              <p className="text-xs text-slate-400 leading-relaxed mb-4">
                El motor analiza la correlación entre variables geográficas, patrimoniales y vehiculares instantáneamente antes de responder.
              </p>
              <div className="w-full h-1 bg-slate-800 rounded-full overflow-hidden">
                <div className="w-3/4 h-full bg-gradient-to-r from-cyan-600 to-cyan-400 animate-pulse-slow" />
              </div>
            </div>
          </div>
        </div>

      </div>
    </>
  )
}
