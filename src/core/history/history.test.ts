import { describe, expect, it, vi } from 'vitest'
import type { QueryEvent } from '@shared/query'
import { MAX_HISTORY_SQL_CHARS } from '@shared/scripts'
import { openDatabase } from '../storage/database'
import { RunRecorder, type RunContext } from './recorder'
import { HistoryStore, type NewHistoryEntry } from './store'

const entry = (overrides: Partial<NewHistoryEntry> = {}): NewHistoryEntry => ({
  ranAt: 1000,
  connectionId: 'c1',
  connectionName: 'Shop',
  environment: 'dev',
  database: 'shop',
  scriptId: 's1',
  sql: 'SELECT 1',
  status: 'ok',
  durationMs: 5,
  rows: 1,
  affected: null,
  errorCode: null,
  errorMessage: null,
  ...overrides,
})

describe('HistoryStore', () => {
  it('lists newest first and pages with a cursor', () => {
    const store = new HistoryStore(openDatabase(':memory:'), { now: () => 1000 })
    for (let i = 1; i <= 5; i++) store.record(entry({ sql: `SELECT ${i}` }))
    const first = store.list({ limit: 2 })
    expect(first.entries.map((e) => e.sql)).toEqual(['SELECT 5', 'SELECT 4'])
    expect(first.hasMore).toBe(true)
    const next = store.list({ limit: 2, before: first.entries[1]!.id })
    expect(next.entries.map((e) => e.sql)).toEqual(['SELECT 3', 'SELECT 2'])
    const last = store.list({ limit: 2, before: next.entries[1]!.id })
    expect(last.entries.map((e) => e.sql)).toEqual(['SELECT 1'])
    expect(last.hasMore).toBe(false)
  })

  it('filters by connection and status', () => {
    const store = new HistoryStore(openDatabase(':memory:'), { now: () => 1000 })
    store.record(entry({ sql: 'a', connectionId: 'c1' }))
    store.record(entry({ sql: 'b', connectionId: 'c2', status: 'error', errorMessage: 'boom' }))
    expect(store.list({ connectionId: 'c2' }).entries.map((e) => e.sql)).toEqual(['b'])
    expect(store.list({ status: 'error' }).entries[0]).toMatchObject({
      sql: 'b',
      errorMessage: 'boom',
    })
    expect(store.list({ status: 'cancelled' }).entries).toEqual([])
  })

  it('searches for every word, in any order, and treats % and _ as plain text', () => {
    const store = new HistoryStore(openDatabase(':memory:'), { now: () => 1000 })
    store.record(entry({ sql: 'SELECT * FROM orders WHERE total > 100' }))
    store.record(entry({ sql: 'SELECT * FROM customers' }))
    store.record(entry({ sql: "SELECT '100%' AS pct, a_b FROM t" }))
    expect(store.list({ search: 'orders total' }).entries).toHaveLength(1)
    expect(store.list({ search: 'FROM' }).entries).toHaveLength(3)
    expect(store.list({ search: '100%' }).entries).toHaveLength(1)
    expect(store.list({ search: 'a_b' }).entries).toHaveLength(1)
    expect(store.list({ search: '_' }).entries).toHaveLength(1)
    expect(store.list({ search: 'nothing here' }).entries).toEqual([])
  })

  it('keeps the start of a very long statement and says so', () => {
    const store = new HistoryStore(openDatabase(':memory:'), { now: () => 1000 })
    store.record(entry({ sql: 'x'.repeat(MAX_HISTORY_SQL_CHARS + 50) }))
    const [saved] = store.list().entries
    expect(saved!.sql).toHaveLength(MAX_HISTORY_SQL_CHARS)
    expect(saved!.sqlTruncated).toBe(true)
  })

  it('deletes one entry, one connection’s entries, or everything', () => {
    const store = new HistoryStore(openDatabase(':memory:'), { now: () => 1000 })
    store.record(entry({ connectionId: 'c1' }))
    store.record(entry({ connectionId: 'c2' }))
    store.record(entry({ connectionId: 'c1' }))
    store.delete(store.list().entries[0]!.id)
    expect(store.count()).toBe(2)
    store.clear('c1')
    expect(store.list().entries.map((e) => e.connectionId)).toEqual(['c2'])
    store.clear()
    expect(store.count()).toBe(0)
  })

  it('drops the oldest entries past the limit, and entries past the age limit', () => {
    let now = 10 * 24 * 60 * 60 * 1000
    const store = new HistoryStore(openDatabase(':memory:'), {
      now: () => now,
      maxEntries: 3,
      maxAgeDays: 5,
    })
    store.record(entry({ ranAt: 1, sql: 'ancient' }))
    for (let i = 1; i <= 4; i++) store.record(entry({ ranAt: now, sql: `new ${i}` }))
    // Pruning runs when the store is created and every couple of hundred entries.
    const again = new HistoryStore(store['db'], { now: () => now, maxEntries: 3, maxAgeDays: 5 })
    expect(again.list().entries.map((e) => e.sql)).toEqual(['new 4', 'new 3', 'new 2'])
    now += 1
  })
})

