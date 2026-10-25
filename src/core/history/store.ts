import type { DatabaseSync } from 'node:sqlite'
import {
  HISTORY_PAGE_SIZE,
  MAX_HISTORY_AGE_DAYS,
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_SQL_CHARS,
  type HistoryEntry,
  type HistoryPage,
  type HistoryQuery,
} from '@shared/scripts'
import type { Environment } from '@shared/environment'

interface HistoryRow {
  id: number
  ran_at: number
  connection_id: string | null
  connection_name: string
  environment: Environment
  db_name: string | null
  script_id: string | null
  sql: string
  sql_truncated: number
  status: HistoryEntry['status']
  duration_ms: number | null
  row_count: number | null
  affected: number | null
  error_code: string | null
  error_message: string | null
}

/** An entry as the runner knows it, before the store trims and numbers it. */
export type NewHistoryEntry = Omit<HistoryEntry, 'id' | 'sqlTruncated'>

export interface HistoryStoreOptions {
  now?: () => number
  maxEntries?: number
  maxAgeDays?: number
}

const PRUNE_EVERY = 200
const DAY_MS = 24 * 60 * 60 * 1000

const toEntry = (row: HistoryRow): HistoryEntry => ({
  id: row.id,
  ranAt: row.ran_at,
  connectionId: row.connection_id,
  connectionName: row.connection_name,
  environment: row.environment,
  database: row.db_name,
  scriptId: row.script_id,
  sql: row.sql,
  sqlTruncated: row.sql_truncated === 1,
  status: row.status,
  durationMs: row.duration_ms,
  rows: row.row_count,
  affected: row.affected,
  errorCode: row.error_code,
  errorMessage: row.error_message,
})

/** Escapes `%`, `_` and the escape character, so typed text is matched literally by LIKE. */
const likePattern = (word: string): string => `%${word.replace(/[\\%_]/g, '\\$&')}%`

/** The statements that were run, newest first. Old entries are dropped by count and by age. */
export class HistoryStore {
  private readonly now: () => number
  private readonly maxEntries: number
  private readonly maxAgeMs: number
  private sincePrune = 0

  constructor(
    private readonly db: DatabaseSync,
    options: HistoryStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.maxEntries = options.maxEntries ?? MAX_HISTORY_ENTRIES
    this.maxAgeMs = (options.maxAgeDays ?? MAX_HISTORY_AGE_DAYS) * DAY_MS
    this.prune()
  }

  record(entry: NewHistoryEntry): void {
    const truncated = entry.sql.length > MAX_HISTORY_SQL_CHARS
    this.db
      .prepare(
        `INSERT INTO query_history (ran_at, connection_id, connection_name, environment, db_name,
           script_id, sql, sql_truncated, status, duration_ms, row_count, affected, error_code, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.ranAt,
        entry.connectionId,
        entry.connectionName,
        entry.environment,
        entry.database,
        entry.scriptId,
        truncated ? entry.sql.slice(0, MAX_HISTORY_SQL_CHARS) : entry.sql,
        truncated ? 1 : 0,
        entry.status,
        entry.durationMs,
        entry.rows,
        entry.affected,
        entry.errorCode,
        entry.errorMessage,
      )
    if (++this.sincePrune >= PRUNE_EVERY) this.prune()
  }

  list(query: HistoryQuery = {}): HistoryPage {
    const limit = Math.min(500, Math.max(1, Math.floor(query.limit ?? HISTORY_PAGE_SIZE)))
    const where: string[] = []
    const params: (string | number)[] = []

    if (query.connectionId) {
      where.push('connection_id = ?')
      params.push(query.connectionId)
    }
    if (query.status) {
      where.push('status = ?')
      params.push(query.status)
    }
    if (query.before !== undefined) {
      where.push('id < ?')
      params.push(query.before)
    }
    // Every word has to appear somewhere in the statement.
    for (const word of (query.search ?? '').split(/\s+/).filter(Boolean)) {
      where.push("sql LIKE ? ESCAPE '\\'")
      params.push(likePattern(word))
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM query_history ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as unknown as HistoryRow[]
    return { entries: rows.slice(0, limit).map(toEntry), hasMore: rows.length > limit }
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM query_history WHERE id = ?').run(id)
  }

  clear(connectionId?: string): void {
    if (connectionId) {
      this.db.prepare('DELETE FROM query_history WHERE connection_id = ?').run(connectionId)
    } else {
      this.db.exec('DELETE FROM query_history')
    }
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM query_history').get() as { n: number }).n
  }

  private prune(): void {
    this.sincePrune = 0
    this.db.prepare('DELETE FROM query_history WHERE ran_at < ?').run(this.now() - this.maxAgeMs)
    this.db
      .prepare(
        `DELETE FROM query_history WHERE id <= (
           SELECT id FROM query_history ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      )
      .run(this.maxEntries)
  }
}
