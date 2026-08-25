import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db/supabase'

type HealthMetrics = {
  outbox_oldest_seconds?: number | null
  customer360_oldest_seconds?: number | null
  connections?: number
  max_connections?: number
}

export function classifyIntegrationHealth(metrics: HealthMetrics) {
  const outboxAge = Number(metrics.outbox_oldest_seconds ?? 0)
  const customerAge = Number(metrics.customer360_oldest_seconds ?? 0)
  const utilization = Number(metrics.connections ?? 0) / Math.max(Number(metrics.max_connections ?? 1), 1)
  if (outboxAge > 1800 || customerAge > 3600 || utilization > 0.9) return 'critical'
  if (outboxAge > 600 || customerAge > 1200 || utilization > 0.8) return 'degraded'
  return 'healthy'
}

async function rpc<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(name, params)
  if (error) throw new Error(`${name}: ${error.message}`)
  return data as T
}

export async function runIntegrationHealthCheck() {
  const canaryKey = `db-local:${new Date().toISOString()}:${randomUUID()}`
  const canary = await rpc<{ ok: boolean; outbox_id?: string; error?: string }>(
    'run_integration_synthetic_canary',
    { p_canary_key: canaryKey }
  )
  const snapshot = await rpc<Record<string, unknown>>('capture_integration_health_snapshot')
  return {
    scope: 'database_local_not_end_to_end',
    canary,
    snapshot,
  }
}
