import { CompletionContext, type Completion, type CompletionResult } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it, vi } from 'vitest'
import type { SchemaColumn, SchemaDetail, SchemaTable, TableColumns } from '@shared/driver'
import { SchemaCache, type SchemaLoader } from './schema-cache'
import { sqlCompletionSource } from './source'

const col = (
  name: string,
  type = 'int',
  key: SchemaColumn['key'] = '',
  comment = '',
): SchemaColumn => ({
  name,
  type,
  nullable: false,
  key,
  comment,
})
const table = (name: string, columns: SchemaColumn[], view = false, comment = ''): SchemaTable => ({
  name,
  view,
  comment,
  columns,
})

const SHOP: SchemaDetail = {
  database: 'shop',
  tables: [
    table(
      'orders',
      [
        col('id', 'int', 'PRI'),
        col('customer', 'varchar(120)', 'MUL', 'Who bought'),
        col('total', 'decimal(10,2)'),
        col('order', 'int'),
      ],
      false,
      'Every sale',
    ),
    table('customers', [
      col('id', 'int', 'PRI'),
      col('name', 'varchar(120)'),
      col('email', 'varchar(200)'),
    ]),
    table('open_orders', [col('id')], true),
    table('order items', [col('qty')]),
  ],
  foreignKeys: [
    {
      table: 'orders',
      column: 'customer',
      refSchema: 'shop',
      refTable: 'customers',
      refColumn: 'name',
    },
  ],
}
const ANALYTICS: SchemaDetail = {
  database: 'analytics',
  tables: [table('events', [col('id'), col('kind', 'varchar(20)')])],
  foreignKeys: [],
}

function loader(
  overrides: Partial<SchemaLoader> = {},
): SchemaLoader & { detail: ReturnType<typeof vi.fn>; columns: ReturnType<typeof vi.fn> } {
  const details: Record<string, SchemaDetail> = { shop: SHOP, analytics: ANALYTICS }
  return {
    // The list of tables carries names only; the columns come per table.
    detail: vi.fn((_c: string, d: string) =>
      details[d]
        ? Promise.resolve({
            database: d,
            tables: details[d]!.tables.map((t) => ({ ...t, comment: '', columns: [] })),
            foreignKeys: [],
          })
        : Promise.reject(new Error('no such database')),
    ),
    columns: vi.fn((_c: string, d: string, names: string[]) => {
      const wanted = new Set(names.map((n) => n.toLowerCase()))
      const detail = details[d]
      const tables = (detail?.tables ?? []).filter((t) => wanted.has(t.name.toLowerCase()))
      return Promise.resolve({
        tables,
        foreignKeys: (detail?.foreignKeys ?? []).filter((k) =>
          tables.some((t) => t.name === k.table),
        ),
      })
    }),
    databases: vi.fn(() => Promise.resolve(['analytics', 'information_schema', 'shop'])),
    ...overrides,
  } as never
}

async function complete(
  script: string,
  options: {
    database?: string | null
    cache?: SchemaCache
    explicit?: boolean
    full?: boolean
  } = {},
): Promise<CompletionResult | null> {
  const cache = options.cache ?? new SchemaCache(loader())
  const source = sqlCompletionSource({
    connectionId: 'c1',
    database: () => (options.database === undefined ? 'shop' : options.database),
    cache,
    fullPaths: () => options.full ?? false,
  })
  const pos = script.indexOf('|')
  const state = EditorState.create({ doc: script.replace('|', '') })
  return (await source(
    new CompletionContext(state, pos, options.explicit ?? false),
  )) as CompletionResult | null
}

const labels = (r: CompletionResult | null): string[] => (r ? r.options.map((o) => o.label) : [])
const find = (r: CompletionResult | null, label: string): Completion =>
  r!.options.find((o) => o.label === label)!

