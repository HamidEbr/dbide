import { createConnection, escapeId, type Connection, type ConnectionOptions } from 'mysql2'
import type {
  DriverSession,
  ExecuteRequest,
  ResultBatch,
  SessionInfo,
  TreeNode,
} from '@shared/driver'
import {
  buildEditStatements,
  type EditBatch,
  type EditResult,
  type TableDescription,
} from '@shared/edit'
import { BatchQueue } from '../../util/batch-queue'
import { MysqlError, SessionClosedError } from './errors'
import { groupForeignKeys, groupReferencingKeys } from './foreign-keys'
import { appReadOnlyViolation, setServerReadOnly } from './read-only'
import { treeChildren } from './tree'
import { toCell, toColumnInfo, type MysqlField } from './types'

/** Rows per `rows` batch sent to the consumer. */
const BATCH_ROWS = 500
/** Batches that may wait before the socket is paused. Bounds memory for any result size. */
const HIGH_WATER = 4
const LOW_WATER = 1
/** How long to wait for the server to finish a cancelled statement before dropping the connection. */
const DRAIN_TIMEOUT_MS = 5000

interface OkPacket {
  affectedRows?: number
  insertId?: number | string
  info?: string
  warningStatus?: number
}

function abortError(): Error {
  return new DOMException('The query was cancelled', 'AbortError')
}

function okBatch(packet: OkPacket): ResultBatch {
  const insertId = packet.insertId
  return {
    kind: 'ok',
    affectedRows: Number(packet.affectedRows ?? 0),
    insertId:
      insertId === undefined || insertId === 0 || insertId === '0' ? null : String(insertId),
    message: packet.info ?? '',
    warnings: Number(packet.warningStatus ?? 0),
  }
}

export class MysqlSession implements DriverSession {
  private state: SessionInfo
  private closed = false

  constructor(
    private readonly conn: Connection,
    private readonly options: ConnectionOptions,
    info: SessionInfo,
  ) {
    this.state = info
    // An idle connection that dies emits 'error'. Without a listener that would crash the core.
    conn.on('error', () => {
      this.closed = true
    })
  }

  get info(): SessionInfo {
    return this.state
  }

  /** Runs a metadata query and returns rows as arrays. */
  query(sql: string, values?: unknown[]): Promise<unknown[][]> {
    if (this.closed) return Promise.reject(new SessionClosedError())
    return new Promise((resolve, reject) => {
      this.conn.query({ sql, values, rowsAsArray: true }, (error, rows) => {
        if (error) reject(new MysqlError(error))
        else resolve(rows as unknown as unknown[][])
      })
    })
  }

  ping(): Promise<void> {
    if (this.closed) return Promise.reject(new SessionClosedError())
    return new Promise((resolve, reject) => {
      this.conn.ping((error) => (error ? reject(new MysqlError(error)) : resolve()))
    })
  }

  children(parent: TreeNode | null, signal: AbortSignal): Promise<TreeNode[]> {
    signal.throwIfAborted()
    return treeChildren((sql, values) => this.query(sql, values), parent)
  }

