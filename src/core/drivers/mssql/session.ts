import type sql from 'mssql'
import type {
  ColumnInfo,
  DriverSession,
  ExecuteRequest,
  ResultBatch,
  SchemaDetail,
  SessionInfo,
  TableColumns,
  TreeNode,
} from '@shared/driver'
import {
  buildEditStatements,
  type EditBatch,
  type EditResult,
  type TableDescription,
} from '@shared/edit'
import { BatchQueue } from '../../util/batch-queue'
import { appReadOnlyViolation } from '../mysql/read-only'
import { MssqlError, SessionClosedError } from './errors'
import { describeTable, schemaDetail, schemaNames, tableColumns, treeChildren } from './meta'
import { declarationOf, toCell, toColumnInfo, type MssqlColumn } from './types'

const BATCH_ROWS = 500
const HIGH_WATER = 4
const LOW_WATER = 1

const abortError = (): Error => new DOMException('The query was cancelled', 'AbortError')

/** `?` placeholders as `@p1`, `@p2`… */
const named = (query: string): string => {
  let n = 0
  return query.replace(/\?/g, () => `@p${++n}`)
}

export class MssqlSession implements DriverSession {
  private state: SessionInfo
  private closed = false

  constructor(
    private readonly pool: sql.ConnectionPool,
    info: SessionInfo,
  ) {
    this.state = info
    // An idle connection that dies emits 'error'. Without a listener that would crash the core.
    pool.on('error', () => {
      this.closed = true
    })
  }

  get info(): SessionInfo {
    return this.state
  }

  /** Runs a catalog query with `@p1`-style values and returns rows as arrays. */
  query = async (text: string, values: unknown[] = []): Promise<unknown[][]> => {
    if (this.closed) throw new SessionClosedError()
    try {
      const request = this.pool.request()
      request.arrayRowMode = true
      values.forEach((value, i) => request.input(`p${i + 1}`, value))
      const result = await request.query(text)
      return (result.recordset ?? []) as unknown as unknown[][]
    } catch (error) {
      throw new MssqlError(error)
    }
  }

  async ping(): Promise<void> {
    await this.query('SELECT 1')
  }

  children(parent: TreeNode | null, signal: AbortSignal): Promise<TreeNode[]> {
    signal.throwIfAborted()
    return treeChildren(this.query, parent)
  }

  async databaseNames(signal: AbortSignal): Promise<string[]> {
    signal.throwIfAborted()
    return schemaNames(this.query)
  }

  schemaDetail(database: string, signal: AbortSignal): Promise<SchemaDetail> {
    signal.throwIfAborted()
    return schemaDetail(this.query, database)
  }

  tableColumns(database: string, names: string[], signal: AbortSignal): Promise<TableColumns> {
    signal.throwIfAborted()
    return tableColumns(this.query, database, names)
  }

  describeTable(schema: string, table: string, signal: AbortSignal): Promise<TableDescription> {
    signal.throwIfAborted()
    return describeTable(this.query, schema, table)
  }

  async applyEdits(batch: EditBatch, signal: AbortSignal): Promise<EditResult> {
    signal.throwIfAborted()
    if (this.state.readOnly) {
      return {
        ok: false,
        failedIndex: 0,
        code: 'READ_ONLY',
        message: 'This connection is read-only. Unlock writes to edit rows.',
      }
    }
    const statements = buildEditStatements(batch, {}, 'mssql')
    await this.query('BEGIN TRANSACTION')
    let index = 0
    try {
      const results: { affectedRows: number; insertId: string | null }[] = []
      for (; index < statements.length; index++) {
        signal.throwIfAborted()
        const statement = statements[index]!
        const request = this.pool.request()
        statement.params.forEach((v, i) =>
          request.input(`p${i + 1}`, v instanceof Uint8Array ? Buffer.from(v) : v),
        )
        const result = await request.query(named(statement.sql))
        const affected = result.rowsAffected.reduce((a, b) => a + b, 0)
        if (statement.kind !== 'insert' && affected !== 1) {
          await this.query('ROLLBACK TRANSACTION')
          return {
            ok: false,
            failedIndex: index,
            code: 'ROW_COUNT',
            message:
              affected === 0
                ? 'That row no longer exists, or its key changed since it was loaded. Nothing was saved.'
                : `The key matched ${affected} rows, so the change was not applied. Nothing was saved.`,
          }
        }
        results.push({ affectedRows: affected, insertId: null })
      }
      await this.query('COMMIT TRANSACTION')
      return { ok: true, results }
    } catch (error) {
      await this.query('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION').catch(() => undefined)
      if (signal.aborted) throw error
      const described = new MssqlError(error)
      return {
        ok: false,
        failedIndex: index,
        code: described.code,
        message: `${described.message} Nothing was saved.`,
      }
    }
  }