describe('table names', () => {
  it('offers the tables and views of the current database, and the databases', async () => {
    const r = await complete('SELECT * FROM |')
    expect(labels(r)).toEqual(
      expect.arrayContaining([
        'orders',
        'customers',
        'open_orders',
        'order items',
        'shop',
        'analytics',
      ]),
    )
    expect(find(r, 'orders')).toMatchObject({ type: 'class', detail: 'table' })
    expect(find(r, 'open_orders')).toMatchObject({ type: 'interface', detail: 'view' })
    expect(find(r, 'shop')).toMatchObject({ type: 'namespace', detail: 'database' })
  })

  it('starts where the typed name starts, so a choice replaces it', async () => {
    const r = await complete('SELECT * FROM ord|')
    expect(r!.from).toBe(14)
  })

  it('quotes a table whose name needs it', async () => {
    const r = await complete('SELECT * FROM |')
    expect(find(r, 'order items').apply).toBe('`order items`')
    expect(find(r, 'orders').apply).toBe('orders')
  })

  it('offers the tables of the database typed before the dot, reading it on the way', async () => {
    const l = loader()
    const r = await complete('SELECT * FROM analytics.|', { cache: new SchemaCache(l) })
    expect(labels(r)).toEqual(['events'])
    expect(find(r, 'events').detail).toBe('analytics')
    expect(l.detail).toHaveBeenCalledWith('c1', 'analytics')
  })

  it('knows no tables for a script with no database, but still offers databases', async () => {
    const r = await complete('SELECT * FROM |', { database: null })
    expect(labels(r)).toEqual(['analytics', 'information_schema', 'shop'])
  })

  it('follows a USE typed in the script', async () => {
    const r = await complete('USE analytics;\nSELECT * FROM |', { database: 'shop' })
    expect(labels(r)).toEqual(expect.arrayContaining(['events']))
    expect(labels(r)).not.toContain('orders')
  })

  it('offers databases after USE, with the system ones ranked last', async () => {
    const r = await complete('USE |', { explicit: true })
    expect(labels(r)).toEqual(['analytics', 'information_schema', 'shop'])
    expect(find(r, 'information_schema').boost).toBeLessThan(find(r, 'shop').boost!)
  })
})

describe('column names', () => {
  it('offers the columns of the table being read, with their types and comments, keys first', async () => {
    const r = await complete('SELECT | FROM orders', { explicit: true })
    expect(labels(r)).toEqual(expect.arrayContaining(['id', 'customer', 'total']))
    expect(find(r, 'customer')).toMatchObject({
      type: 'property',
      detail: 'varchar(120)',
      info: 'Who bought',
    })
    expect(find(r, 'id').boost!).toBeGreaterThan(find(r, 'total').boost!)
    expect(find(r, 'customer').boost!).toBeGreaterThan(find(r, 'total').boost!)
  })

  it('quotes a column named like a keyword', async () => {
    const r = await complete('SELECT | FROM orders', { explicit: true })
    expect(find(r, 'order').apply).toBe('`order`')
  })

  it('offers only the columns of the alias before the dot', async () => {
    const r = await complete('SELECT c.| FROM orders o JOIN customers c ON o.customer = c.name')
    expect(labels(r)).toEqual(['id', 'name', 'email'])
    expect(r!.from).toBe(9)
  })

  it('takes a table name as a qualifier too, and a database-qualified one', async () => {
    expect(labels(await complete('SELECT orders.| FROM orders'))).toContain('total')
    expect(labels(await complete('SELECT analytics.events.| FROM analytics.events'))).toEqual([
      'id',
      'kind',
    ])
  })

  it('says which table a column is from when several are read', async () => {
    const r = await complete('SELECT | FROM orders o JOIN customers c ON 1=1', { explicit: true })
    expect(find(r, 'name').detail).toBe('varchar(120) · c')
    expect(find(r, 'total').detail).toBe('decimal(10,2) · o')
    // And offers the aliases themselves, which go on to their columns.
    expect(find(r, 'o')).toMatchObject({ type: 'variable', detail: 'orders' })
  })

  it('suggests the join a foreign key makes, after ON', async () => {
    const r = await complete('SELECT * FROM orders o JOIN customers c ON |', { explicit: true })
    expect(labels(r)).toContain('o.customer = c.name')
    expect(find(r, 'o.customer = c.name').detail).toBe('foreign key')
    const reversed = await complete('SELECT * FROM customers c JOIN orders o ON |', {
      explicit: true,
    })
    expect(labels(reversed)).toContain('o.customer = c.name')
  })

  it('offers the columns of the table being inserted into', async () => {
    const r = await complete('INSERT INTO customers (id, |', { explicit: true })
    expect(labels(r)).toEqual(['id', 'name', 'email'])
  })

  it('reads only the columns of the tables a statement names', async () => {
    const l = loader()
    await complete('SELECT to| FROM orders', { cache: new SchemaCache(l) })
    expect(l.columns).toHaveBeenCalledTimes(1)
    expect(l.columns).toHaveBeenCalledWith('c1', 'shop', ['orders'])
  })

  it('asks for a table by the name it really has, however it was typed', async () => {
    const l = loader()
    const r = await complete('SELECT to| FROM ORDERS', { cache: new SchemaCache(l) })
    expect(l.columns).toHaveBeenCalledWith('c1', 'shop', ['orders'])
    expect(labels(r)).toContain('total')
  })

  it('reads a table once, however many statements need it', async () => {
    const l = loader()
    const cache = new SchemaCache(l)
    await complete('SELECT to| FROM orders', { cache })
    await complete('SELECT cu| FROM orders', { cache })
    expect(l.columns).toHaveBeenCalledTimes(1)
  })

  it('has no columns before a statement names a table', async () => {
    expect(await complete('SELECT na|')).toBeNull()
  })

  it('waits for an explicit request before listing every column at an empty spot', async () => {
    expect(await complete('SELECT | FROM orders WHERE |')).toBeNull()
    expect(labels(await complete('SELECT * FROM orders WHERE |', { explicit: true }))).toContain(
      'total',
    )
  })

  it('finds the columns of a table that is read after the cursor', async () => {
    const r = await complete('SELECT to| FROM orders')
    expect(labels(r)).toContain('total')
  })
})

