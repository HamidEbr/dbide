import { describe, expect, it } from 'vitest'
import { layoutDiagram, MAX_COLUMNS_SHOWN, type DiagramTable } from './layout'

const t = (name: string, columns: string[] = ['id'], view = false): DiagramTable => ({
  name,
  view,
  columns: columns.map((c, i) => ({ name: c, type: 'int', key: i === 0 ? 'PRI' : '' })),
})
const link = (table: string, column: string, refTable: string, refColumn = 'id') => ({
  table,
  column,
  refTable,
  refColumn,
})

describe('layoutDiagram', () => {
  it('puts the table that is pointed at to the left of the ones that point at it', () => {
    const layout = layoutDiagram(
      [t('items', ['id', 'order_id']), t('orders', ['id', 'customer_id']), t('customers')],
      [link('items', 'order_id', 'orders'), link('orders', 'customer_id', 'customers')],
    )
    const at = (n: string) => layout.tables.find((p) => p.table.name === n)!
    expect(at('customers').x).toBeLessThan(at('orders').x)
    expect(at('orders').x).toBeLessThan(at('items').x)
    expect(layout.links).toHaveLength(2)
  })

  it('draws each line from the key’s own row to the row it points at, leaving the left side', () => {
    const layout = layoutDiagram(
      [t('orders', ['id', 'customer_id']), t('customers')],
      [link('orders', 'customer_id', 'customers')],
    )
    const [l] = layout.links
    const orders = layout.tables.find((p) => p.table.name === 'orders')!
    const customers = layout.tables.find((p) => p.table.name === 'customers')!
    expect(l!.from).toMatchObject({ side: 'left', x: orders.x })
    expect(l!.to).toMatchObject({ side: 'right', x: customers.x + customers.w })
    expect(l!.from.y).toBeGreaterThan(orders.y + 28)
  })

  it('keeps tables with no relations in a grid under the rest, and never overlaps boxes', () => {
    const layout = layoutDiagram(
      [t('a'), t('b', ['id', 'a_id']), ...Array.from({ length: 12 }, (_, i) => t(`loose${i}`))],
      [link('b', 'a_id', 'a')],
    )
    const related = layout.tables.filter((p) => ['a', 'b'].includes(p.table.name))
    const loose = layout.tables.filter((p) => p.table.name.startsWith('loose'))
    expect(Math.min(...loose.map((p) => p.y))).toBeGreaterThan(
      Math.max(...related.map((p) => p.y + p.h)) - 1,
    )
    for (const p of layout.tables) {
      for (const q of layout.tables) {
        if (p === q) continue
        const apart = p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y
        expect(apart).toBe(true)
      }
    }
    expect(layout.width).toBeGreaterThan(0)
  })

  it('survives a cycle and a table that points at itself', () => {
    const layout = layoutDiagram(
      [t('a', ['id', 'b_id', 'parent_id']), t('b', ['id', 'a_id'])],
      [link('a', 'b_id', 'b'), link('b', 'a_id', 'a'), link('a', 'parent_id', 'a')],
    )
    expect(layout.tables).toHaveLength(2)
    expect(layout.links.find((l) => l.self)).toBeTruthy()
  })

  it('leaves out links to tables that are not on the page, and cuts long tables to their keys first', () => {
    const wide = t('wide', ['id', ...Array.from({ length: 30 }, (_, i) => `c${i}`)])
    const layout = layoutDiagram([wide], [link('wide', 'c1', 'elsewhere')])
    expect(layout.links).toHaveLength(0)
    const [p] = layout.tables
    expect(p!.shown).toHaveLength(MAX_COLUMNS_SHOWN)
    expect(p!.hidden).toBe(31 - MAX_COLUMNS_SHOWN)
    expect(p!.shown[0]!.name).toBe('id')
  })

  it('draws only names when columns are off', () => {
    const [p] = layoutDiagram([t('a', ['id', 'x'])], [], { showColumns: false }).tables
    expect(p!.shown).toHaveLength(0)
    expect(p!.h).toBeLessThan(50)
  })
})
