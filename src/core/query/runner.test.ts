import { describe, expect, it } from 'vitest'
import type { DriverSession, ResultBatch } from '@shared/driver'
import type { QueryEvent, QueryEventMessage } from '@shared/query'
import { fakeSession } from '../testing'
import { RowAllowance, runStatements, type RunnerOptions } from './runner'

const rows = (count: number, from = 0): unknown[][] =>
  Array.from({ length: count }, (_, i) => [from + i])

/** A session whose statements stream the given batches. */
function sessionFor(script: (sql: string) => ResultBatch[] | Error): DriverSession & {
  executed: { sql: string; target?: string }[]
  returned: number
} {
  const executed: { sql: string; target?: string }[] = []
  const state = { returned: 0 }
  const session = fakeSession({
    execute(request) {
      executed.push({ sql: request.text, ...(request.target ? { target: request.target } : {}) })
      const result = script(request.text)
      return {
        [Symbol.asyncIterator]() {
          let index = 0
          return {
            next: async () => {
              if (result instanceof Error) throw result
              const value = result[index++]
              return value ? { value, done: false } : { value: undefined, done: true }
            },
            return: async () => {
              state.returned++
              return { value: undefined, done: true }
            },
          }
        },
      }
    },
  })
  Object.defineProperty(session, 'returned', { get: () => state.returned })
  return Object.assign(session, { executed }) as DriverSession & {
    executed: { sql: string; target?: string }[]
    returned: number
  }
}

function setup(session: DriverSession, statements: string[], extra: Partial<RunnerOptions> = {}) {
  const events: QueryEventMessage[] = []
  const allowances = new Map<number, RowAllowance>()
  const controller = new AbortController()
  const options: RunnerOptions = {
    session,
    runId: 'run-1',
    statements,
    database: null,
    pageSize: 10,
    signal: controller.signal,
    emit: (message) => events.push(message),
    onAllowance: (statement, allowance) => allowances.set(statement, allowance),
    ...extra,
  }
  return {
    events,
    allowances,
    controller,
    run: () => runStatements(options),
    types: (statement = 0): QueryEvent['type'][] =>
      events.filter((e) => e.statement === statement).map((e) => e.event.type),
    rowCount: (statement = 0): number =>
      events
        .filter((e) => e.statement === statement && e.event.type === 'rows')
        .reduce(
          (sum, e) => sum + (e.event as Extract<QueryEvent, { type: 'rows' }>).rows.length,
          0,
        ),
  }
}

