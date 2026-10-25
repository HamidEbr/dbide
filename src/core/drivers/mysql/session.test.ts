import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { ResultBatch, SessionInfo } from '@shared/driver'
import { MysqlSession } from './session'

/** Just enough of a connection to drive the session without a server. */
class FakeConnection extends EventEmitter {
  threadId = 7
  readonly sent: string[] = []
  /** Statements the "server" answers with a syntax error, like a version that doesn't know them. */
  readonly syntaxErrors = new Set<string>()
  /** The error code the "server" gives for them: a parse error, or 5.5's unknown-variable error. */
  errorCode = 'ER_PARSE_ERROR'

  query(arg: string | { sql: string }, callback?: (error: unknown, rows?: unknown[]) => void) {
    const sql = typeof arg === 'string' ? arg : arg.sql
    this.sent.push(sql)
    if (callback) {
      queueMicrotask(() =>
        this.syntaxErrors.has(sql)
          ? callback(
              Object.assign(new Error('You have an error in your SQL syntax'), {
                code: this.errorCode,
                sqlMessage: 'You have an error in your SQL syntax',
              }),
            )
          : callback(null, []),
      )
      return undefined
    }
    const query = new EventEmitter()
    queueMicrotask(() => {
      query.emit('fields', [{ name: 'a', columnType: 3, characterSet: 63, flags: 0 }])
      query.emit('result', [1])
      query.emit('end')
    })
    return query
  }
  pause(): void {}
  resume(): void {}
  destroy(): void {}
  end(callback: () => void): void {
    callback()
  }
}

function sessionWith(info: Partial<SessionInfo> = {}) {
  const conn = new FakeConnection()
  const session = new MysqlSession(conn as never, {} as never, {
    serverVersion: '5.5.62',
    currentDatabase: null,
    readOnly: false,
    ...info,
  })
  return { conn, session }
}

async function run(session: MysqlSession, text: string): Promise<ResultBatch[]> {
  const batches: ResultBatch[] = []
  for await (const batch of session.execute({ text }, new AbortController().signal))
    batches.push(batch)
  return batches
}

describe('a read-only session on a server that can not enforce it', () => {
  const guarded = { readOnly: true, readOnlyEnforcedByServer: false }

  it('refuses a write before it is sent, and says why', async () => {
    const { conn, session } = sessionWith(guarded)
    for (const sql of [
      'INSERT INTO t VALUES (1)',
      'DROP TABLE t',
      'CALL purge()',
      'SET GLOBAL x = 1',
    ]) {
      await expect(run(session, sql), sql).rejects.toMatchObject({
        code: 'READ_ONLY',
        message: expect.stringContaining('can’t enforce that itself'),
      })
    }
    expect(conn.sent).toEqual([])
  })

  it('lets a read through', async () => {
    const { conn, session } = sessionWith(guarded)
    const batches = await run(session, 'SELECT 1')
    expect(batches.map((b) => b.kind)).toEqual(['columns', 'rows'])
    expect(conn.sent).toEqual(['SELECT 1'])
  })

  it('lets writes through once it is unlocked', async () => {
    const { conn, session } = sessionWith(guarded)
    await session.setReadOnly(false)
    expect(session.info).toMatchObject({ readOnly: false })
    await run(session, 'INSERT INTO t VALUES (1)')
    expect(conn.sent).toContain('INSERT INTO t VALUES (1)')
    // There was never a server mode to switch back, so none is asked for.
    expect(conn.sent.some((sql) => sql.includes('READ WRITE'))).toBe(false)
  })
})

describe('setReadOnly', () => {
  it('asks the server, and trusts it when it can do it', async () => {
    const { conn, session } = sessionWith({ serverVersion: '8.4.13' })
    await session.setReadOnly(true)
    expect(conn.sent).toEqual(['SET SESSION TRANSACTION READ ONLY'])
    expect(session.info).toMatchObject({ readOnly: true, readOnlyEnforcedByServer: true })
    await expect(run(session, 'DELETE FROM t')).resolves.toBeDefined()
    await session.setReadOnly(false)
    expect(conn.sent.at(-1)).toBe('SET SESSION TRANSACTION READ WRITE')
    expect(session.info).toMatchObject({ readOnly: false, readOnlyEnforcedByServer: true })
  })

  it('takes over when the server answers with a syntax error, and guards writes itself from then on', async () => {
    const { conn, session } = sessionWith()
    conn.syntaxErrors.add('SET SESSION TRANSACTION READ ONLY')
    await session.setReadOnly(true)
    expect(session.info).toMatchObject({ readOnly: true, readOnlyEnforcedByServer: false })
    await expect(run(session, 'DELETE FROM t')).rejects.toMatchObject({ code: 'READ_ONLY' })
  })

  it('does the same when the server reads TRANSACTION as a variable, as MySQL 5.5 does', async () => {
    const { conn, session } = sessionWith()
    conn.syntaxErrors.add('SET SESSION TRANSACTION READ ONLY')
    conn.errorCode = 'ER_UNKNOWN_SYSTEM_VARIABLE'
    await session.setReadOnly(true)
    expect(session.info).toMatchObject({ readOnly: true, readOnlyEnforcedByServer: false })
  })

  it('does not hide any other failure behind that fallback', async () => {
    const { conn, session } = sessionWith()
    const query = conn.query.bind(conn)
    conn.query = ((arg: { sql: string } | string, callback?: (error: unknown) => void) =>
      callback
        ? void queueMicrotask(() =>
            callback(Object.assign(new Error('gone'), { code: 'PROTOCOL_CONNECTION_LOST' })),
          )
        : query(arg as never)) as never
    await expect(session.setReadOnly(true)).rejects.toMatchObject({
      code: 'PROTOCOL_CONNECTION_LOST',
    })
    expect(session.info.readOnly).toBe(false)
  })
})

describe('a closed session', () => {
  it('rejects instead of throwing', async () => {
    const { session } = sessionWith()
    await session.close()
    await expect(session.ping()).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
    await expect(session.query('SELECT 1')).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
  })
})
