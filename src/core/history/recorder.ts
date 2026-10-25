import type { Environment } from '@shared/environment'
import type { QueryEventMessage } from '@shared/query'
import type { HistoryStore } from './store'

export interface RunContext {
  connectionId: string
  connectionName: string
  environment: Environment
  database: string | null
  scriptId: string
}

interface Pending {
  sql: string
  ranAt: number
  startedAt: number
  affected: number | null
  written: boolean
}

export interface RecorderOptions {
  /** Read each time, so turning history off takes effect for a run already in flight. */
  enabled: () => boolean
  /** Called after an entry is written. */
  onRecorded: () => void
  now?: () => number
  clock?: () => number
}

/**
 * Turns the events of a run into history entries. A statement is written once, at the first of
 * "first page ready", "done", "failed" or "cancelled", so a result that waits for the user to
 * ask for more rows is already in the history, and later events for it are ignored.
 */
export class RunRecorder {
  private readonly pending = new Map<number, Pending>()
  private readonly now: () => number
  private readonly clock: () => number

  constructor(
    private readonly store: HistoryStore,
    private readonly context: RunContext,
    private readonly options: RecorderOptions,
  ) {
    this.now = options.now ?? Date.now
    this.clock = options.clock ?? (() => performance.now())
  }

  observe({ statement, event }: QueryEventMessage): void {
    if (event.type === 'start') {
      this.pending.set(statement, {
        sql: event.sql,
        ranAt: this.now(),
        startedAt: this.clock(),
        affected: null,
        written: false,
      })
      return
    }
    const entry = this.pending.get(statement)
    if (!entry || entry.written) return

    switch (event.type) {
      case 'ok':
        entry.affected = event.affectedRows
        break
      case 'paused':
        this.write(entry, 'ok', { durationMs: this.elapsed(entry), rows: event.rowsSent })
        break
      case 'done':
        this.write(entry, 'ok', {
          durationMs: event.durationMs,
          rows: entry.affected === null ? event.rowCount : null,
        })
        break
      case 'error':
        this.write(entry, 'error', {
          durationMs: this.elapsed(entry),
          errorCode: event.code,
          errorMessage: event.message,
        })
        break
      case 'cancelled':
        this.write(entry, 'cancelled', { durationMs: this.elapsed(entry) })
        break
      default:
        break
    }
  }

  /** A statement that never reached the server, such as when the connection could not be opened. */
  recordFailure(sql: string, code: string | null, message: string): void {
    if (!this.options.enabled()) return
    this.store.record({
      ranAt: this.now(),
      ...this.fields(),
      sql,
      status: 'error',
      durationMs: null,
      rows: null,
      affected: null,
      errorCode: code,
      errorMessage: message,
    })
    this.options.onRecorded()
  }

  private elapsed(entry: Pending): number {
    return Math.round(this.clock() - entry.startedAt)
  }

  private fields() {
    return {
      connectionId: this.context.connectionId,
      connectionName: this.context.connectionName,
      environment: this.context.environment,
      database: this.context.database,
      scriptId: this.context.scriptId,
    }
  }

  private write(
    entry: Pending,
    status: 'ok' | 'error' | 'cancelled',
    extra: {
      durationMs: number
      rows?: number | null
      errorCode?: string | null
      errorMessage?: string | null
    },
  ): void {
    entry.written = true
    if (!this.options.enabled()) return
    this.store.record({
      ranAt: entry.ranAt,
      ...this.fields(),
      sql: entry.sql,
      status,
      durationMs: extra.durationMs,
      rows: extra.rows ?? null,
      affected: entry.affected,
      errorCode: extra.errorCode ?? null,
      errorMessage: extra.errorMessage ?? null,
    })
    this.options.onRecorded()
  }
}