  async completionSchema(
    database: string | null,
    signal: AbortSignal,
  ): Promise<Record<string, string[]>> {
    signal.throwIfAborted()
    const target = database ?? this.state.currentDatabase
    if (!target) return {}
    const rows = await this.query(
      `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [target],
    )
    const schema: Record<string, string[]> = {}
    for (const [table, column] of rows) (schema[String(table)] ??= []).push(String(column))
    return schema
  }

  async describeTable(
    schema: string,
    table: string,
    signal: AbortSignal,
  ): Promise<TableDescription> {
    signal.throwIfAborted()
    const columns = await this.query(
      `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, EXTRA
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [schema, table],
    )
    if (columns.length === 0) throw new Error(`Table ${schema}.${table} was not found.`)
    const key = await this.query(
      `SELECT COLUMN_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
        ORDER BY SEQ_IN_INDEX`,
      [schema, table],
    )
    // Where the table's columns point, and which tables point at it, for jumping along a key.
    const pointsTo = await this.query(
      `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
      [schema, table],
    )
    // Which tables point here means looking at every table of every schema, which an older server does
    // slowly. It gets a few seconds (MySQL 5.7.8 and newer honour the hint; others ignore it), and if it
    // doesn't answer in time the rest of the description is still worth having.
    const pointedAtBy = await this.query(
      `SELECT /*+ MAX_EXECUTION_TIME(5000) */ CONSTRAINT_NAME, TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?
        ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
      [schema, table],
    ).catch((error: unknown) => {
      if ((error as { code?: unknown } | null)?.code === 'CONNECTION_CLOSED') throw error
      return null
    })
    return {
      schema,
      table,
      foreignKeys: groupForeignKeys(pointsTo),
      ...(pointedAtBy ? { referencedBy: groupReferencingKeys(pointedAtBy) } : {}),
      columns: columns.map((row) => {
        const extra = String(row[4] ?? '').toLowerCase()
        return {
          name: String(row[0]),
          type: String(row[1]).toLowerCase(),
          columnType: String(row[2]),
          nullable: String(row[3]) === 'YES',
          autoIncrement: extra.includes('auto_increment'),
          generated: extra.includes('generated'),
        }
      }),
      primaryKey: key.map((row) => String(row[0])),
    }
  }

  /** Runs a statement with bound values and returns the server's OK packet. */
  private exec(sql: string, values: unknown[]): Promise<OkPacket> {
    if (this.closed) return Promise.reject(new SessionClosedError())
    return new Promise((resolve, reject) => {
      this.conn.query({ sql, values }, (error, result) => {
        if (error) reject(new MysqlError(error))
        else resolve(result as unknown as OkPacket)
      })
    })
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
    // Column types only matter for the preview text; the parameters carry the real values.
    const statements = buildEditStatements(batch, {})

    await this.query('START TRANSACTION')
    let index = 0
    try {
      const results: { affectedRows: number; insertId: string | null }[] = []
      for (; index < statements.length; index++) {
        signal.throwIfAborted()
        const statement = statements[index]!
        const values = statement.params.map((v) => (v instanceof Uint8Array ? Buffer.from(v) : v))
        const packet = await this.exec(statement.sql, values)
        const affected = Number(packet.affectedRows ?? 0)

        // Rows are addressed by key, so each update or delete must hit exactly one row. Anything
        // else means the row is gone or the data changed underneath the edit.
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
        const insertId = packet.insertId
        results.push({
          affectedRows: affected,
          insertId:
            statement.kind === 'insert' && insertId !== undefined && String(insertId) !== '0'
              ? String(insertId)
              : null,
        })
      }
      await this.query('COMMIT')
      return { ok: true, results }
    } catch (error) {
      await this.query('ROLLBACK').catch(() => undefined)
      if (signal.aborted) throw error
      const described = error as { code?: string | null; message?: string }
      return {
        ok: false,
        failedIndex: index,
        code: described.code ?? null,
        message: `${described.message ?? String(error)} Nothing was saved.`,
      }
    }
  }

  async setReadOnly(readOnly: boolean): Promise<void> {
    // A server that never had a read-only mode has nothing to switch back to read-write either.
    const enforced =
      readOnly || this.state.readOnlyEnforcedByServer !== false
        ? await setServerReadOnly((sql) => this.query(sql), readOnly)
        : false
    this.state = {
      ...this.state,
      readOnly,
      readOnlyEnforcedByServer: readOnly ? enforced : this.state.readOnlyEnforcedByServer !== false,
    }
  }