describe('runStatements', () => {
  it('streams columns, rows, and a final done for a small result', async () => {
    const session = sessionFor(() => [
      { kind: 'columns', columns: [{ name: 'n', type: 'int' }] },
      { kind: 'rows', rows: rows(3) },
    ])
    const t = setup(session, ['SELECT n FROM t'])
    expect(await t.run()).toEqual({ outcome: 'completed', statementsRun: 1 })
    expect(t.types()).toEqual(['start', 'columns', 'rows', 'done'])
    const done = t.events.at(-1)!.event
    expect(done).toMatchObject({ type: 'done', rowCount: 3 })
  })

  it('reports statements that return no rows', async () => {
    const session = sessionFor(() => [
      { kind: 'ok', affectedRows: 5, insertId: '42', message: 'Rows matched: 5', warnings: 1 },
    ])
    const t = setup(session, ['UPDATE t SET a = 1 WHERE b = 2'])
    await t.run()
    expect(t.events[1]!.event).toEqual({
      type: 'ok',
      affectedRows: 5,
      insertId: '42',
      message: 'Rows matched: 5',
      warnings: 1,
    })
  })

  it('selects the script database only for the first statement', async () => {
    const session = sessionFor(() => [])
    await setup(session, ['SELECT 1', 'SELECT 2'], { database: 'shop' }).run()
    expect(session.executed).toEqual([{ sql: 'SELECT 1', target: 'shop' }, { sql: 'SELECT 2' }])
  })

  it('stops after the first page and waits, then continues when asked for more', async () => {
    const session = sessionFor(() => [
      { kind: 'columns', columns: [{ name: 'n', type: 'int' }] },
      { kind: 'rows', rows: rows(25) },
    ])
    const t = setup(session, ['SELECT n FROM t'], { pageSize: 10 })
    const finished = t.run()

    await waitFor(() => t.types().filter((x) => x === 'paused').length === 1)
    expect(t.rowCount()).toBe(10)
    expect(t.events.at(-1)!.event).toEqual({ type: 'paused', rowsSent: 10 })

    t.allowances.get(0)!.grant(10)
    await waitFor(() => t.types().filter((x) => x === 'paused').length === 2)
    expect(t.rowCount()).toBe(20)

    t.allowances.get(0)!.grant('all')
    await finished
    expect(t.rowCount()).toBe(25)
    expect(t.types().at(-1)).toBe('done')
    expect(t.events.at(-1)!.event).toMatchObject({ rowCount: 25 })
  })

  it('does not pause when the result is exactly one page', async () => {
    const session = sessionFor(() => [
      { kind: 'columns', columns: [{ name: 'n', type: 'int' }] },
      { kind: 'rows', rows: rows(10) },
    ])
    const t = setup(session, ['SELECT n FROM t'], { pageSize: 10 })
    await t.run()
    expect(t.types()).not.toContain('paused')
    expect(t.rowCount()).toBe(10)
  })

  it('handles a page boundary inside a batch that arrives after earlier batches', async () => {
    const session = sessionFor(() => [
      { kind: 'columns', columns: [{ name: 'n', type: 'int' }] },
      { kind: 'rows', rows: rows(6) },
      { kind: 'rows', rows: rows(6, 6) },
    ])
    const t = setup(session, ['SELECT n FROM t'], { pageSize: 10 })
    const finished = t.run()
    await waitFor(() => t.types().includes('paused'))
    expect(t.rowCount()).toBe(10)
    t.allowances.get(0)!.grant('all')
    await finished
    expect(t.rowCount()).toBe(12)
    const sent = t.events.flatMap((e) => (e.event.type === 'rows' ? e.event.rows.flat() : []))
    expect(sent).toEqual(Array.from({ length: 12 }, (_, i) => i))
  })

  it('stops the script at the first error and reports its code', async () => {
    const failing = Object.assign(new Error("Table 'x' doesn't exist"), {
      code: 'ER_NO_SUCH_TABLE',
    })
    const session = sessionFor((sql) =>
      sql.includes('bad')
        ? failing
        : [{ kind: 'ok', affectedRows: 0, insertId: null, message: '', warnings: 0 }],
    )
    const t = setup(session, ['SELECT 1', 'SELECT bad', 'SELECT 3'])
    const result = await t.run()
    expect(result).toEqual({ outcome: 'error', statementsRun: 2, errorCode: 'ER_NO_SUCH_TABLE' })
    expect(t.events.find((e) => e.event.type === 'error')).toMatchObject({
      statement: 1,
      event: { type: 'error', code: 'ER_NO_SUCH_TABLE', message: "Table 'x' doesn't exist" },
    })
    expect(session.executed.map((e) => e.sql)).toEqual(['SELECT 1', 'SELECT bad'])
  })

  it('cancels while paused: the statement is closed and the run reports cancelled', async () => {
    const session = sessionFor(() => [
      { kind: 'columns', columns: [{ name: 'n', type: 'int' }] },
      { kind: 'rows', rows: rows(25) },
    ])
    const t = setup(session, ['SELECT n FROM t', 'SELECT 2'], { pageSize: 10 })
    const finished = t.run()
    await waitFor(() => t.types().includes('paused'))
    t.controller.abort()
    expect(await finished).toMatchObject({ outcome: 'cancelled' })
    expect(t.types()).toContain('cancelled')
    expect(session.executed).toHaveLength(1)
    expect(session.returned).toBeGreaterThan(0)
  })

  it('does not start work when already cancelled', async () => {
    const session = sessionFor(() => [])
    const t = setup(session, ['SELECT 1'])
    t.controller.abort()
    expect(await t.run()).toEqual({ outcome: 'cancelled', statementsRun: 0 })
    expect(session.executed).toHaveLength(0)
  })

  it('never holds more than the hard cap and says it stopped', async () => {
    const session = sessionFor(() => [
      { kind: 'columns', columns: [{ name: 'n', type: 'int' }] },
      { kind: 'rows', rows: rows(600_000) },
      { kind: 'rows', rows: rows(600_000, 600_000) },
      { kind: 'rows', rows: rows(600_000, 1_200_000) },
    ])
    const t = setup(session, ['SELECT n FROM big'], { pageSize: 1_000_000 })
    await t.run()
    expect(t.rowCount()).toBe(1_000_000)
    expect(t.events.at(-1)!.event).toMatchObject({
      type: 'done',
      rowCount: 1_000_000,
      truncated: true,
    })
    expect(session.returned).toBe(1)
  })
})