describe('where it says nothing', () => {
  it('has no names inside a string or a comment, or at the start of a statement', async () => {
    expect(await complete("SELECT * FROM orders WHERE note = 'ord|'")).toBeNull()
    expect(await complete('SELECT 1 -- ord|')).toBeNull()
    expect(await complete('sel|')).toBeNull()
  })

  it('has nothing for a database it cannot read, and tries again next time', async () => {
    let calls = 0
    const flaky = loader({
      detail: vi.fn(() =>
        ++calls === 1 ? Promise.reject(new Error('down')) : Promise.resolve(SHOP),
      ),
    })
    const cache = new SchemaCache(flaky)
    expect(await complete('SELECT * FROM |', { cache, explicit: true })).not.toBeNull() // databases still come
    expect(labels(await complete('SELECT * FROM |', { cache }))).toContain('orders')
  })

  it('says why, once, when the schema cannot be read', async () => {
    const failures: string[] = []
    const broken = new SchemaCache(
      loader({
        detail: vi.fn(() => Promise.reject(new Error('Table is busy'))),
        databases: vi.fn(() => Promise.reject(new Error('Access denied'))),
      }),
      (_connection, what, error) => failures.push(`${what}: ${(error as Error).message}`),
    )
    expect(await complete('SELECT * FROM |', { cache: broken, explicit: true })).toBeNull()
    expect(failures).toEqual(['the tables of shop: Table is busy', 'the databases: Access denied'])
  })

  it('has nothing for a database that does not exist', async () => {
    expect(await complete('SELECT * FROM nosuch.|')).toBeNull()
  })
})

describe('SchemaCache', () => {
  it('reads a database once, however many ask', async () => {
    const l = loader()
    const cache = new SchemaCache(l)
    await Promise.all([
      cache.detail('c1', 'shop'),
      cache.detail('c1', 'shop'),
      cache.detail('c1', 'shop'),
    ])
    expect(l.detail).toHaveBeenCalledTimes(1)
    expect(cache.peek('c1', 'shop')!.tables.map((t) => t.name)).toEqual(
      SHOP.tables.map((t) => t.name),
    )
    expect(cache.peek('c1', 'analytics')).toBeUndefined()
  })

  it('keeps each connection apart, and reads again after invalidate', async () => {
    const l = loader()
    const cache = new SchemaCache(l)
    await cache.detail('c1', 'shop')
    await cache.detail('c2', 'shop')
    expect(l.detail).toHaveBeenCalledTimes(2)
    cache.invalidate('c1', 'shop')
    expect(cache.peek('c1', 'shop')).toBeUndefined()
    expect(cache.peek('c2', 'shop')).toBeDefined()
    await cache.detail('c1', 'shop')
    expect(l.detail).toHaveBeenCalledTimes(3)
    cache.invalidate('c2')
    expect(cache.peek('c2', 'shop')).toBeUndefined()
    cache.clear()
    expect(cache.peekDatabases('c1')).toBeUndefined()
  })

  it('does not keep a failed read', async () => {
    const l = loader({
      databases: vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(['shop']),
    })
    const cache = new SchemaCache(l)
    expect(await cache.databases('c1')).toBeNull()
    expect(await cache.databases('c1')).toEqual(['shop'])
    expect(await cache.databases('c1')).toEqual(['shop'])
    expect(l.databases).toHaveBeenCalledTimes(2)
  })
})

