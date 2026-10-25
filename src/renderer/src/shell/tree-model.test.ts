import { describe, expect, it } from 'vitest'
import type { ConnectionSummary } from '@shared/connection'
import type { TreeNode } from '@shared/driver'
import type { Branch } from '@/state/tree'
import { flattenTree, matchesFilter } from './tree-model'

const conn = (id: string, name = id): ConnectionSummary => ({
  id,
  name,
  engine: 'mysql',
  environment: 'dev',
  host: 'h',
  port: 3306,
})

const node = (id: string, hasChildren = true): TreeNode => ({
  id,
  label: id,
  kind: 'table',
  hasChildren,
})

const loaded = (nodes: TreeNode[]): Branch => ({ status: 'loaded', nodes })

describe('flattenTree', () => {
  it('lists collapsed connections as single rows', () => {
    const rows = flattenTree([conn('a'), conn('b')], {}, {})
    expect(rows.map((r) => r.type)).toEqual(['connection', 'connection'])
  })

  it('shows a connecting row while the first load is in flight', () => {
    const rows = flattenTree([conn('a')], { a: true }, { a: { status: 'loading', nodes: [] } })
    expect(rows.map((r) => (r.type === 'status' ? r.text : r.type))).toEqual([
      'connection',
      'Connecting…',
    ])
  })

  it('shows the error and keeps the node so it can be retried', () => {
    const rows = flattenTree(
      [conn('a')],
      { a: true },
      { a: { status: 'error', nodes: [], error: 'Access denied' } },
    )
    expect(rows[1]).toMatchObject({
      type: 'status',
      error: true,
      text: 'Access denied',
      node: null,
    })
  })

  it('nests expanded nodes with increasing depth', () => {
    const shop = node('shop')
    const orders = node('orders')
    const rows = flattenTree(
      [conn('a')],
      { a: true, 'a|shop': true },
      {
        a: loaded([shop, node('billing')]),
        'a|shop': loaded([orders]),
      },
    )
    expect(rows.map((r) => [r.type, r.depth, r.type === 'node' ? r.node.id : ''])).toEqual([
      ['connection', 0, ''],
      ['node', 1, 'shop'],
      ['node', 2, 'orders'],
      ['node', 1, 'billing'],
    ])
  })

  it('does not expand a node that has no children, even if marked expanded', () => {
    const leaf = node('leaf', false)
    const rows = flattenTree([conn('a')], { a: true, 'a|leaf': true }, { a: loaded([leaf]) })
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ type: 'node', expanded: false })
  })

  it('says when a branch is empty', () => {
    const rows = flattenTree([conn('a')], { a: true }, { a: loaded([]) })
    expect(rows[1]).toMatchObject({ type: 'status', text: 'Nothing here.' })
  })

  it('keeps keys unique across connections that share node ids', () => {
    const rows = flattenTree(
      [conn('a'), conn('b')],
      { a: true, b: true },
      { a: loaded([node('x')]), b: loaded([node('x')]) },
    )
    const keys = rows.map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('filtering', () => {
  const labelled = (id: string, label: string, hasChildren = true): TreeNode => ({
    id,
    label,
    kind: 'table',
    hasChildren,
  })

  // shop → Tables → orders, customers; analytics → events
  const branches: Record<string, Branch> = {
    a: loaded([labelled('shop', 'shop'), labelled('analytics', 'analytics')]),
    'a|shop': loaded([labelled('tables', 'Tables')]),
    'a|tables': loaded([labelled('orders', 'orders'), labelled('customers', 'customers')]),
    'a|orders': loaded([labelled('id', 'id', false), labelled('total', 'total', false)]),
    'a|analytics': loaded([labelled('events', 'events', false)]),
  }
  const open = { a: true, 'a|shop': true, 'a|tables': true } as Record<string, true>
  const labels = (rows: ReturnType<typeof flattenTree>): string[] =>
    rows.map((r) =>
      r.type === 'connection' ? r.connection.name : r.type === 'node' ? r.node.label : r.text,
    )

  it('shows everything when the filter is empty or only spaces', () => {
    expect(flattenTree([conn('a')], open, branches, '')).toEqual(
      flattenTree([conn('a')], open, branches),
    )
    expect(flattenTree([conn('a')], open, branches, '   ')).toHaveLength(
      flattenTree([conn('a')], open, branches).length,
    )
  })

  it('keeps matches and the way to them, and drops the rest', () => {
    expect(labels(flattenTree([conn('a')], open, branches, 'cust'))).toEqual([
      'a',
      'shop',
      'Tables',
      'customers',
    ])
  })

  it('opens the way to a match that was inside something collapsed', () => {
    const rows = flattenTree([conn('a')], {}, branches, 'orders')
    expect(labels(rows)).toEqual(['a', 'shop', 'Tables', 'orders'])
    expect(rows.every((r) => r.type === 'status' || r.type === 'node' || r.expanded)).toBe(true)
  })

  it('shows what is under a match, once the match is opened', () => {
    expect(
      labels(flattenTree([conn('a')], { ...open, 'a|orders': true }, branches, 'orders')),
    ).toEqual(['a', 'shop', 'Tables', 'orders', 'id', 'total'])
    // Closed, a match is just itself.
    expect(labels(flattenTree([conn('a')], open, branches, 'orders'))).toEqual([
      'a',
      'shop',
      'Tables',
      'orders',
    ])
  })

  it('shows a whole connection, as far as it is open, when its own name matches', () => {
    const everything = labels(flattenTree([conn('a', 'Shop DB')], open, branches))
    expect(labels(flattenTree([conn('a', 'Shop DB')], open, branches, 'shop db'))).toEqual(
      everything,
    )
    expect(everything).toContain('analytics')
  })

  it('hides connections with nothing that matches', () => {
    const rows = flattenTree(
      [conn('a'), conn('b', 'billing')],
      open,
      { ...branches, b: loaded([]) },
      'events',
    )
    expect(labels(rows)).toEqual(['a', 'analytics', 'events'])
  })

  it('matches every word, in any order, ignoring case', () => {
    expect(matchesFilter('Order Items', 'items ORDER')).toBe(true)
    expect(matchesFilter('Order Items', 'items cart')).toBe(false)
    expect(matchesFilter('anything', '')).toBe(true)
  })

  it('does not report an empty branch as "Nothing here" while filtering', () => {
    const rows = flattenTree([conn('a', 'alpha')], { a: true }, { a: loaded([]) }, 'alpha')
    expect(labels(rows)).toEqual(['alpha'])
  })

  it('keeps unloaded parts out of the search, without breaking the rest', () => {
    const rows = flattenTree(
      [conn('a')],
      { a: true },
      { a: loaded([labelled('shop', 'shop')]) },
      'orders',
    )
    expect(rows).toEqual([])
  })
})
