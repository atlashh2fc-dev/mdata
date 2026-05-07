'use client'

import { useEffect, useState } from 'react'
import type { PersonaDetail360, PersonaView } from '@/types'
import {
  User, Mail, Phone, MapPin, Car, Building2,
  Home, Landmark, BarChart3, Shield,
  ChevronDown, ChevronUp, CalendarDays,
} from 'lucide-react'
import { formatNumber, formatCurrency, formatDate } from '@/lib/utils/formatters'
import { formatRut as fmtRut } from '@/lib/utils/rut'
import { CommercialIntelligencePanel } from '@/components/commercial/CommercialIntelligencePanel'

const USO_LABELS: Record<string, string> = {
  residencial: 'Residencial',
  comercial: 'Comercial',
  mixto_comercial_residencial: 'Mixto comercial/residencial',
  rural_productivo: 'Rural/productivo',
  indeterminado_o_especial: 'Especial/indeterminado',
}

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
      <div className="flex min-w-0 items-center gap-2.5">
        {Icon && <Icon className="w-3.5 h-3.5 text-slate-500" />}
        <span className="text-xs text-slate-400">{label}</span>
      </div>
      <span className={`ml-3 max-w-[65%] break-words text-right text-xs font-medium ${highlight ? 'text-brand-400' : 'text-slate-300'}`}>
        {value ?? '—'}
      </span>
    </div>
  )
}

function DetailCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-slate-700/60 bg-slate-950/30 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-bold text-white">{formatNumber(value)}</div>
    </div>
  )
}

function DetailItem({
  title,
  meta,
  children,
}: {
  title: string
  meta?: string | null
  children: React.ReactNode
}) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/35 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-sm font-semibold text-white">{title}</div>
        {meta && <div className="flex-shrink-0 text-right text-xs text-brand-400">{meta}</div>}
      </div>
      <div className="mt-2 space-y-1 text-xs text-slate-400">{children}</div>
    </div>
  )
}

