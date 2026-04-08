'use client'

import { useState } from 'react'
import type { PersonaView } from '@/types'
import {
  User, Mail, Phone, MapPin, Car, Building2,
  Home, Landmark, Zap, BarChart3, Shield,
  ChevronDown, ChevronUp,
} from 'lucide-react'
import { formatNumber, formatCurrency, formatRut } from '@/lib/utils/formatters'
import { formatRut as fmtRut } from '@/lib/utils/rut'
import { CommercialIntelligencePanel } from '@/components/commercial/CommercialIntelligencePanel'

// Re-export since formatters.ts has formatRut too
function safeDisplayRut(rut: string | null | undefined): string {
  if (!rut) return '—'
  return fmtRut(rut)
}

interface ScoreMeterProps {
  score: number
  max?: number
  label: string
}

function ScoreMeter({ score, max = 100, label }: ScoreMeterProps) {
  const pct = Math.min((score / max) * 100, 100)
  const color =
    pct >= 70 ? 'bg-green-500' :
    pct >= 40 ? 'bg-amber-500' :
    pct >= 20 ? 'bg-orange-500' : 'bg-red-500'

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-slate-400">{label}</span>
        <span className="text-xs font-bold text-white">{score}</span>
      </div>
      <div className="h-2 bg-[#334155] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

interface DataRowProps {
  label: string
  value: string | number | null | undefined
  icon?: React.ElementType
  highlight?: boolean
}

function DataRow({ label, value, icon: Icon, highlight }: DataRowProps) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-[#334155]/50 last:border-0">
      <div className="flex items-center gap-2.5">
        {Icon && <Icon className="w-3.5 h-3.5 text-slate-500" />}
        <span className="text-xs text-slate-400">{label}</span>
      </div>
      <span className={`text-xs font-medium ${highlight ? 'text-brand-400' : 'text-slate-300'}`}>
        {value ?? '—'}
      </span>
    </div>
  )
}

interface PersonaProfileProps {
  persona: PersonaView
}