describe('SchemaCache columns and status', () => {
  it('reads the missing tables in one call, and not again', async () => {
    const l = loader()
    const cache = new SchemaCache(l)
    await cache.detail('c1', 'shop')
    await Promise.all([
      cache.columns('c1', 'shop', ['orders', 'customers']),
      cache.columns('c1', 'shop', ['orders']),
    ])
    expect(l.columns).toHaveBeenCalledTimes(1)
    expect(cache.peekTable('c1', 'shop', 'ORDERS')!.columns.map((c) => c.name)).toContain('total')
    expect(cache.peekForeignKeys('c1', 'shop', 'orders')).toHaveLength(1)
    await cache.columns('c1', 'shop', ['orders', 'open_orders'])
    expect(l.columns).toHaveBeenCalledTimes(2)
    expect(l.columns).toHaveBeenLastCalledWith('c1', 'shop', ['open_orders'])
  })

  it('does not ask again for a table the server does not have', async () => {
    const l = loader()
    const cache = new SchemaCache(l)
    await cache.columns('c1', 'shop', ['ghost'])
    await cache.columns('c1', 'shop', ['ghost'])
    expect(l.columns).toHaveBeenCalledTimes(1)
    expect(cache.peekTable('c1', 'shop', 'ghost')).toBeUndefined()
  })

  it('says how far it has got, and tells those who are watching', async () => {
    let release: (v: { tables: SchemaTable[]; foreignKeys: [] }) => void = () => undefined
    const l = loader({
      columns: vi.fn(
        () => new Promise<TableColumns>((resolve) => (release = resolve as typeof release)),
      ),
    })
    const cache = new SchemaCache(l)
    const seen: string[] = []
    cache.subscribe(() => {
      const s = cache.status('c1', 'shop')
      seen.push(`${s.state}:${s.tables}:${s.reading}:${s.withColumns}`)
    })
    expect(cache.status('c1', 'shop').state).toBe('idle')
    const list = cache.detail('c1', 'shop')
    expect(cache.status('c1', 'shop')).toMatchObject({ state: 'loading' })
    await list
    expect(cache.status('c1', 'shop')).toMatchObject({ state: 'ready', tables: 4, reading: 0 })
    const reading = cache.columns('c1', 'shop', ['orders'])
    expect(cache.status('c1', 'shop')).toMatchObject({ reading: 1 })
    release({ tables: [SHOP.tables[0]!], foreignKeys: [] })
    await reading
    expect(cache.status('c1', 'shop')).toMatchObject({ state: 'ready', reading: 0, withColumns: 1 })
    expect(seen).toEqual(['loading:0:0:0', 'ready:4:0:0', 'ready:4:1:0', 'ready:4:0:1'])
  })

  it('reports a failure with its reason, and a new read after invalidate clears it', async () => {
    const l = loader({
      detail: vi.fn().mockRejectedValueOnce(new Error('Access denied')).mockResolvedValue(SHOP),
    })
    const cache = new SchemaCache(l, () => undefined)
    expect(await cache.detail('c1', 'shop')).toBeNull()
    expect(cache.status('c1', 'shop')).toMatchObject({ state: 'failed', error: 'Access denied' })
    expect(await cache.detail('c1', 'shop')).not.toBeNull()
    expect(cache.status('c1', 'shop').state).toBe('ready')
    cache.invalidate('c1', 'shop')
    expect(cache.status('c1', 'shop').state).toBe('idle')
  })

  it('forgets columns with the rest when a connection is invalidated', async () => {
    const l = loader()
    const cache = new SchemaCache(l)
    await cache.detail('c1', 'shop')
    await cache.columns('c1', 'shop', ['orders'])
    cache.invalidate('c1')
    expect(cache.peekTable('c1', 'shop', 'orders')).toBeUndefined()
    await cache.columns('c1', 'shop', ['orders'])
    expect(l.columns).toHaveBeenCalledTimes(2)
  })
})

