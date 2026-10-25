import type { ColumnInfo } from './driver'

/** A value in a result grid after it crossed the process boundary. */
export type Cell = string | number | boolean | null | Uint8Array

/** What happened while a statement ran. Sent from the core to the window that started the run. */
export type QueryEvent =
  | { type: 'start'; sql: string }
  | { type: 'columns'; columns: ColumnInfo[] }
  | { type: 'rows'; rows: Cell[][] }
  /** The first page is delivered; the rest waits until the window asks for more. */
  | { type: 'paused'; rowsSent: number }
  | { type: 'ok'; affectedRows: number; insertId: string | null; message: string; warnings: number }
  /**
   * Rows past the first `RESIDENT_ROWS` of a result stay in the core, which holds them on disk. The
   * window is told how many arrived and asks for the ones it needs to show.
   */
  | { type: 'spilled'; count: number }
  | { type: 'done'; durationMs: number; rowCount: number; truncated?: boolean }
  | { type: 'error'; code: string | null; message: string }
  | { type: 'cancelled' }

export interface QueryEventMessage {
  runId: string
  /** Index into the statements of the run. */
  statement: number
  event: QueryEvent
}

export type RunOutcome = 'completed' | 'cancelled' | 'error'

/** How many rows a statement streams before it waits for the user to ask for more. */
export const DEFAULT_PAGE_SIZE = 1000

/** A result is never held past this many rows; the grid says so instead of truncating quietly. */
export const MAX_ROWS_PER_RESULT = 1_000_000

/**
 * How many rows of a result the window keeps. A bigger result is read-only, and everything past this
 * many rows is held by the core and fetched a page at a time as the grid scrolls to it.
 */
export const RESIDENT_ROWS = 100_000

/** Rows the window asks the core for at once, and the most it will ask for in one call. */
export const SPILL_PAGE_ROWS = 1000
export const MAX_FETCH_ROWS = 5000