  async setReadOnly(readOnly: boolean): Promise<void> {
    // SQL Server has no read-only mode for a session, so the app refuses writes itself.
    this.state = { ...this.state, readOnly, readOnlyEnforcedByServer: false }
  }

  async *execute(request: ExecuteRequest, signal: AbortSignal): AsyncGenerator<ResultBatch> {
    if (this.closed) throw new SessionClosedError()
    signal.throwIfAborted()
    if (this.state.readOnly) {
      const why = appReadOnlyViolation(request.text)
      if (why) {
        throw Object.assign(
          new Error(
            `This connection is read-only, and SQL Server can’t enforce that itself, so DBIDE didn’t send the statement. ${why} Unlock writes to run it.`,
          ),
          { code: 'READ_ONLY' },
        )
      }
    }
    yield* this.stream(request.text, signal)
  }

  /** Streams one batch of SQL. The socket is paused when the consumer falls behind, so memory stays flat. */
  private async *stream(text: string, signal: AbortSignal): AsyncGenerator<ResultBatch> {
    const request = this.pool.request()
    request.stream = true
    request.arrayRowMode = true
    const queue = new BatchQueue<ResultBatch>(
      (pressured) => (pressured ? request.pause() : request.resume()),
      HIGH_WATER,
      LOW_WATER,
    )
    let pending: unknown[][] = []
    let declarations: string[] = []
    let sawRows = false
    let affected = 0
    const flush = (): void => {
      if (pending.length > 0) {
        queue.push({ kind: 'rows', rows: pending as never })
        pending = []
      }
    }

    request.on('recordset', (columns: Record<string, MssqlColumn>) => {
      flush()
      const ordered = Object.values(columns).sort((a, b) => a.index - b.index)
      declarations = ordered.map(declarationOf)
      sawRows = true
      const infos: ColumnInfo[] = ordered.map(toColumnInfo)
      queue.push({ kind: 'columns', columns: infos })
    })
    request.on('row', (row: unknown[]) => {
      pending.push(row.map((v, i) => toCell(v, declarations[i] ?? '')))
      if (pending.length >= BATCH_ROWS) flush()
    })
    request.on('rowsaffected', (count: number) => {
      affected += count
    })
    request.on('error', (error: unknown) => queue.fail(new MssqlError(error)))
    request.on('done', () => {
      flush()
      if (!sawRows) {
        queue.push({ kind: 'ok', affectedRows: affected, insertId: null, message: '', warnings: 0 })
      }
      queue.end()
    })

    let finished = false
    const cancel = (): void => {
      try {
        request.cancel()
      } catch {
        // Already finished.
      }
      request.resume()
    }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    request.query(text)

    try {
      for (;;) {
        const next = await queue.next()
        if (next.done) {
          finished = true
          if (signal.aborted) throw abortError()
          return
        }
        if (signal.aborted) throw abortError()
        yield next.value
      }
    } catch (error) {
      finished = true
      if (signal.aborted) throw abortError()
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
      if (!finished) cancel()
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.race([
      this.pool.close().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ])
  }
}