  async *execute(request: ExecuteRequest, signal: AbortSignal): AsyncGenerator<ResultBatch> {
    this.assertOpen()
    signal.throwIfAborted()
    if (this.state.readOnly && this.state.readOnlyEnforcedByServer === false) {
      const why = appReadOnlyViolation(request.text)
      if (why) {
        throw Object.assign(
          new Error(
            `This connection is read-only, and this server can’t enforce that itself, so DBIDE didn’t send the statement. ${why} Unlock writes to run it.`,
          ),
          { code: 'READ_ONLY' },
        )
      }
    }
    if (request.target && request.target !== this.state.currentDatabase) {
      await this.query(`USE ${escapeId(request.target)}`)
      this.state = { ...this.state, currentDatabase: request.target }
    }
    yield* this.stream(request.text, signal)
  }

  /**
   * Streams one statement. The socket is paused whenever the consumer falls behind, so the
   * result never piles up in memory. If the consumer stops early or the signal aborts, the
   * statement is killed on the server and the connection is drained so it stays usable.
   */
  private async *stream(sql: string, signal: AbortSignal): AsyncGenerator<ResultBatch> {
    const conn = this.conn
    let discard = false
    let socketPaused = false

    const queue = new BatchQueue<ResultBatch>(
      (pressured) => {
        if (this.closed) return
        socketPaused = pressured
        if (pressured) conn.pause()
        else conn.resume()
      },
      HIGH_WATER,
      LOW_WATER,
    )

    let pending: unknown[][] = []
    const flush = (): void => {
      if (pending.length > 0) {
        queue.push({ kind: 'rows', rows: pending })
        pending = []
      }
    }

    const query = conn.query({ sql, rowsAsArray: true })
    const ended = new Promise<void>((resolve) => {
      query.on('end', resolve)
      query.on('error', () => resolve())
    })

    query.on('fields', (fields?: MysqlField[]) => {
      if (discard) return
      flush()
      if (fields) queue.push({ kind: 'columns', columns: fields.map(toColumnInfo) })
    })
    query.on('result', (row: unknown) => {
      if (discard) return
      if (Array.isArray(row)) {
        pending.push(row.map(toCell))
        if (pending.length >= BATCH_ROWS) flush()
      } else {
        flush()
        queue.push(okBatch(row as OkPacket))
      }
    })
    query.on('error', (error: unknown) => queue.fail(new MysqlError(error)))
    query.on('end', () => {
      flush()
      queue.end()
    })

    let finished = false
    const cancel = (): void => {
      discard = true
      void this.killRunning()
      // A paused socket would never deliver the "interrupted" packet.
      if (socketPaused) conn.resume()
    }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()

    try {
      for (;;) {
        const next = await queue.next()
        if (next.done) {
          finished = true
          // A statement that ends while the signal is aborted was cut short by the kill. Some of them
          // (SLEEP) end without an error, and would otherwise read as a result that completed.
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
      if (!finished) {
        // The consumer left early; the server may still be sending rows.
        discard = true
        await this.killRunning()
        if (socketPaused) conn.resume()
      }
      await this.drain(ended)
    }
  }

  /** Waits for the statement to finish after a cancel; a connection that won't settle is dropped. */
  private async drain(ended: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const settled = await Promise.race([
      ended.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS)
      }),
    ])
    clearTimeout(timer)
    if (!settled) {
      this.closed = true
      this.conn.destroy()
    }
  }

  /** `KILL QUERY` has to come from a second connection, because this one is busy. */
  private async killRunning(): Promise<void> {
    const threadId = this.conn.threadId
    if (threadId === null || threadId === undefined || this.closed) return
    const killer = createConnection({ ...this.options, connectTimeout: 5000 })
    killer.on('error', () => undefined)
    await new Promise<void>((resolve) => {
      killer.connect((error) => {
        if (error) return resolve()
        killer.query(`KILL QUERY ${Number(threadId)}`, () => resolve())
      })
    })
    killer.destroy()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.conn.destroy()
        resolve()
      }, 2000)
      this.conn.end(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private assertOpen(): void {
    if (this.closed) throw new SessionClosedError()
  }
}
