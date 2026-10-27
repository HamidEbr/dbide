import { CompletionContext, type Completion, type CompletionResult } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it, vi } from 'vitest'
import type { SchemaColumn, SchemaDetail, SchemaTable } from '@shared/driver'
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
): SchemaLoader & { detail: ReturnType<typeof vi.fn> } {
  const details: Record<string, SchemaDetail> = { shop: SHOP, analytics: ANALYTICS }
  return {
    detail: vi.fn((_c: string, d: string) =>
      details[d] ? Promise.resolve(details[d]!) : Promise.reject(new Error('no such database')),
    ),
    databases: vi.fn(() => Promise.resolve(['analytics', 'information_schema', 'shop'])),
    ...overrides,
  } as never
}

async function complete(
  script: string,
  options: { database?: string | null; cache?: SchemaCache; explicit?: boolean } = {},
): Promise<CompletionResult | null> {
  const cache = options.cache ?? new SchemaCache(loader())
  const source = sqlCompletionSource({
    connectionId: 'c1',
    database: () => (options.database === undefined ? 'shop' : options.database),
    cache,
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
    expect(find(r, 'orders')).toMatchObject({ type: 'class', detail: 'table', info: 'Every sale' })
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

  it('offers the columns of the whole database before FROM is typed, named by table', async () => {
    const r = await complete('SELECT na|')
    expect(find(r, 'name')).toMatchObject({ detail: 'varchar(120) · customers' })
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
    expect(cache.peek('c1', 'shop')).toBe(SHOP)
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
    expect(cache.peek('c2', 'shop')).toBe(SHOP)
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
