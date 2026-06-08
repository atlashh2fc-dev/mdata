declare module 'pg' {
  export interface PoolClient {
    query<T = any>(
      text: string,
      values?: unknown[]
    ): Promise<{ rows: T[] }>
    query(queryStream: unknown): any
    release(): void
  }

  export class Pool {
    constructor(config?: Record<string, unknown>)
    connect(): Promise<PoolClient>
    query<T = any>(
      text: string,
      values?: unknown[]
    ): Promise<{ rows: T[] }>
    end(): Promise<void>
  }

  export class Client {
    constructor(config?: Record<string, unknown>)
    connect(): Promise<void>
    query<T = any>(
      text: string,
      values?: unknown[]
    ): Promise<{ rows: T[] }>
    end(): Promise<void>
  }
}

declare module 'pg-copy-streams' {
  export function to(sql: string): unknown
}