function PersonaDetail360Panel({ rut }: { rut: string }) {
  const [detail, setDetail] = useState<PersonaDetail360 | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true

    async function load() {
      setLoading(true)
      setError(null)

      try {
        const response = await fetch(`/api/personas/detail?rut=${encodeURIComponent(rut)}`)
        const json = await response.json()

        if (!response.ok || !json.success) {
          throw new Error(json.error ?? 'No fue posible cargar detalle 360')
        }

        if (mounted) setDetail(json.data)
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : 'Error cargando detalle')
      } finally {
        if (mounted) setLoading(false)
      }
    }

    load()
    return () => {
      mounted = false
    }
  }, [rut])

  if (loading) {
    return (
      <div className="card p-5">
        <div className="text-sm text-slate-400">Cargando detalle máximo...</div>
      </div>
    )
  }

  if (error || !detail) {
    return (
      <div className="card p-5">
        <div className="text-sm text-slate-400">{error ?? 'Sin detalle adicional para este RUT.'}</div>
      </div>
    )
  }

  return (
    <div className="card p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
            <Shield className="h-4 w-4 text-cyan-400" />
            Detalle 360 interno
          </h3>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <DetailCount label="Direcciones" value={detail.addresses.length} />
        <DetailCount label="Vehículos" value={detail.vehicles.length} />
        <DetailCount label="Propiedades" value={detail.properties.length} />
        <DetailCount label="Contactos" value={detail.contact_points.length} />
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <div>
          <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            <MapPin className="h-3.5 w-3.5" />
            Direcciones
          </h4>
          <div className="space-y-2">
            {detail.addresses.length === 0 && <div className="text-sm text-slate-500">Sin dirección granular.</div>}
            {detail.addresses.map((address, index) => (
              <DetailItem
                key={`${address.source}-${index}`}
                title={address.direccion || (address.source === 'domicilio_resumen' ? 'Domicilio registrado' : address.comuna) || 'Dirección sin calle'}
                meta={address.source}
              >
                <div>{[address.comuna, address.region].filter(Boolean).join(', ') || 'Sin comuna/región'}</div>
                {address.seen_at && <div>Actualizado: {formatDate(address.seen_at)}</div>}
              </DetailItem>
            ))}
          </div>
        </div>

        <div>
          <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            <Car className="h-3.5 w-3.5" />
            Vehículos
          </h4>
          <div className="space-y-2">
            {detail.vehicles.length === 0 && <div className="text-sm text-slate-500">Sin vehículos detallados.</div>}
            {detail.vehicles.map(vehicle => (
              <DetailItem
                key={vehicle.id}
                title={[vehicle.marca, vehicle.modelo].filter(Boolean).join(' ') || 'Vehículo sin modelo'}
                meta={vehicle.ppu ? `${vehicle.ppu}${vehicle.ppu_dv ? `-${vehicle.ppu_dv}` : ''}` : null}
              >
                <div className="flex items-center gap-2">
                  <CalendarDays className="h-3.5 w-3.5 text-slate-600" />
                  <span>{vehicle.anio_fabricacion ?? 'Año s/d'} · {vehicle.tipo_vehiculo ?? 'Tipo s/d'} · {vehicle.color ?? 'Color s/d'}</span>
                </div>
                <div>Avalúo fiscal: {formatCurrency(vehicle.avaluo_fiscal)}</div>
                {vehicle.avaluo_comercial > 0 && <div>Avalúo comercial: {formatCurrency(vehicle.avaluo_comercial)}</div>}
              </DetailItem>
            ))}
          </div>
        </div>

        <div>
          <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            <Landmark className="h-3.5 w-3.5" />
            Propiedades
          </h4>
          <div className="space-y-2">
            {detail.properties.length === 0 && <div className="text-sm text-slate-500">Sin propiedades detalladas.</div>}
            {detail.properties.map((property, index) => (
              <DetailItem
                key={property.id || property.rol || property.direccion || `property-${index}`}
                title={property.direccion || property.rol || 'Propiedad sin dirección'}
                meta={property.rol}
              >
                <div>{[property.comuna, property.tipo_propiedad, property.destino].filter(Boolean).join(' · ') || 'Sin clasificación'}</div>
                <div>Avalúo fiscal: {formatCurrency(property.avaluo_fiscal)}</div>
                {property.fono_celular && <div>Celular propiedad: {property.fono_celular}</div>}
                {property.fono_comercial && <div>Teléfono comercial: {property.fono_comercial}</div>}
                {property.email && <div>Email propiedad: {property.email}</div>}
              </DetailItem>
            ))}
          </div>
        </div>

        <div>
          <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            <Phone className="h-3.5 w-3.5" />
            Contactos
          </h4>
          <div className="space-y-2">
            {detail.executive_contact && (
              <DetailItem
                title={detail.executive_contact.nombre_ejecutivo || 'Contacto ejecutivo'}
                meta={detail.executive_contact.cargo}
              >
                <div>{detail.executive_contact.razon_social}</div>
                {detail.executive_contact.mejor_telefono && <div>Teléfono: {detail.executive_contact.mejor_telefono}</div>}
                {detail.executive_contact.email && <div>Email: {detail.executive_contact.email}</div>}
              </DetailItem>
            )}
            {detail.contact_points.length === 0 && !detail.executive_contact && (
              <div className="text-sm text-slate-500">Sin contactos adicionales.</div>
            )}
            {detail.contact_points.map(point => (
              <DetailItem
                key={point.id}
                title={point.contact_value}
                meta={point.contact_type === 'email' ? 'Email' : 'Teléfono'}
              >
                <div>{point.source_name ?? 'Fuente interna'} · calidad {point.quality_score ?? 's/d'}</div>
                <div>{point.is_primary ? 'Principal' : 'Alternativo'} · {point.is_verified ? 'verificado' : 'no verificado'}</div>
                {point.last_seen_at && <div>Visto: {formatDate(point.last_seen_at)}</div>}
              </DetailItem>
            ))}
          </div>
        </div>
      </div>
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
          {persona.uso_propiedad_inferido && (
            <>
              <DataRow
                label="Uso propiedad"
                value={USO_LABELS[persona.uso_propiedad_inferido] ?? persona.uso_propiedad_inferido}
                icon={Landmark}
                highlight
              />
              <DataRow
                label="Destinos"
                value={persona.bbrr_destinos?.join(', ')}
                highlight={persona.bbrr_destinos?.length > 0}
              />
              <DataRow
                label="Residenciales"
                value={`${formatNumber(persona.n_propiedades_residenciales)} · ${formatCurrency(persona.avaluo_residencial)}`}
                highlight={persona.n_propiedades_residenciales > 0}
              />
              <DataRow
                label="Comerciales"
                value={`${formatNumber(persona.n_propiedades_comerciales)} · ${formatCurrency(persona.avaluo_comercial)}`}
                highlight={persona.n_propiedades_comerciales > 0}
              />
            </>
          )}
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

      <PersonaDetail360Panel rut={persona.rutid} />

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
