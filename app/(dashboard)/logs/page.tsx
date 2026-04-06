'use client'

import { useEffect, useState } from 'react'
import { Header } from '@/components/layout/Header'
import { LoadingState, EmptyState } from '@/components/ui/Spinner'
import { Pagination } from '@/components/ui/Pagination'
import { formatDatetime, truncate } from '@/lib/utils/formatters'

interface AuditLogRow {
  id: string
  user_id: string | null
  action: string
  entity: string | null
  entity_id: string | null
  created_at: string
}

export default function LogsPage() {
  const [logs, setLogs] = useState<AuditLogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  useEffect(() => {
    loadLogs(page)
  }, [page])

  async function loadLogs(currentPage: number) {
    setLoading(true)
    const res = await fetch(`/api/logs?page=${currentPage}&page_size=50`)
    const json = await res.json()
    setLogs(json.data ?? [])
    setTotal(json.total ?? 0)
    setLoading(false)
  }

  return (
    <>
      <Header
        title="Logs de actividad"
        subtitle="Auditoría de segmentos, datasets y operaciones administrativas"
      />
      <div className="p-6">
        <div className="card overflow-hidden">
          <div className="p-4 border-b border-[#253357]">
            <h3 className="text-sm font-semibold text-slate-200">Audit log</h3>
          </div>
          {loading ? (
            <LoadingState />
          ) : logs.length === 0 ? (
            <EmptyState
              title="Sin logs disponibles"
              description="Los eventos auditables aparecerán aquí una vez que se utilicen segmentos y datasets."
            />
          ) : (
            <>
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Acción</th>
                    <th>Entidad</th>
                    <th>ID</th>
                    <th>Usuario</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map(log => (
                    <tr key={log.id}>
                      <td>
                        <span className="text-xs text-slate-400">
                          {formatDatetime(log.created_at)}
                        </span>
                      </td>
                      <td>
                        <span className="text-xs font-medium text-slate-200">
                          {log.action}
                        </span>
                      </td>
                      <td>
                        <span className="text-xs text-slate-400">
                          {log.entity ?? '—'}
                        </span>
                      </td>
                      <td>
                        <span className="text-xs font-mono text-slate-500">
                          {truncate(log.entity_id, 16)}
                        </span>
                      </td>
                      <td>
                        <span className="text-xs font-mono text-slate-500">
                          {truncate(log.user_id, 16)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-4">
                <Pagination
                  page={page}
                  totalPages={Math.ceil(total / 50)}
                  total={total}
                  pageSize={50}
                  onPageChange={setPage}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
