import { db } from '@/lib/db/supabase'

type RpcResult = Record<string, unknown> & { ok?: boolean; error?: string }

async function rpc(name: string, params: Record<string, unknown>): Promise<RpcResult> {
  const { data, error } = await db.rpc(name, params)
  if (error) throw new Error(`${name}: ${error.message}`)
  const result = (data ?? {}) as RpcResult
  if (result.ok === false) throw new Error(`${name}: ${result.error ?? 'falló el micro-batch'}`)
  return result
}

export function boundedCustomer360Env(name: string, fallback: number, max: number) {
  const value = Number(process.env[name] ?? fallback)
  return Math.min(Math.max(Number.isFinite(value) ? Math.trunc(value) : fallback, 1), max)
}

export async function runCustomer360MicroBatch() {
  const worker = process.env.CUSTOMER_360_WORKER ?? `customer-360-${process.pid}-${Date.now()}`
  const pending = await rpc('process_customer_360_pending', {
    p_worker: worker,
    p_limit: boundedCustomer360Env('CUSTOMER_360_PENDING_BATCH_SIZE', 500, 1000),
    p_lease_seconds: 180,
  })
  const events = await rpc('reconcile_customer_360_events', {
    p_limit_per_source: boundedCustomer360Env('CUSTOMER_360_EVENT_BATCH_SIZE', 1000, 5000),
  })
  const base = await rpc('reconcile_customer_360_base', {
    p_limit_per_source: boundedCustomer360Env('CUSTOMER_360_MICRO_BASE_BATCH_SIZE', 1000, 5000),
  })
  return { pending, events, base }
}

export async function processCustomer360Doorbell() {
  const worker = process.env.CUSTOMER_360_WORKER ?? `customer-360-doorbell-${process.pid}-${Date.now()}`
  return rpc('process_customer_360_pending', {
    p_worker: worker,
    p_limit: boundedCustomer360Env('CUSTOMER_360_DOORBELL_BATCH_SIZE', 50, 250),
    p_lease_seconds: 120,
  })
}

export async function runCustomer360DailyReconciliation() {
  const worker = process.env.CUSTOMER_360_WORKER ?? `customer-360-daily-${process.pid}-${Date.now()}`
  const pending = await rpc('process_customer_360_pending', {
    p_worker: worker,
    p_limit: 1000,
    p_lease_seconds: 300,
  })
  const events = await rpc('reconcile_customer_360_events', { p_limit_per_source: 5000 })
  const base = await rpc('reconcile_customer_360_base', { p_limit_per_source: 5000 })
  return { pending, events, base }
}
