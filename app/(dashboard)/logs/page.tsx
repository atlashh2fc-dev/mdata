'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { LoadingState } from '@/components/ui/Spinner'
import { formatDatetime } from '@/lib/utils/formatters'

export default function LogsPage() {
  const [logs, setLogs] = useState<{
    id: string; user_id: string | null; action: string; entity: string | null
    entity_id: string | null; created_at: string
  }[]>([])
  const [loading, setLoading] = useState(true)

  // In production this would fetch from /api/audit_logs
  useEffect(() => { setLoading(false) }, [])

  return (
    <>
      <Header
        title="Logs de actividad"
        subtitle="Auditoría completa de acciones del sistema"
      />
      <div className="p-6">
        <div className="card overflow-hidden">
          <div className="p-4 border-b border-[#253357]">
            <h3 className="text-sm font-semibold text-slate-200">Audit log</h3>
          </div>
          {loading ? (
            <LoadingState />
          ) : (
            <div className="p-6 text-center">
              <p className="text-sm text-slate-500">
                El audit log registra automáticamente todas las acciones.<br />
                Los logs se generarán a medida que el sistema sea utilizado.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
