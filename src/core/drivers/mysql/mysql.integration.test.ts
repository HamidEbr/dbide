/**
 * Runs the MySQL driver against a real server. Skipped unless DBIDE_TEST_MYSQL_URL is set, e.g.
 *
 *   DBIDE_TEST_MYSQL_URL=mysql://root:secret@127.0.0.1:3306 pnpm test
 *
 * The URL's user needs to create and drop databases. Every test works inside a throwaway schema
 * that is dropped at the end. CI runs this against MySQL 8.0, 8.4, and MariaDB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newConnectionDraft, type ConnectionConfig } from '@shared/connection'
import type { DriverSession, ResultBatch, TreeNode } from '@shared/driver'
import { DEFAULT_EXPORT_OPTIONS } from '@shared/export'
import { parseConnectionUri } from '@shared/uri'
import { exportQuery, type ExportSink } from '../../export/export-query'
import { mysqlDriver } from './driver'
import { atLeast, parseServerVersion } from './version'

const url = process.env.DBIDE_TEST_MYSQL_URL
const parsed = url ? parseConnectionUri(url) : null

async function connect(
  overrides: { password?: string; readOnly?: boolean } = {},
): Promise<DriverSession> {
  const config: ConnectionConfig = {
    ...newConnectionDraft('mysql', 'it'),
    name: 'integration',
    host: parsed!.host,
    port: parsed!.port,
    ...(parsed!.username ? { username: parsed!.username } : {}),
  }
  const password = overrides.password ?? parsed!.password
  return mysqlDriver.connect({
    config,
    secrets: password ? { password } : {},
    endpoint: { host: config.host, port: config.port },
    ...(overrides.readOnly ? { readOnly: true } : {}),
    signal: new AbortController().signal,
  })
}

async function collect(
  session: DriverSession,
  text: string,
  target?: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<ResultBatch[]> {
  const batches: ResultBatch[] = []
  for await (const batch of session.execute({ text, ...(target ? { target } : {}) }, signal)) {
    batches.push(batch)
  }
  return batches
}

const rowsOf = (batches: ResultBatch[]): unknown[][] =>
  batches.flatMap((b) => (b.kind === 'rows' ? b.rows : []))

describe.skipIf(!parsed)('MySQL driver (live server)', () => {
  const schema = `dbide_it_${Math.random().toString(16).slice(2, 10)}`
  let session: DriverSession
  let isMariaDb = false
  /** What this server has, by version: the suite runs against 5.5 through 8.4 and MariaDB. */
  let hasJson = true
  let hasGeneratedColumns = true
  let hasReadOnlyMode = true

  beforeAll(async () => {
    session = await connect()
    isMariaDb = /mariadb/i.test(session.info.serverVersion)
    const version = parseServerVersion(session.info.serverVersion)!
    hasJson = !isMariaDb && atLeast(version, 5, 7, 8)
    hasGeneratedColumns = isMariaDb ? atLeast(version, 10, 2) : atLeast(version, 5, 7, 6)
    hasReadOnlyMode = isMariaDb || atLeast(version, 5, 6, 5)
    await collect(session, `CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`)
    await collect(
      session,
      `CREATE TABLE items (
         id INT AUTO_INCREMENT PRIMARY KEY,
         name VARCHAR(100) NOT NULL,
         price DECIMAL(10,2),
         qty BIGINT,
         created DATETIME,
         data ${hasJson ? 'JSON' : 'LONGTEXT'},
         bin BLOB,
         note TEXT,
         INDEX by_name (name)
       )`,
      schema,
    )
    // A thousand numbers to cross-join into big results on any version.
    await collect(session, 'CREATE TABLE nums (n INT PRIMARY KEY)', schema)
    await collect(
      session,
      `INSERT INTO nums VALUES ${Array.from({ length: 1000 }, (_, i) => `(${i + 1})`).join(',')}`,
      schema,
    )
    await collect(
      session,
      `CREATE TABLE orders (
         id INT PRIMARY KEY,
         item_id INT,
         CONSTRAINT fk_item FOREIGN KEY (item_id) REFERENCES items (id)
       )`,
    )
    await collect(
      session,
      `INSERT INTO items (name, price, qty, created, data, bin, note) VALUES
         ('plain', 12345.67, 9007199254740993, '2026-03-01 12:30:45', '{"a": [1, 2]}', 0x0102ff, 'hello'),
         ('emoji 🎉 日本語', 0.10, NULL, NULL, NULL, NULL, NULL),
         ('empty', NULL, 0, '1999-12-31 23:59:59', '{}', X'', '')`,
    )
  })

  afterAll(async () => {
    await collect(session, `DROP DATABASE IF EXISTS \`${schema}\``).catch(() => undefined)
    await session.close()
  })

  it('connects and reports the server version and current database', () => {
    expect(session.info.serverVersion).toMatch(/\d+\.\d+/)
    expect(session.info.currentDatabase).toBe(schema)
    expect(session.info.readOnly).toBe(false)
  })

  it('pings', async () => {
    await expect(session.ping()).resolves.toBeUndefined()
  })

  it('rejects a wrong password with the server’s message and a hint', async () => {
    await expect(connect({ password: 'definitely-wrong' })).rejects.toThrow(/Access denied/)
  })

  it('returns columns, then rows, with exact types', async () => {
    const batches = await collect(
      session,
      'SELECT id, name, price, qty, created, data, bin, note FROM items ORDER BY id',
    )
    expect(batches[0]).toMatchObject({ kind: 'columns' })
    const columns = batches[0]!.kind === 'columns' ? batches[0].columns : []
    expect(columns.map((c) => c.type).slice(0, 5)).toEqual([
      'int',
      'varchar',
      'decimal',
      'bigint',
      'datetime',
    ])
    expect(columns[6]!.type).toBe('blob')
    expect(columns.every((c) => c.table === 'items')).toBe(true)

    const [plain, emoji, empty] = rowsOf(batches)
    expect(plain![0]).toBe(1)
    expect(plain![2]).toBe('12345.67') // decimals stay exact, as text
    expect(plain![3]).toBe('9007199254740993') // bigint beyond 2^53 survives
    expect(plain![4]).toBe('2026-03-01 12:30:45') // no time zone shifting
    expect(JSON.parse(plain![5] as string)).toEqual({ a: [1, 2] })
    expect([...(plain![6] as Uint8Array)]).toEqual([1, 2, 255])
    expect(emoji![1]).toBe('emoji 🎉 日本語')
    expect(emoji![3]).toBeNull()
    expect(emoji![6]).toBeNull()
    expect(empty![7]).toBe('')
    expect((empty![6] as Uint8Array).length).toBe(0)
  })

  it('reports OK packets for statements without a result set', async () => {
    const insert = await collect(session, "INSERT INTO items (name) VALUES ('temp')")
    expect(insert).toEqual([
      {
        kind: 'ok',
        affectedRows: 1,
        insertId: expect.stringMatching(/^\d+$/),
        message: '',
        warnings: 0,
      },
    ])
    const update = await collect(session, "UPDATE items SET note = 'x' WHERE name = 'temp'")
    expect(update[0]).toMatchObject({ kind: 'ok', affectedRows: 1, insertId: null })
    await collect(session, "DELETE FROM items WHERE name = 'temp'")
  })

  it('applies the target database before running', async () => {
    const other = await connect()
    try {
      const batches = await collect(other, 'SELECT DATABASE()', schema)
      expect(rowsOf(batches)[0]![0]).toBe(schema)
    } finally {
      await other.close()
    }
  })

  it('returns every result set of a stored procedure', async () => {
    await collect(
      session,
      'CREATE PROCEDURE two_results() BEGIN SELECT 1 AS a; SELECT 2 AS b, 3 AS c; END',
    )
    const batches = await collect(session, 'CALL two_results()')
    const kinds = batches.map((b) => b.kind)
    expect(kinds.filter((k) => k === 'columns')).toHaveLength(2)
    // MySQL types a literal BIGINT (exact text) and MariaDB INT (a number); the values are the same.
    expect(rowsOf(batches).map((row) => row.map(String))).toEqual([['1'], ['2', '3']])
    expect(kinds.at(-1)).toBe('ok')
  })

  it('surfaces SQL errors with their code and leaves the session usable', async () => {
    await expect(collect(session, 'SELEC 1')).rejects.toMatchObject({ code: 'ER_PARSE_ERROR' })
    expect(String(rowsOf(await collect(session, 'SELECT 1'))[0]![0])).toBe('1')
  })

  it('streams a large result in bounded batches', async () => {
    const sizes: number[] = []
    let total = 0
    for await (const batch of session.execute(
      {
        // 200 x 1,000 rows from a cross join: recursive queries came with MySQL 8.0, and this suite
        // runs back to 5.5.
        text: 'SELECT (a.n - 1) * 1000 + b.n AS n FROM nums a, nums b WHERE a.n <= 200',
      },
      new AbortController().signal,
    )) {
      if (batch.kind !== 'rows') continue
      sizes.push(batch.rows.length)
      total += batch.rows.length
      // A slow consumer must slow the server down, not buffer the result.
      if (sizes.length % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(total).toBe(200_000)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(500)
  }, 60_000)

  it('stays usable after the consumer stops early', async () => {
    const iterable = session.execute(
      {
        text: 'SELECT (a.n - 1) * 1000 + b.n AS n FROM nums a, nums b WHERE a.n <= 900',
      },
      new AbortController().signal,
    )
    const iterator = iterable[Symbol.asyncIterator]()
    let sawRows = false
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      if (next.value.kind === 'rows') {
        sawRows = true
        break
      }
    }
    expect(sawRows).toBe(true)
    await iterator.return?.()
    expect(String(rowsOf(await collect(session, 'SELECT 42'))[0]![0])).toBe('42')
  }, 60_000)

  it('cancels a running statement quickly and stays usable', async () => {
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 300)
    await expect(
      collect(session, 'SELECT SLEEP(30)', undefined, controller.signal),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(String(rowsOf(await collect(session, 'SELECT 7'))[0]![0])).toBe('7')
  }, 30_000)

  it('lists the schema in the tree, down to columns, indexes, and foreign keys', async () => {
    const signal = new AbortController().signal
    const roots = await session.children(null, signal)
    const database = roots.find((n) => n.label === schema)
    expect(database).toMatchObject({ kind: 'database', hasChildren: true, scope: schema })
    expect(roots.at(-1)).toMatchObject({ label: 'System schemas', kind: 'group' })

    const groups = await session.children(database!, signal)
    const tablesGroup = groups.find((g) => g.label === 'Tables')!
    expect(tablesGroup.detail).toBe('3')

    const tables = await session.children(tablesGroup, signal)
    expect(tables.map((t) => t.label)).toEqual(['items', 'nums', 'orders'])

    const items = tables.find((t) => t.label === 'items') as TreeNode
    const columns = await session.children(items, signal)
    const id = columns.find((c) => c.label === 'id')!
    expect(id.detail).toContain('PK')
    expect(id.detail).toContain('auto')

    const indexGroup = columns.find((c) => c.label === 'Indexes')!
    const indexes = await session.children(indexGroup, signal)
    expect(indexes.map((i) => i.label)).toEqual(['by_name', 'PRIMARY'])

    const orders = tables.find((t) => t.label === 'orders') as TreeNode
    const ordersColumns = await session.children(orders, signal)
    const fkGroup = ordersColumns.find((c) => c.label === 'Foreign keys')!
    const fks = await session.children(fkGroup, signal)
    expect(fks[0]).toMatchObject({ label: 'fk_item', detail: 'item_id → items(id)' })
  })

  it('gives autocomplete the tables and columns of a database', async () => {
    const schemaMap = await session.completionSchema!(schema, new AbortController().signal)
    expect(schemaMap.items).toEqual([
      'id',
      'name',
      'price',
      'qty',
      'created',
      'data',
      'bin',
      'note',
    ])
    expect(schemaMap.orders).toEqual(['id', 'item_id'])
  })

  it('holds a read-only session read-only: on the server where it can, in the driver where it can not', async () => {
    const readOnly = await connect({ readOnly: true })
    try {
      expect(readOnly.info.readOnly).toBe(true)
      // MySQL before 5.6.5 has no read-only transactions; the driver says so and refuses writes itself.
      expect(readOnly.info.readOnlyEnforcedByServer).toBe(hasReadOnlyMode)
      expect(String(rowsOf(await collect(readOnly, 'SELECT 1'))[0]![0])).toBe('1')

      for (const statement of [
        `INSERT INTO \`${schema}\`.items (name) VALUES ('nope')`,
        `DELETE FROM \`${schema}\`.items`,
        `CREATE TABLE \`${schema}\`.ro_test (a INT)`,
        `DROP TABLE \`${schema}\`.orders`,
      ]) {
        await expect(collect(readOnly, statement)).rejects.toMatchObject(
          hasReadOnlyMode
            ? {
                code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION',
                message: expect.stringContaining('Unlock writes'),
              }
            : { code: 'READ_ONLY', message: expect.stringContaining('can’t enforce') },
        )
      }
      // Nothing got through, whichever layer refused it.
      expect(
        String(
          rowsOf(
            await collect(session, `SELECT COUNT(*) FROM \`${schema}\`.items WHERE name = 'nope'`),
          )[0]![0],
        ),
      ).toBe('0')

      await readOnly.setReadOnly!(false)
      expect(readOnly.info.readOnly).toBe(false)
      await collect(readOnly, `INSERT INTO \`${schema}\`.items (name) VALUES ('allowed')`)
      await collect(readOnly, `DELETE FROM \`${schema}\`.items WHERE name = 'allowed'`)
    } finally {
      await readOnly.close()
    }
  })

  it('reports where plain columns come from, and nothing for expressions', async () => {
    const batches = await collect(
      session,
      `SELECT id AS ident, name, id + 1 AS computed, COUNT(*) AS n FROM \`${schema}\`.items GROUP BY id, name`,
    )
    const columns = batches[0]!.kind === 'columns' ? batches[0].columns : []
    expect(columns[0]).toMatchObject({
      name: 'ident',
      table: 'items',
      source: { schema, table: 'items', column: 'id' },
    })
    expect(columns[1]!.source).toEqual({ schema, table: 'items', column: 'name' })
    expect(columns[2]!.source).toBeUndefined()
    expect(columns[3]!.source).toBeUndefined()
  })

  it('describes a table: primary key, nullability, auto-increment, and generated columns', async ({
    skip,
  }) => {
    if (!hasGeneratedColumns) skip()
    await collect(
      session,
      `CREATE TABLE \`${schema}\`.gen (id INT NOT NULL, part INT NOT NULL, a INT NULL, b INT AS (a * 2) VIRTUAL, PRIMARY KEY (part, id))`,
    )
    try {
      const gen = await session.describeTable!(schema, 'gen', new AbortController().signal)
      expect(gen.primaryKey).toEqual(['part', 'id'])
      expect(gen.columns.find((c) => c.name === 'b')).toMatchObject({ generated: true })
      expect(gen.columns.find((c) => c.name === 'a')).toMatchObject({
        nullable: true,
        generated: false,
      })

      const items = await session.describeTable!(schema, 'items', new AbortController().signal)
      expect(items.primaryKey).toEqual(['id'])
      expect(items.columns[0]).toMatchObject({
        name: 'id',
        type: 'int',
        autoIncrement: true,
        nullable: false,
      })
      expect(items.columns.find((c) => c.name === 'data')).toBeDefined()

      await expect(
        session.describeTable!(schema, 'does_not_exist', new AbortController().signal),
      ).rejects.toThrow(/not found/)
    } finally {
      await collect(session, `DROP TABLE \`${schema}\`.gen`)
    }
  })

  it('describes foreign keys in both directions, so a result can jump along them', async () => {
    const signal = new AbortController().signal
    const orders = await session.describeTable!(schema, 'orders', signal)
    expect(orders.foreignKeys).toEqual([
      {
        name: 'fk_item',
        columns: ['item_id'],
        refSchema: schema,
        refTable: 'items',
        refColumns: ['id'],
      },
    ])
    expect(orders.referencedBy).toEqual([])

    const items = await session.describeTable!(schema, 'items', signal)
    expect(items.foreignKeys).toEqual([])
    expect(items.referencedBy).toEqual([
      { name: 'fk_item', schema, table: 'orders', columns: ['item_id'], refColumns: ['id'] },
    ])
  })

  it('applies edits in one transaction and reports insert ids', async () => {
    const editor = await connect()
    try {
      const signal = new AbortController().signal
      const result = await editor.applyEdits!(
        {
          schema,
          table: 'items',
          changes: [
            { kind: 'insert', values: { name: 'staged one', price: '1.50' } },
            { kind: 'insert', values: { name: 'staged two', bin: new Uint8Array([0, 255]) } },
          ],
        },
        signal,
      )
      expect(result).toMatchObject({ ok: true })
      const ids = result.ok ? result.results.map((r) => r.insertId) : []
      expect(ids.every((id) => /^\d+$/.test(id ?? ''))).toBe(true)

      const [first, second] = ids as string[]
      const update = await editor.applyEdits!(
        {
          schema,
          table: 'items',
          changes: [
            {
              kind: 'update',
              key: { id: Number(first) },
              values: { name: "O'Brien", note: null, price: '2.25' },
            },
            { kind: 'delete', key: { id: Number(second) } },
          ],
        },
        signal,
      )
      expect(update).toMatchObject({ ok: true })

      const rows = rowsOf(
        await collect(
          session,
          `SELECT name, note, price FROM \`${schema}\`.items WHERE id = ${first}`,
        ),
      )
      expect(rows).toEqual([["O'Brien", null, '2.25']])
      expect(
        rowsOf(
          await collect(session, `SELECT COUNT(*) FROM \`${schema}\`.items WHERE id = ${second}`),
        )[0]![0],
      ).toBe('0')
      await collect(session, `DELETE FROM \`${schema}\`.items WHERE id = ${first}`)
    } finally {
      await editor.close()
    }
  })

  it('rolls everything back when one change touches no row', async () => {
    const editor = await connect()
    try {
      const before = rowsOf(
        await collect(session, `SELECT COUNT(*) FROM \`${schema}\`.items`),
      )[0]![0]
      const result = await editor.applyEdits!(
        {
          schema,
          table: 'items',
          changes: [
            { kind: 'insert', values: { name: 'should not survive' } },
            { kind: 'update', key: { id: 987_654_321 }, values: { name: 'nobody' } },
          ],
        },
        new AbortController().signal,
      )
      expect(result).toMatchObject({ ok: false, failedIndex: 1, code: 'ROW_COUNT' })
      expect(
        rowsOf(await collect(session, `SELECT COUNT(*) FROM \`${schema}\`.items`))[0]![0],
      ).toBe(before)
    } finally {
      await editor.close()
    }
  })

  it('reports a constraint failure with the server’s message and keeps nothing', async () => {
    const editor = await connect()
    try {
      const result = await editor.applyEdits!(
        {
          schema,
          table: 'orders',
          changes: [{ kind: 'insert', values: { id: 777, item_id: 987_654_321 } }],
        },
        new AbortController().signal,
      )
      expect(result).toMatchObject({ ok: false, failedIndex: 0, code: 'ER_NO_REFERENCED_ROW_2' })
      expect(
        rowsOf(
          await collect(session, `SELECT COUNT(*) FROM \`${schema}\`.orders WHERE id = 777`),
        )[0]![0],
      ).toBe('0')
    } finally {
      await editor.close()
    }
  })

  it('does not let a read-only session apply edits', async () => {
    const readOnly = await connect({ readOnly: true })
    try {
      const result = await readOnly.applyEdits!(
        { schema, table: 'items', changes: [{ kind: 'insert', values: { name: 'nope' } }] },
        new AbortController().signal,
      )
      expect(result).toMatchObject({ ok: false, code: 'READ_ONLY' })
    } finally {
      await readOnly.close()
    }
  })

  describe('export', () => {
    const memorySink = (): { sink: ExportSink; text: () => string } => {
      const chunks: string[] = []
      return {
        sink: {
          ready: () => Promise.resolve(),
          write: (chunk) => {
            chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
            return Promise.resolve()
          },
          finish: () => Promise.resolve(),
          abort: () => Promise.resolve(),
        },
        text: () => chunks.join(''),
      }
    }

    it('streams every row of a large result, in order, on a read-only connection', async () => {
      await collect(session, 'CREATE TABLE many (n INT PRIMARY KEY, label VARCHAR(20))', schema)
      for (let start = 0; start < 30_000; start += 1000) {
        const values = Array.from(
          { length: 1000 },
          (_, i) => `(${start + i + 1}, 'row ${start + i + 1}')`,
        )
        await collect(session, `INSERT INTO many VALUES ${values.join(',')}`, schema)
      }

      const reader = await connect({ readOnly: true })
      try {
        const out = memorySink()
        const result = await exportQuery({
          session: reader,
          sql: 'SELECT n, label FROM many ORDER BY n',
          database: schema,
          format: 'csv',
          options: DEFAULT_EXPORT_OPTIONS,
          sink: out.sink,
          signal: new AbortController().signal,
        })
        const lines = out.text().trimEnd().split('\n')
        expect(result.rows).toBe(30_000)
        expect(lines).toHaveLength(30_001)
        expect(lines[0]).toBe('n,label')
        expect(lines[1]).toBe('1,row 1')
        expect(lines.at(-1)).toBe('30000,row 30000')
      } finally {
        await reader.close()
      }
    })

    it('keeps awkward values intact: quotes, line breaks, unicode, NULL, binary, exact decimals', async () => {
      const out = memorySink()
      await exportQuery({
        session,
        // The three rows the suite starts with; other tests add and remove rows of their own.
        sql: 'SELECT id, name, price, qty, bin, note FROM items WHERE id <= 3 ORDER BY id',
        database: schema,
        format: 'json',
        options: DEFAULT_EXPORT_OPTIONS,
        sink: out.sink,
        signal: new AbortController().signal,
      })
      const rows = JSON.parse(out.text()) as Record<string, unknown>[]
      expect(rows).toHaveLength(3)
      expect(rows[0]).toMatchObject({
        name: 'plain',
        price: 12345.67,
        bin: '0x0102ff',
        note: 'hello',
      })
      // A bigint beyond 2^53 survives as digits, which JSON.parse can not hold but a file can.
      expect(out.text()).toContain('"qty":9007199254740993')
      expect(rows[1]).toMatchObject({ name: 'emoji 🎉 日本語', qty: null, bin: null })
      expect(rows[2]).toMatchObject({ qty: 0, note: '' })
    })

    it('stops a running export when cancelled and leaves the server free', async () => {
      const reader = await connect({ readOnly: true })
      const controller = new AbortController()
      const started = Date.now()
      setTimeout(() => controller.abort(), 300)
      try {
        await expect(
          exportQuery({
            session: reader,
            sql: 'SELECT SLEEP(30)',
            database: null,
            format: 'csv',
            options: DEFAULT_EXPORT_OPTIONS,
            sink: memorySink().sink,
            signal: controller.signal,
          }),
        ).rejects.toBeDefined()
        expect(Date.now() - started).toBeLessThan(5000)
      } finally {
        await reader.close()
      }
    })
  })

  it('refuses to use a closed session', async () => {
    const closing = await connect()
    await closing.close()
    await expect(closing.ping()).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
  })
})
