import { Client, type ClientConfig } from 'pg'
import Cursor from 'pg-cursor'
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
import { dialectInfo } from '@shared/dialect'
import {
  buildEditStatements,
  type EditBatch,
  type EditResult,
  type TableDescription,
} from '@shared/edit'
import { appReadOnlyViolation } from '../mysql/read-only'
import { PgError, SessionClosedError } from './errors'
import { describeTable, schemaDetail, schemaNames, tableColumns, treeChildren } from './meta'
import { toCell, toColumnInfo, type PgField } from './types'

/** Rows per `rows` batch sent to the consumer. */
const BATCH_ROWS = 500

const abortError = (): Error => new DOMException('The query was cancelled', 'AbortError')

/** `?` placeholders as `$1`, `$2`… */
const numbered = (sql: string): string => {
  let n = 0
  return sql.replace(/\?/g, () => `$${++n}`)
}

export class PgSession implements DriverSession {
  private state: SessionInfo
  private closed = false
  private helper: Client | null = null
  /** What a table's number and a column's position name, so a result can say where its columns come from. */
  private readonly tableNames = new Map<number, { schema: string; table: string } | null>()
  private readonly columnNames = new Map<string, string>()

  constructor(
    private readonly client: Client,
    private readonly config: ClientConfig,
    info: SessionInfo,
  ) {
    this.state = info
    // An idle connection that dies emits 'error'. Without a listener that would crash the core.
    client.on('error', () => {
      this.closed = true
    })
  }

  get info(): SessionInfo {
    return this.state
  }