describe('RowAllowance', () => {
  it('grants relative to what was sent and never exceeds the cap', () => {
    const allowance = new RowAllowance(10)
    allowance.sent = 10
    allowance.grant(5)
    expect(allowance.value).toBe(15)
    allowance.grant('all')
    expect(allowance.value).toBe(1_000_000)
  })

  it('never lowers the limit', () => {
    const allowance = new RowAllowance(100)
    allowance.sent = 10
    allowance.grant(5)
    expect(allowance.value).toBe(100)
  })

  it('wait resolves on grant and on abort', async () => {
    const allowance = new RowAllowance(1)
    const controller = new AbortController()
    const granted = allowance.wait(controller.signal)
    allowance.grant(1)
    await granted

    const aborted = allowance.wait(controller.signal)
    controller.abort()
    await aborted
  })
})

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe('rows that stay in the core', () => {
  function held() {
    const appended: { key: string; first: number; rows: unknown[][] }[] = []
    return {
      appended,
      sink: {
        append: (key: string, first: number, batch: unknown[][]) =>
          void appended.push({ key, first, rows: batch }),
      },
    }
  }
  const events = (t: ReturnType<typeof setup>, type: QueryEvent['type']) =>
    t.events.filter((e) => e.event.type === type).map((e) => e.event)

  it('sends the window the first rows and keeps the rest, telling it how many it did not get', async () => {
    const session = sessionFor(() => [
      { kind: 'columns', columns: [{ name: 'n', type: 'int' }] },
      { kind: 'rows', rows: rows(8) },
    ])
    const store = held()
    const t = setup(session, ['SELECT n FROM t'], {
      pageSize: 100,
      spill: store.sink,
      residentRows: 5,
    })
    await t.run()
    expect(t.rowCount()).toBe(5)
    expect(events(t, 'spilled')).toEqual([{ type: 'spilled', count: 3 }])
    expect(store.appended).toEqual([{ key: 'run-1:0.0', first: 0, rows: rows(3, 5) }])
    expect(events(t, 'done')[0]).toMatchObject({ rowCount: 8 })
  })

  it('splits a batch that crosses the line, and numbers the held rows from where it left off', async () => {
    const session = sessionFor(() => [
      { kind: 'columns', columns: [{ name: 'n', type: 'int' }] },
      { kind: 'rows', rows: rows(4) },
      { kind: 'rows', rows: rows(4, 4) },
      { kind: 'rows', rows: rows(4, 8) },
    ])
    const store = held()
    const t = setup(session, ['SELECT n FROM t'], {
      pageSize: 100,
      spill: store.sink,
      residentRows: 6,
    })
    await t.run()
    expect(t.rowCount()).toBe(6)
    expect(store.appended.map((a) => [a.first, a.rows.length])).toEqual([
      [0, 2],
      [2, 4],
    ])
    expect(store.appended.flatMap((a) => a.rows.flat())).toEqual([6, 7, 8, 9, 10, 11])
  })

  it('counts held rows against the page the user asked for, so the first page still pauses', async () => {
    const session = sessionFor(() => [
      { kind: 'columns', columns: [{ name: 'n', type: 'int' }] },
      { kind: 'rows', rows: rows(30) },
    ])
    const store = held()
    const t = setup(session, ['SELECT n FROM t'], {
      pageSize: 10,
      spill: store.sink,
      residentRows: 5,
    })
    const run = t.run()
    await waitFor(() => t.types().includes('paused'))
    // Ten rows were sent in all: five to the window, five held. Then it waits to be asked.
    expect(t.events.at(-1)!.event).toEqual({ type: 'paused', rowsSent: 10 })
    expect(store.appended.flatMap((a) => a.rows).length).toBe(5)
    t.allowances.get(0)!.grant('all')
    await run
    expect(t.rowCount()).toBe(5)
    expect(store.appended.flatMap((a) => a.rows).length).toBe(25)
  })

  it('numbers each result set of a statement on its own', async () => {
    const session = sessionFor(() => [
      { kind: 'columns', columns: [{ name: 'a', type: 'int' }] },
      { kind: 'rows', rows: rows(3) },
      { kind: 'columns', columns: [{ name: 'b', type: 'int' }] },
      { kind: 'rows', rows: rows(3, 100) },
    ])
    const store = held()
    await setup(session, ['CALL p()'], { pageSize: 100, spill: store.sink, residentRows: 1 }).run()
    expect(store.appended.map((a) => [a.key, a.first, a.rows.flat()])).toEqual([
      ['run-1:0.0', 0, [1, 2]],
      ['run-1:0.1', 0, [101, 102]],
    ])
  })

  it('holds nothing when the result fits in the window', async () => {
    const session = sessionFor(() => [
      { kind: 'columns', columns: [{ name: 'n', type: 'int' }] },
      { kind: 'rows', rows: rows(5) },
    ])
    const store = held()
    const t = setup(session, ['SELECT n FROM t'], {
      pageSize: 100,
      spill: store.sink,
      residentRows: 5,
    })
    await t.run()
    expect(store.appended).toEqual([])
    expect(events(t, 'spilled')).toEqual([])
  })

  it('sends everything to the window when there is nowhere to hold rows', async () => {
    const session = sessionFor(() => [
      { kind: 'columns', columns: [{ name: 'n', type: 'int' }] },
      { kind: 'rows', rows: rows(8) },
    ])
    const t = setup(session, ['SELECT n FROM t'], { pageSize: 100, residentRows: 5 })
    await t.run()
    expect(t.rowCount()).toBe(8)
  })

  it('stops the run with the error when the rows can not be held', async () => {
    const session = sessionFor(() => [
      { kind: 'columns', columns: [{ name: 'n', type: 'int' }] },
      { kind: 'rows', rows: rows(8) },
    ])
    const t = setup(session, ['SELECT n FROM t'], {
      pageSize: 100,
      residentRows: 2,
      spill: {
        append: () => {
          throw Object.assign(new Error('Too much disk space.'), { code: 'RESULTS_TOO_LARGE' })
        },
      },
    })
    expect(await t.run()).toMatchObject({ outcome: 'error', errorCode: 'RESULTS_TOO_LARGE' })
    expect(events(t, 'error')[0]).toMatchObject({ message: 'Too much disk space.' })
  })
})