export function PersonaProfile({ persona }: PersonaProfileProps) {
  const [showRawData, setShowRawData] = useState(false)

  const coberturaPct = persona.cobertura_pct ?? 0
  const scorePatrimonial = persona.score_patrimonial ?? 0

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header Card */}
      <div className="card p-6">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-brand-500/20 flex items-center justify-center border border-brand-500/30 flex-shrink-0">
            <User className="w-7 h-7 text-brand-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-bold text-white truncate">
              {persona.nombre_completo?.trim() || 'Sin nombre registrado'}
            </h2>
            <p className="text-sm font-mono text-brand-400 mt-0.5">
              {safeDisplayRut(persona.rutid)}
            </p>
            <div className="flex items-center gap-3 mt-2">
              {persona.region_part && (
                <span className="badge-neutral badge">
                  <MapPin className="w-2.5 h-2.5" />
                  {persona.region_part}
                </span>
              )}
              {persona.tiene_empresa && (
                <span className="badge-brand badge">
                  <Building2 className="w-2.5 h-2.5" />
                  Empresa
                </span>
              )}
              {persona.tiene_bienes_raices && (
                <span className="badge-warning badge">
                  <Landmark className="w-2.5 h-2.5" />
                  B. Raíces
                </span>
              )}
              {persona.tiene_autos && (
                <span className="badge-info badge">
                  <Car className="w-2.5 h-2.5" />
                  Autos
                </span>
              )}
            </div>
          </div>

          {/* Score */}
          <div className="text-right flex-shrink-0">
            <div className="text-3xl font-bold text-white">{scorePatrimonial}</div>
            <div className="text-xs text-slate-500 mt-0.5">Score patrimonial</div>
            <div className="text-xs text-slate-600 mt-1">Cobertura: {coberturaPct}%</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Datos Personales */}
        <div className="card p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3 flex items-center gap-2">
            <User className="w-3.5 h-3.5" />
            Datos personales
          </h3>
          <DataRow label="Nombres" value={persona.nombres} />
          <DataRow label="Apellido paterno" value={persona.paterno} />
          <DataRow label="Apellido materno" value={persona.materno} />
          <DataRow label="Email" value={persona.email} icon={Mail} highlight />
          <DataRow label="Teléfono" value={persona.fono_cel} icon={Phone} highlight />
          <DataRow label="Comuna" value={persona.comuna_part} icon={MapPin} />
          <DataRow label="Región" value={persona.region_part} />
        </div>

        {/* Patrimonio */}
        <div className="card p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3 flex items-center gap-2">
            <Landmark className="w-3.5 h-3.5" />
            Patrimonio
          </h3>
          <DataRow
            label="Autos"
            value={formatNumber(persona.n_autos)}
            icon={Car}
            highlight={persona.n_autos > 0}
          />
          <DataRow
            label="Bienes raíces"
            value={formatNumber(persona.n_bienes_raices)}
            icon={Home}
            highlight={persona.n_bienes_raices > 0}
          />
          <DataRow
            label="Total avalúos"
            value={formatCurrency(persona.totalavaluos)}
            highlight={persona.totalavaluos > 0}
          />
          {persona.razon_social_empresa && (
            <DataRow
              label="Empresa"
              value={persona.razon_social_empresa}
              icon={Building2}
              highlight
            />
          )}

          <div className="mt-4 pt-4 border-t border-[#334155]/50 space-y-3">
            <ScoreMeter
              score={persona.score_patrimonial ?? 0}
              max={100}
              label="Score patrimonial"
            />
            <ScoreMeter
              score={persona.cobertura_pct ?? 0}
              max={100}
              label="Cobertura datos"
            />
          </div>
        </div>

        {/* Domicilio */}
        <div className="card p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3 flex items-center gap-2">
            <MapPin className="w-3.5 h-3.5" />
            Domicilio registrado
          </h3>
          <DataRow label="Comuna" value={persona.domicilio_comuna} icon={MapPin} />
          <DataRow label="Región" value={persona.domicilio_region} />

          {/* Datos de contactabilidad */}
          <div className="mt-4 pt-4 border-t border-[#334155]/50">
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-slate-600 mb-3">
              Contactabilidad
            </h4>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: 'Email', ok: !!persona.email },
                { label: 'Teléfono', ok: !!persona.fono_cel },
                { label: 'Domicilio', ok: !!persona.domicilio_region },
                { label: 'Empresa', ok: persona.tiene_empresa },
              ].map(c => (
                <div
                  key={c.label}
                  className={`flex items-center gap-1.5 text-xs rounded-md px-2 py-1.5
                    ${c.ok
                      ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                      : 'bg-slate-500/10 text-slate-600 border border-slate-500/10'
                    }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${c.ok ? 'bg-green-500' : 'bg-slate-600'}`} />
                  {c.label}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <CommercialIntelligencePanel rut={persona.rutid} />

      {/* Raw Data Toggle */}
      <div className="card overflow-hidden">
        <button
          onClick={() => setShowRawData(!showRawData)}
          className="w-full flex items-center justify-between p-4 hover:bg-white/[0.02] transition-colors"
        >
          <span className="text-xs font-semibold text-slate-400 flex items-center gap-2">
            <BarChart3 className="w-3.5 h-3.5" />
            Datos crudos JSON
          </span>
          {showRawData ? (
            <ChevronUp className="w-4 h-4 text-slate-500" />
          ) : (
            <ChevronDown className="w-4 h-4 text-slate-500" />
          )}
        </button>
        {showRawData && (
          <pre className="p-4 pt-0 text-[10px] font-mono text-slate-400 overflow-x-auto">
            {JSON.stringify(persona, null, 2)}
          </pre>
        )}
      </div>
    </div>
  )
}
