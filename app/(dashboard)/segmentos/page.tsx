'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { LoadingState, EmptyState, Spinner } from '@/components/ui/Spinner'
import { PersonasTable } from '@/components/personas/PersonasTable'
import { Pagination } from '@/components/ui/Pagination'
import type {
  Segmento, FilterCondition, FilterOperator, FilterLogic, PersonaView,
} from '@/types'
import { FILTER_FIELDS } from '@/types'
import {
  Plus, X, Play, Trash2, Users, Save, Filter,
} from 'lucide-react'
import { formatNumber, formatRelativeTime } from '@/lib/utils/formatters'

const OPERATORS: { value: FilterOperator; label: string }[] = [
  { value: 'eq', label: 'igual a' },
  { value: 'neq', label: 'diferente a' },
  { value: 'gt', label: 'mayor que' },
  { value: 'gte', label: 'mayor o igual' },
  { value: 'lt', label: 'menor que' },
  { value: 'lte', label: 'menor o igual' },
  { value: 'between', label: 'entre' },
  { value: 'in', label: 'en lista' },
  { value: 'is_null', label: 'está vacío' },
  { value: 'is_not_null', label: 'no está vacío' },
  { value: 'contains', label: 'contiene' },
]

function ConditionRow({
  condition,
  index,
  onChange,
  onRemove,
}: {
  condition: FilterCondition
  index: number
  onChange: (c: FilterCondition) => void
  onRemove: () => void
}) {
  const field = FILTER_FIELDS.find(f => f.key === condition.field)
  const showValue = !['is_null', 'is_not_null'].includes(condition.operator)
  const showValue2 = condition.operator === 'between'

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {index > 0 && (
        <span className="badge-brand badge text-[10px]">Y</span>
      )}

      <select
        value={condition.field}
        onChange={e => onChange({ ...condition, field: e.target.value })}
        className="input-base w-48 py-1.5"
      >
        {FILTER_FIELDS.map(f => (
          <option key={f.key} value={f.key}>{f.label}</option>
        ))}
      </select>

      <select
        value={condition.operator}
        onChange={e => onChange({ ...condition, operator: e.target.value as FilterOperator })}
        className="input-base w-36 py-1.5"
      >
        {OPERATORS.map(op => (
          <option key={op.value} value={op.value}>{op.label}</option>
        ))}
      </select>

      {showValue && (
        <input
          type={field?.type === 'number' ? 'number' : 'text'}
          value={String(condition.value ?? '')}
          onChange={e => onChange({ ...condition, value: e.target.value })}
          placeholder="Valor"
          className="input-base w-32 py-1.5"
        />
      )}

      {showValue2 && (
        <>
          <span className="text-xs text-slate-500">y</span>
          <input
            type="number"
            value={String(condition.value2 ?? '')}
            onChange={e => onChange({ ...condition, value2: e.target.value })}
            placeholder="Valor 2"
            className="input-base w-32 py-1.5"
          />
        </>
      )}

      <button
        onClick={onRemove}
        className="p-1.5 text-slate-600 hover:text-red-400 transition-colors"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

export default function SegmentosPage() {
  const [segmentos, setSegmentos] = useState<Segmento[]>([])
  const [loading, setLoading] = useState(true)
  const [showBuilder, setShowBuilder] = useState(false)
  const [segmentName, setSegmentName] = useState('')
  const [segmentDesc, setSegmentDesc] = useState('')
  const [logic, setLogic] = useState<FilterLogic>('AND')
  const [conditions, setConditions] = useState<FilterCondition[]>([
    { field: 'score_patrimonial', operator: 'gte', value: '20' },
  ])
  const [saving, setSaving] = useState(false)
  const [selectedSegment, setSelectedSegment] = useState<Segmento | null>(null)
  const [segmentData, setSegmentData] = useState<PersonaView[]>([])
  const [segmentTotal, setSegmentTotal] = useState(0)
  const [segmentPage, setSegmentPage] = useState(1)
  const [executing, setExecuting] = useState(false)

  useEffect(() => { loadSegmentos() }, [])

  async function loadSegmentos() {
    setLoading(true)
    const res = await fetch('/api/segmentos')
    const json = await res.json()
    setSegmentos(json.data ?? [])
    setLoading(false)
  }

  function addCondition() {
    setConditions(prev => [...prev, {
      field: 'score_patrimonial',
      operator: 'gte',
      value: '0',
    }])
  }

  async function saveSegmento() {
    if (!segmentName.trim() || conditions.length === 0) return
    setSaving(true)

    const res = await fetch('/api/segmentos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: segmentName,
        description: segmentDesc,
        filters: { logic, conditions },
      }),
    })

    if (res.ok) {
      setShowBuilder(false)
      setSegmentName('')
      setSegmentDesc('')
      setConditions([{ field: 'score_patrimonial', operator: 'gte', value: '20' }])
      loadSegmentos()
    }
    setSaving(false)
  }

  async function executeSegmento(seg: Segmento, page = 1) {
    setSelectedSegment(seg)
    setExecuting(true)
    setSegmentPage(page)

    const res = await fetch(
      `/api/segmentos?execute=${seg.id}&exec_page=${page}&exec_page_size=50`
    )
    const json = await res.json()
    setSegmentData(json.data ?? [])
    setSegmentTotal(json.total ?? 0)
    setExecuting(false)
  }

  async function deleteSegmento(id: string) {
    await fetch(`/api/segmentos?id=${id}`, { method: 'DELETE' })
    loadSegmentos()
  }

  return (
    <>
      <Header
        title="Segmentador avanzado"
        subtitle="Crea y ejecuta segmentos sobre los 9.5M RUTs"
        actions={
          <button onClick={() => setShowBuilder(!showBuilder)} className="btn-primary">
            <Plus className="w-4 h-4" />
            Nuevo segmento
          </button>
        }
      />

      <div className="p-6 space-y-5">
        {/* Segment Builder */}
        {showBuilder && (
          <div className="card p-5 animate-slide-in">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Filter className="w-4 h-4 text-brand-400" />
                Constructor de segmento
              </h3>
              <button onClick={() => setShowBuilder(false)} className="text-slate-500 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">
                  Nombre del segmento *
                </label>
                <input
                  type="text"
                  value={segmentName}
                  onChange={e => setSegmentName(e.target.value)}
                  placeholder="Ej: Dueños de autos con empresa"
                  className="input-base"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">
                  Descripción
                </label>
                <input
                  type="text"
                  value={segmentDesc}
                  onChange={e => setSegmentDesc(e.target.value)}
                  placeholder="Descripción opcional"
                  className="input-base"
                />
              </div>
            </div>

            <div className="mb-3">
              <div className="flex items-center gap-3 mb-3">
                <span className="text-xs text-slate-400">Lógica:</span>
                <div className="flex gap-1">
                  {(['AND', 'OR'] as FilterLogic[]).map(l => (
                    <button
                      key={l}
                      onClick={() => setLogic(l)}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                        logic === l
                          ? 'bg-brand-600 text-white'
                          : 'bg-[#0f172a] text-slate-400 hover:text-white border border-[#334155]'
                      }`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                {conditions.map((cond, i) => (
                  <ConditionRow
                    key={i}
                    condition={cond}
                    index={i}
                    onChange={updated => {
                      const newConds = [...conditions]
                      newConds[i] = updated
                      setConditions(newConds)
                    }}
                    onRemove={() => setConditions(conditions.filter((_, ci) => ci !== i))}
                  />
                ))}
              </div>

              <button onClick={addCondition} className="btn-secondary text-xs py-1.5 mt-2">
                <Plus className="w-3 h-3" />
                Agregar condición
              </button>
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={() => setShowBuilder(false)} className="btn-secondary">
                Cancelar
              </button>
              <button
                onClick={saveSegmento}
                disabled={saving || !segmentName.trim()}
                className="btn-primary"
              >
                {saving ? <Spinner size="sm" /> : <Save className="w-4 h-4" />}
                Guardar segmento
              </button>
            </div>
          </div>
        )}

        {/* Segments List */}
        {loading ? (
          <LoadingState />
        ) : segmentos.length === 0 ? (
          <EmptyState
            title="Sin segmentos"
            description="Crea tu primer segmento para filtrar y analizar la base"
            action={
              <button onClick={() => setShowBuilder(true)} className="btn-primary">
                <Plus className="w-4 h-4" />
                Crear segmento
              </button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {segmentos.map(seg => (
              <div key={seg.id} className="card-hover p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-brand-500/10 flex items-center justify-center border border-brand-500/20">
                      <Users className="w-4 h-4 text-brand-400" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-white">{seg.name}</h3>
                      {seg.description && (
                        <p className="text-xs text-slate-500">{seg.description}</p>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => deleteSegmento(seg.id)}
                    className="text-slate-600 hover:text-red-400 transition-colors p-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex items-center gap-2 mb-3">
                  <span className="text-2xl font-bold text-white">
                    {seg.row_count > 0 ? formatNumber(seg.row_count) : '—'}
                  </span>
                  <span className="text-xs text-slate-500">RUTs</span>
                </div>

                <div className="text-[10px] text-slate-600 mb-4">
                  {seg.last_computed
                    ? `Calculado ${formatRelativeTime(seg.last_computed)}`
                    : 'Sin calcular'}
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => executeSegmento(seg, 1)}
                    className="btn-secondary text-xs py-1.5 flex-1 justify-center"
                  >
                    <Play className="w-3 h-3" />
                    Ejecutar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Segment Results */}
        {selectedSegment && (
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-[#334155]">
              <div>
                <h3 className="text-sm font-semibold text-slate-200">
                  {selectedSegment.name}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {formatNumber(segmentTotal)} RUTs encontrados
                </p>
              </div>
              <button
                onClick={() => setSelectedSegment(null)}
                className="text-slate-500 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {executing ? (
              <LoadingState text="Ejecutando segmento..." />
            ) : (
              <PersonasTable
                data={segmentData}
                total={segmentTotal}
                page={segmentPage}
                pageSize={50}
                onPageChange={p => executeSegmento(selectedSegment, p)}
                sortBy="score_patrimonial"
                sortOrder="desc"
                onSort={() => {}}
              />
            )}
          </div>
        )}
      </div>
    </>
  )
}