/** The script after choosing `label` at the `|`, with names written in full, and where the cursor ends. */
async function choose(script: string, label: string): Promise<string> {
  const r = await complete(script, { full: true, explicit: true })
  const option = find(r, label)
  const pos = script.indexOf('|')
  let state = EditorState.create({ doc: script.replace('|', '') })
  const view = {
    get state() {
      return state
    },
    dispatch: (spec: Parameters<EditorState['update']>[0]) => {
      state = state.update(spec).state
    },
  }
  if (typeof option.apply !== 'function') throw new Error('expected a function apply')
  option.apply(view as never, option, r!.from, pos)
  const at = state.selection.main.head
  const text = state.doc.toString()
  return text.slice(0, at) + '|' + text.slice(at)
}

describe('names in full', () => {
  it('writes the database, the table and an alias for a table after FROM', async () => {
    expect(await choose('SELECT * FROM ord|', 'orders')).toBe('SELECT * FROM `shop`.`orders` o|')
  })

  it('replaces a typed `db.` and an opening backtick', async () => {
    expect(await choose('SELECT * FROM shop.cust|', 'customers')).toBe(
      'SELECT * FROM `shop`.`customers` c|',
    )
    expect(await choose('SELECT * FROM `shop`.`cu|`', 'customers')).toBe(
      'SELECT * FROM `shop`.`customers` c|',
    )
  })

  it('does not add an alias when one follows, or where none is allowed', async () => {
    expect(await choose('SELECT * FROM ord| o', 'orders')).toBe('SELECT * FROM `shop`.`orders`| o')
    expect(await choose('INSERT INTO ord|', 'orders')).toBe('INSERT INTO `shop`.`orders`|')
  })

  it('avoids an alias that is already taken', async () => {
    expect(await choose('SELECT * FROM orders o JOIN ord|', 'open_orders')).not.toContain(
      'open_orders` o|',
    )
  })

  it('writes `alias`.`column` for a column typed on its own', async () => {
    expect(await choose('SELECT * FROM shop.orders o WHERE tot|', 'total')).toBe(
      'SELECT * FROM shop.orders o WHERE `o`.`total`|',
    )
    // A table with no alias gets one, so the statement reads `o`.`total`.
    expect(await choose('SELECT * FROM shop.orders WHERE tot|', 'total')).toBe(
      'SELECT * FROM shop.orders o WHERE `o`.`total`|',
    )
    expect(await choose('DELETE FROM shop.orders WHERE tot|', 'total')).toBe(
      'DELETE FROM shop.orders WHERE `orders`.`total`|',
    )
  })

  it('writes only the column after a typed qualifier', async () => {
    expect(await choose('SELECT * FROM shop.orders o WHERE o.tot|', 'total')).toBe(
      'SELECT * FROM shop.orders o WHERE o.`total`|',
    )
  })

  it('writes the columns of an INSERT without a qualifier', async () => {
    expect(await choose('INSERT INTO shop.orders (tot|', 'total')).toBe(
      'INSERT INTO shop.orders (`total`|',
    )
  })

  it('writes a foreign-key join condition quoted', async () => {
    const r = await choose(
      'SELECT * FROM shop.orders o JOIN shop.customers c ON |',
      'o.customer = c.name',
    )
    expect(r).toBe(
      'SELECT * FROM shop.orders o JOIN shop.customers c ON `o`.`customer` = `c`.`name`|',
    )
  })

  it('leaves names bare when the setting is off', async () => {
    const r = await complete('SELECT * FROM ord|')
    expect(find(r, 'orders').apply).toBe('orders')
  })
})
