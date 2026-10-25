import type { DriverSession } from '@shared/driver'
import {
  MAX_ROWS_PER_RESULT,
  RESIDENT_ROWS,
  type Cell,
  type QueryEvent,
  type QueryEventMessage,
  type RunOutcome,
} from '@shared/query'

/**
 * Lets a window ask a paused statement for more rows. One per statement; the runner waits on it
 * only when there really are more rows than the window has asked for.
 */
export class RowAllowance {
  private limit: number
  private waiter: (() => void) | null = null
  /** Rows delivered so far for the statement. Kept by the runner. */
  sent = 0

  constructor(initial: number) {
    this.limit = initial
  }

  get value(): number {
    return this.limit
  }

  /** `'all'` lifts the limit up to the hard cap. */
  grant(rows: number | 'all'): void {
    const next = rows === 'all' ? MAX_ROWS_PER_RESULT : this.sent + Math.max(0, Math.floor(rows))
    this.limit = Math.min(Math.max(this.limit, next), MAX_ROWS_PER_RESULT)
    this.wake()
  }

  wake(): void {
    const waiter = this.waiter
    this.waiter = null
    waiter?.()
  }

  wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve()
      this.waiter = resolve
      signal.addEventListener('abort', () => this.wake(), { once: true })
    })
  }
}

/** Where rows go that the window does not keep. */
export interface SpillSink {
  /** Holds `rows` as the result's rows from position `first` on, counting from the first held row. */
  append(key: string, first: number, rows: Cell[][]): void
}

export interface RunnerOptions {
  session: DriverSession
  runId: string
  statements: string[]
  /** The database every script starts in. Applied before the first statement only. */
  database: string | null
  pageSize: number
  signal: AbortSignal
  emit: (message: QueryEventMessage) => void
  /** Called as each statement starts, so `query.more` can find its allowance. */
  onAllowance: (statement: number, allowance: RowAllowance) => void
  /** Holds the rows past the first `residentRows` of each result. Without it the window gets them all. */
  spill?: SpillSink
  residentRows?: number
}

function describeFailure(error: unknown): { code: string | null; message: string } {
  const code = (error as { code?: unknown } | null)?.code
  return {
    code: typeof code === 'string' ? code : null,
    message: error instanceof Error ? error.message : String(error),
  }
}

/**
 * Runs statements one after another, streaming events to the window. A statement that fails
 * stops the script; a cancel stops it at once and kills the running statement on the server.
 */
export interface RunResult {
  outcome: RunOutcome
  statementsRun: number
  /** The error code that stopped the run, if any. */
  errorCode?: string | null
}

export async function runStatements(options: RunnerOptions): Promise<RunResult> {
  const { session, runId, statements, signal } = options
  let statementsRun = 0

  for (let index = 0; index < statements.length; index++) {
    const emit = (event: QueryEvent): void => options.emit({ runId, statement: index, event })
    const sql = statements[index]!
    statementsRun = index + 1

    if (signal.aborted) {
      emit({ type: 'cancelled' })
      return { outcome: 'cancelled', statementsRun: index }
    }

    emit({ type: 'start', sql })
    const allowance = new RowAllowance(options.pageSize)
    options.onAllowance(index, allowance)

    const startedAt = performance.now()
    let sent = 0
    let truncated = false
    const residentRows = options.spill ? (options.residentRows ?? RESIDENT_ROWS) : Infinity
    // Per result set: the id the window gives it, the rows it holds itself, and the ones on disk.
    let resultSet = -1
    let inSet = 0
    let spilled = 0
    const iterable = session.execute(
      { text: sql, ...(index === 0 && options.database ? { target: options.database } : {}) },
      signal,
    )
    const iterator = iterable[Symbol.asyncIterator]()

    try {
      for (;;) {
        const next = await iterator.next()
        if (next.done) break
        const batch = next.value

        if (batch.kind === 'columns') {
          resultSet++
          inSet = 0
          spilled = 0
          emit({ type: 'columns', columns: batch.columns })
        } else if (batch.kind === 'ok') {
          emit({
            type: 'ok',
            affectedRows: batch.affectedRows,
            insertId: batch.insertId,
            message: batch.message,
            warnings: batch.warnings,
          })
        } else if (batch.kind === 'rows') {
          let waiting = batch.rows as Cell[][]
          while (waiting.length > 0) {
            if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
            if (sent >= MAX_ROWS_PER_RESULT) {
              truncated = true
              break
            }
            if (sent >= allowance.value) {
              emit({ type: 'paused', rowsSent: sent })
              await allowance.wait(signal)
              continue
            }
            const take = waiting.slice(0, allowance.value - sent)
            waiting = waiting.slice(take.length)
            sent += take.length
            allowance.sent = sent

            const toWindow = take.slice(0, Math.max(0, residentRows - inSet))
            const toDisk = take.slice(toWindow.length)
            inSet += take.length
            if (toWindow.length > 0) emit({ type: 'rows', rows: toWindow })
            if (toDisk.length > 0) {
              options.spill!.append(`${runId}:${index}.${resultSet}`, spilled, toDisk)
              spilled += toDisk.length
              emit({ type: 'spilled', count: toDisk.length })
            }
          }
          if (truncated) {
            await iterator.return?.()
            break
          }
        }
      }
      emit({
        type: 'done',
        durationMs: Math.round(performance.now() - startedAt),
        rowCount: sent,
        ...(truncated ? { truncated: true } : {}),
      })
    } catch (error) {
      await iterator.return?.().catch(() => undefined)
      if (signal.aborted) {
        emit({ type: 'cancelled' })
        return { outcome: 'cancelled', statementsRun }
      }
      const failure = describeFailure(error)
      emit({ type: 'error', ...failure })
      return { outcome: 'error', statementsRun, errorCode: failure.code }
    }
  }

  return { outcome: 'completed', statementsRun }
}