  /** Runs a catalog query and returns rows as arrays. */
  query = async (sql: string, values?: unknown[]): Promise<unknown[][]> => {
    if (this.closed) throw new SessionClosedError()
    try {
      const result = await this.client.query({ text: sql, values, rowMode: 'array' })
      return result.rows as unknown[][]
    } catch (error) {
      throw new PgError(error)
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
    const statements = buildEditStatements(batch, {}, 'postgresql')
    await this.query('BEGIN')
    let index = 0
    try {
      const results: { affectedRows: number; insertId: string | null }[] = []
      for (; index < statements.length; index++) {
        signal.throwIfAborted()
        const statement = statements[index]!
        const values = statement.params.map((v) => (v instanceof Uint8Array ? Buffer.from(v) : v))
        const result = await this.client.query({ text: numbered(statement.sql), values })
        const affected = result.rowCount ?? 0
        if (statement.kind !== 'insert' && affected !== 1) {
          await this.query('ROLLBACK')
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
      await this.query('COMMIT')
      return { ok: true, results }
    } catch (error) {
      await this.query('ROLLBACK').catch(() => undefined)
      if (signal.aborted) throw error
      const described = new PgError(error)
      return {
        ok: false,
        failedIndex: index,
        code: described.code,
        message: `${described.message} Nothing was saved.`,
      }
    }
  }

  async setReadOnly(readOnly: boolean): Promise<void> {
    await this.query(
      `SET SESSION CHARACTERISTICS AS TRANSACTION ${readOnly ? 'READ ONLY' : 'READ WRITE'}`,
    )
    this.state = { ...this.state, readOnly, readOnlyEnforcedByServer: true }
  }

  async *execute(request: ExecuteRequest, signal: AbortSignal): AsyncGenerator<ResultBatch> {
    if (this.closed) throw new SessionClosedError()
    signal.throwIfAborted()
    if (this.state.readOnly && this.state.readOnlyEnforcedByServer === false) {
      const why = appReadOnlyViolation(request.text)
      if (why)
        throw Object.assign(new Error(`This connection is read-only. ${why}`), {
          code: 'READ_ONLY',
        })
    }
    if (request.target && request.target !== this.state.currentDatabase) {
      await this.query(
        `SET search_path TO ${dialectInfo('postgresql').quote(request.target)}, public`,
      )
      this.state = { ...this.state, currentDatabase: request.target }
    }
    yield* this.stream(request.text, signal)
  }

  /**
   * Streams one statement through a cursor, a batch of rows at a time: the next batch is read only when the
   * consumer asks for it, so a result of any size never piles up in memory.
   */
  private async *stream(sql: string, signal: AbortSignal): AsyncGenerator<ResultBatch> {
    const cursor = this.client.query(new Cursor(sql, [], { rowMode: 'array' }))
    const read = (): Promise<{
      rows: unknown[][]
      result: { fields?: PgField[]; rowCount?: number | null; command?: string }
    }> =>
      new Promise((resolve, reject) => {
        cursor.read(BATCH_ROWS, (error, rows, result) =>
          error ? reject(error) : resolve({ rows, result: result as never }),
        )
      })
    let finished = false
    const cancel = (): void => void this.cancelBackend()
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    try {
      let announced = false
      for (;;) {
        if (signal.aborted) throw abortError()
        const { rows, result } = await read()
        if (signal.aborted) throw abortError()
        const fields = result.fields ?? []
        if (!announced && fields.length > 0) {
          announced = true
          yield { kind: 'columns', columns: await this.columnsOf(fields) }
        }
        if (rows.length > 0) yield { kind: 'rows', rows: rows.map((row) => row.map(toCell)) }
        if (rows.length < BATCH_ROWS) {
          if (fields.length === 0) {
            yield {
              kind: 'ok',
              affectedRows: result.rowCount ?? 0,
              insertId: null,
              message: result.command ?? '',
              warnings: 0,
            }
          }
          finished = true
          return
        }
      }
    } catch (error) {
      finished = true
      if (signal.aborted) throw abortError()
      throw error instanceof PgError ? error : new PgError(error)
    } finally {
      signal.removeEventListener('abort', cancel)
      if (!finished) await this.cancelBackend()
      await new Promise<void>((resolve) => cursor.close(() => resolve()))
    }
  }

  private async columnsOf(fields: PgField[]): Promise<ColumnInfo[]> {
    await this.learnSources(fields)
    return fields.map((field) => {
      const table = field.tableID ? this.tableNames.get(field.tableID) : null
      const name = this.columnNames.get(`${field.tableID}:${field.columnID}`)
      return toColumnInfo(
        field,
        table && name ? { schema: table.schema, table: table.table, column: name } : undefined,
      )
    })
  }

  /** Asks (on a second connection, because this one is busy) which tables the result's columns belong to. */
  private async learnSources(fields: PgField[]): Promise<void> {
    const wanted = [
      ...new Set(fields.map((f) => f.tableID).filter((id) => id > 0 && !this.tableNames.has(id))),
    ]
    if (wanted.length === 0) return
    try {
      const helper = await this.aux()
      const tables = await helper.query({
        text: `SELECT c.oid::int, n.nspname, c.relname, c.relkind FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = ANY ($1::oid[])`,
        values: [wanted],
        rowMode: 'array',
      })
      for (const id of wanted) this.tableNames.set(id, null)
      const plain: number[] = []
      for (const [oid, schema, table, kind] of tables.rows as unknown[][]) {
        // Only a table's rows can be written back; a view or other relation has no single row to address.
        if (kind === 'r' || kind === 'p') {
          this.tableNames.set(Number(oid), { schema: String(schema), table: String(table) })
          plain.push(Number(oid))
        }
      }
      if (plain.length > 0) {
        const columns = await helper.query({
          text: 'SELECT attrelid::int, attnum::int, attname FROM pg_attribute WHERE attrelid = ANY ($1::oid[]) AND attnum > 0',
          values: [plain],
          rowMode: 'array',
        })
        for (const [oid, num, name] of columns.rows as unknown[][]) {
          this.columnNames.set(`${oid}:${num}`, String(name))
        }
      }
    } catch {
      // Without it the result is read-only, which is safe.
    }
  }

  private async aux(): Promise<Client> {
    if (this.helper) return this.helper
    const helper = new Client({ ...this.config, connectionTimeoutMillis: 5000 })
    helper.on('error', () => {
      this.helper = null
    })
    await helper.connect()
    this.helper = helper
    return helper
  }

  /** Stops the running statement. It has to be asked from a second connection, because this one is busy. */
  private async cancelBackend(): Promise<void> {
    const pid = (this.client as unknown as { processID?: number }).processID
    if (!pid || this.closed) return
    try {
      const helper = await this.aux()
      await helper.query('SELECT pg_cancel_backend($1)', [pid])
    } catch {
      // The statement ends by itself, in time.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.race([
      this.client.end().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ])
    await this.helper?.end().catch(() => undefined)
  }
}
