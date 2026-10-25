import { describe, expect, it } from 'vitest'
import type { TreeNode } from '@shared/driver'
import {
  formatBytes,
  formatCount,
  isSystemSchema,
  nodeId,
  treeChildren,
  type MetaQuery,
} from './tree'

/** Answers each query by matching a fragment of its SQL, and records what was asked. */
function fakeQuery(answers: [fragment: string, rows: unknown[][]][]): {
  query: MetaQuery
  calls: { sql: string; values: unknown[] | undefined }[]
} {
  const calls: { sql: string; values: unknown[] | undefined }[] = []
  const query: MetaQuery = (sql, values) => {
    calls.push({ sql, values })
    const match = answers.find(([fragment]) => sql.includes(fragment))
    return Promise.resolve(match ? match[1] : [])
  }
  return { query, calls }
}

const node = (id: string, kind = 'group'): TreeNode => ({
  id,
  label: 'x',
  kind,
  hasChildren: true,
})

describe('formatting', () => {
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(300 * 1024 * 1024)).toBe('300 MB')
  })

  it('formats counts', () => {
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1500)).toBe('1.5K')
    expect(formatCount(25_000)).toBe('25K')
    expect(formatCount(2_300_000)).toBe('2.3M')
  })

  it('knows the system schemas', () => {
    expect(isSystemSchema('mysql')).toBe(true)
    expect(isSystemSchema('INFORMATION_SCHEMA')).toBe(true)
    expect(isSystemSchema('shop')).toBe(false)
  })
})