describe('RunRecorder', () => {
  const context: RunContext = {
    connectionId: 'c1',
    connectionName: 'Shop',
    environment: 'prod',
    database: 'shop',
    scriptId: 's1',
  }

  function setup(enabled = () => true) {
    const store = new HistoryStore(openDatabase(':memory:'), { now: () => 5000 })
    const onRecorded = vi.fn()
    let clock = 0
    const recorder = new RunRecorder(store, context, {
      enabled,
      onRecorded,
      now: () => 5000,
      clock: () => clock,
    })
    const send = (statement: number, event: QueryEvent): void =>
      recorder.observe({ runId: 'r1', statement, event })
    return { store, recorder, send, onRecorded, tick: (ms: number) => (clock += ms) }
  }

  it('records a query when it finishes, with its rows and the connection it ran on', () => {
    const { store, send, onRecorded } = setup()
    send(0, { type: 'start', sql: 'SELECT * FROM orders' })
    send(0, { type: 'columns', columns: [] })
    send(0, { type: 'rows', rows: [[1]] })
    send(0, { type: 'done', durationMs: 42, rowCount: 1 })
    expect(store.list().entries).toEqual([
      expect.objectContaining({
        sql: 'SELECT * FROM orders',
        status: 'ok',
        durationMs: 42,
        rows: 1,
        affected: null,
        connectionName: 'Shop',
        environment: 'prod',
        database: 'shop',
        scriptId: 's1',
        ranAt: 5000,
      }),
    ])
    expect(onRecorded).toHaveBeenCalledTimes(1)
  })

  it('records affected rows for a write, not a row count', () => {
    const { store, send } = setup()
    send(0, { type: 'start', sql: 'UPDATE t SET a = 1' })
    send(0, { type: 'ok', affectedRows: 7, insertId: null, message: '', warnings: 0 })
    send(0, { type: 'done', durationMs: 3, rowCount: 0 })
    expect(store.list().entries[0]).toMatchObject({ affected: 7, rows: null, status: 'ok' })
  })

  it('records a result that waits for more rows right away, and only once', () => {
    const { store, send, tick } = setup()
    send(0, { type: 'start', sql: 'SELECT * FROM big' })
    tick(120)
    send(0, { type: 'paused', rowsSent: 1000 })
    send(0, { type: 'done', durationMs: 9000, rowCount: 5000 })
    send(0, { type: 'cancelled' })
    const entries = store.list().entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ rows: 1000, durationMs: 120, status: 'ok' })
  })

  it('records a failure with its code and message, and cancels', () => {
    const { store, send } = setup()
    send(0, { type: 'start', sql: 'SELECT * FROM nope' })
    send(0, { type: 'error', code: 'ER_NO_SUCH_TABLE', message: 'no such table' })
    send(1, { type: 'start', sql: 'SELECT SLEEP(9)' })
    send(1, { type: 'cancelled' })
    const [cancelled, failed] = store.list().entries
    expect(failed).toMatchObject({
      status: 'error',
      errorCode: 'ER_NO_SUCH_TABLE',
      errorMessage: 'no such table',
    })
    expect(cancelled).toMatchObject({ status: 'cancelled', sql: 'SELECT SLEEP(9)' })
  })

  it('does not record statements that never started', () => {
    const { store, send } = setup()
    send(2, { type: 'error', code: null, message: 'x' })
    expect(store.count()).toBe(0)
  })

  it('records nothing when history is turned off, even mid-run', () => {
    let on = true
    const { store, send, recorder } = setup(() => on)
    send(0, { type: 'start', sql: 'SELECT 1' })
    on = false
    send(0, { type: 'done', durationMs: 1, rowCount: 1 })
    recorder.recordFailure('SELECT 2', null, 'x')
    expect(store.count()).toBe(0)
  })

  it('records a statement that could not be sent', () => {
    const { store, recorder } = setup()
    recorder.recordFailure('SELECT 1', 'ECONNREFUSED', 'connection refused')
    expect(store.list().entries[0]).toMatchObject({
      status: 'error',
      errorCode: 'ECONNREFUSED',
      durationMs: null,
    })
  })
})