describe('treeChildren', () => {
  it('lists user schemas first and tucks system schemas into a group', async () => {
    const { query } = fakeQuery([
      ['SCHEMATA', [['information_schema'], ['mysql'], ['shop'], ['analytics'], ['sys']]],
    ])
    const roots = await treeChildren(query, null)
    expect(roots.map((n) => [n.label, n.kind])).toEqual([
      ['shop', 'database'],
      ['analytics', 'database'],
      ['System schemas', 'group'],
    ])
    expect(roots[0]).toMatchObject({ scope: 'shop', hasChildren: true })
    expect(roots[2]?.detail).toBe('3')
  })

  it('expands the system group to the system schemas', async () => {
    const { query } = fakeQuery([])
    const children = await treeChildren(query, node(nodeId('system')))
    expect(children.map((n) => n.label)).toEqual([
      'information_schema',
      'mysql',
      'performance_schema',
      'sys',
    ])
  })

  it('shows Tables always and other groups only when they have members', async () => {
    const { query, calls } = fakeQuery([['COUNT(*)', [[0, 2, 0, 1, 0]]]])
    const groups = await treeChildren(query, node(nodeId('database', 'shop'), 'database'))
    expect(groups.map((n) => [n.label, n.detail, n.hasChildren])).toEqual([
      ['Tables', '0', false],
      ['Views', '2', true],
      ['Triggers', '1', true],
    ])
    expect(calls[0]?.values).toEqual(['shop', 'shop', 'shop', 'shop', 'shop'])
  })

  it('lists tables with an estimate and size, using bound parameters', async () => {
    const { query, calls } = fakeQuery([
      [
        "TABLE_TYPE = 'BASE TABLE'",
        [
          ['orders', '12500', '4194304', '1048576'],
          ['empty', '0', '0', '0'],
          ['unknown', null, null, null],
        ],
      ],
    ])
    const tables = await treeChildren(query, node(nodeId('group', 'shop', 'tables')))
    expect(tables.map((n) => [n.label, n.detail])).toEqual([
      ['orders', '~13K rows · 5.0 MB'],
      ['empty', '~0 rows'],
      ['unknown', undefined],
    ])
    expect(tables[0]).toMatchObject({ kind: 'table', hasChildren: true, scope: 'shop' })
    expect(calls[0]?.values).toEqual(['shop'])
  })

  it('shows columns with keys and flags, then groups for indexes and foreign keys', async () => {
    const { query } = fakeQuery([
      [
        'information_schema.COLUMNS',
        [
          ['id', 'bigint unsigned', 'NO', 'PRI', 'auto_increment'],
          ['email', 'varchar(255)', 'NO', 'UNI', ''],
          ['note', 'text', 'YES', '', ''],
        ],
      ],
    ])
    const children = await treeChildren(query, node(nodeId('table', 'shop', 'users'), 'table'))
    expect(children.map((n) => [n.label, n.kind, n.detail])).toEqual([
      ['id', 'column', 'bigint unsigned · PK · not null · auto'],
      ['email', 'column', 'varchar(255) · unique · not null'],
      ['note', 'column', 'text'],
      ['Indexes', 'group', undefined],
      ['Foreign keys', 'group', undefined],
    ])
  })

  it('views show columns only', async () => {
    const { query } = fakeQuery([['information_schema.COLUMNS', [['a', 'int', 'YES', '', '']]]])
    const children = await treeChildren(query, node(nodeId('view', 'shop', 'v'), 'view'))
    expect(children.map((n) => n.kind)).toEqual(['column'])
  })

  it('describes indexes and groups foreign key columns by constraint', async () => {
    const { query } = fakeQuery([
      [
        'STATISTICS',
        [
          ['PRIMARY', 0, 'id'],
          ['by_user', 1, 'user_id, created_at'],
        ],
      ],
      [
        'KEY_COLUMN_USAGE',
        [
          ['fk_order_user', 'user_id', 'shop', 'users', 'id'],
          ['fk_line', 'order_id', 'shop', 'orders', 'id'],
          ['fk_line', 'shop_id', 'shop', 'orders', 'shop_id'],
          ['fk_other', 'x', 'billing', 'accounts', 'id'],
        ],
      ],
    ])
    const indexes = await treeChildren(query, node(nodeId('group', 'shop', 'indexes', 'orders')))
    expect(indexes.map((n) => [n.label, n.detail])).toEqual([
      ['PRIMARY', 'unique (id)'],
      ['by_user', '(user_id, created_at)'],
    ])

    const fks = await treeChildren(query, node(nodeId('group', 'shop', 'foreignKeys', 'orders')))
    expect(fks.map((n) => [n.label, n.detail])).toEqual([
      ['fk_order_user', 'user_id → users(id)'],
      ['fk_line', 'order_id, shop_id → orders(id, shop_id)'],
      ['fk_other', 'x → billing.accounts(id)'],
    ])
  })

  it('lists routines, triggers, and events as leaves', async () => {
    const { query } = fakeQuery([
      [
        'ROUTINES',
        [
          ['do_things', 'PROCEDURE'],
          ['total', 'FUNCTION'],
        ],
      ],
      ['TRIGGERS', [['trg_audit', 'AFTER', 'INSERT', 'orders']]],
      ['EVENTS', [['nightly', 'ENABLED']]],
    ])
    const routines = await treeChildren(query, node(nodeId('group', 'shop', 'routines')))
    expect(routines.map((n) => [n.label, n.kind, n.hasChildren])).toEqual([
      ['do_things', 'procedure', false],
      ['total', 'function', false],
    ])
    const triggers = await treeChildren(query, node(nodeId('group', 'shop', 'triggers')))
    expect(triggers[0]?.detail).toBe('after insert on orders')
    const events = await treeChildren(query, node(nodeId('group', 'shop', 'events')))
    expect(events[0]?.detail).toBe('enabled')
  })

  it('returns nothing for leaves and rejects ids it did not make', async () => {
    const { query } = fakeQuery([])
    expect(await treeChildren(query, node(nodeId('column', 'shop', 't', 'c'), 'column'))).toEqual(
      [],
    )
    await expect(treeChildren(query, node('not json'))).rejects.toThrow(/Unknown tree node/)
  })

  it('ids round-trip names with quotes and unusual characters', async () => {
    const { query, calls } = fakeQuery([])
    await treeChildren(query, node(nodeId('database', 'we"ird`name')))
    expect(calls[0]?.values).toEqual([
      'we"ird`name',
      'we"ird`name',
      'we"ird`name',
      'we"ird`name',
      'we"ird`name',
    ])
  })
})
