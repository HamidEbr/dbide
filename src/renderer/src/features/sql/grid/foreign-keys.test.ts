import { describe, expect, it } from 'vitest'
import type { ColumnInfo } from '@shared/driver'
import type { TableColumn, TableDescription } from '@shared/edit'
import { buildLookup, describeLink, linksByColumn } from './foreign-keys'

const meta = (name: string): TableColumn => ({
  name,
  type: 'int',
  columnType: 'int',
  nullable: true,
  autoIncrement: false,
  generated: false,
})

const orders: TableDescription = {
  schema: 'shop',
  table: 'orders',
  primaryKey: ['id'],
  columns: ['id', 'customer_id', 'region', 'country'].map(meta),
  foreignKeys: [
    {
      name: 'fk_customer',
      columns: ['customer_id'],
      refSchema: 'shop',
      refTable: 'customers',
      refColumns: ['id'],
    },
    {
      name: 'fk_region',
      columns: ['country', 'region'],
      refSchema: 'geo',
      refTable: 'regions',
      refColumns: ['country', 'code'],
    },
  ],
  referencedBy: [
    {
      name: 'fk_item_order',
      schema: 'shop',
      table: 'order_items',
      columns: ['order_id'],
      refColumns: ['id'],
    },
  ],
}

const column = (name: string, type = 'int', table = 'orders'): ColumnInfo => ({
  name,
  type,
  source: { schema: 'shop', table, column: name },
})

const all = [column('id'), column('customer_id'), column('region', 'varchar'), column('country')]
const descriptions = new Map([['shop\u0000orders', orders]])

describe('linksByColumn', () => {
  it('hangs each link on the columns that hold its key', () => {
    const links = linksByColumn(all, descriptions)
    expect(links[0]!.map((l) => [l.direction, l.name])).toEqual([['referencedBy', 'fk_item_order']])
    expect(links[1]!.map((l) => [l.direction, l.name])).toEqual([['references', 'fk_customer']])
    // A key of two columns is offered from both.
    expect(links[2]!.map((l) => l.name)).toEqual(['fk_region'])
    expect(links[3]!.map((l) => l.name)).toEqual(['fk_region'])
    expect(links[2]![0]!.columnIndexes).toEqual([3, 2])
  })

  it('leaves out a key when one of its columns is not in the result', () => {
    const links = linksByColumn([column('id'), column('region', 'varchar')], descriptions)
    expect(links[1]).toEqual([])
    expect(links[0]).toHaveLength(1)
  })

  it('knows nothing about a table that has not been described, or a computed column', () => {
    expect(linksByColumn(all, new Map())).toEqual([[], [], [], []])
    expect(linksByColumn([{ name: '1', type: 'int' }], descriptions)).toEqual([[]])
  })

  it('matches the columns of a join to their own table', () => {
    const customers: TableDescription = {
      schema: 'shop',
      table: 'customers',
      primaryKey: ['id'],
      columns: [meta('id')],
      foreignKeys: [],
      referencedBy: [
        {
          name: 'fk_customer',
          schema: 'shop',
          table: 'orders',
          columns: ['customer_id'],
          refColumns: ['id'],
        },
      ],
    }
    const joined = [column('customer_id'), column('id', 'int', 'customers')]
    const links = linksByColumn(
      joined,
      new Map([
        ['shop\u0000orders', orders],
        ['shop\u0000customers', customers],
      ]),
    )
    expect(links[0]!.map((l) => l.name)).toEqual(['fk_customer'])
    expect(links[1]!.map((l) => [l.direction, l.targetTable])).toEqual([['referencedBy', 'orders']])
  })

  it('works for a table with no key information', () => {
    const bare: TableDescription = { schema: 'shop', table: 'orders', primaryKey: [], columns: [] }
    expect(linksByColumn(all, new Map([['shop\u0000orders', bare]]))).toEqual([[], [], [], []])
  })
})

describe('buildLookup', () => {
  const links = linksByColumn(all, descriptions)

  it('selects the rows a key points at', () => {
    expect(buildLookup(links[1]![0]!, all, [10, 42, 'EU', 'DE'])).toEqual({
      sql: 'SELECT * FROM `shop`.`customers` WHERE `id` = 42 LIMIT 1000;',
      title: 'customers',
      database: 'shop',
    })
  })

  it('finds the rows that point at this one, across the other table', () => {
    expect(buildLookup(links[0]![0]!, all, [10, 42, 'EU', 'DE'])?.sql).toBe(
      'SELECT * FROM `shop`.`order_items` WHERE `order_id` = 10 LIMIT 1000;',
    )
  })

  it('matches every column of a key, quoting text and escaping it', () => {
    expect(buildLookup(links[2]![0]!, all, [1, 1, "E'U", 'DE'])?.sql).toBe(
      "SELECT * FROM `geo`.`regions` WHERE `country` = 'DE' AND `code` = 'E''U' LIMIT 1000;",
    )
  })

  it('has nothing to follow from a NULL', () => {
    expect(buildLookup(links[1]![0]!, all, [10, null, 'EU', 'DE'])).toBeNull()
    expect(buildLookup(links[2]![0]!, all, [1, 1, 'EU', null])).toBeNull()
    expect(buildLookup(links[1]![0]!, all, [10, undefined])).toBeNull()
  })

  it('keeps big numbers exact', () => {
    const big = [column('id'), { ...column('customer_id'), type: 'bigint' }]
    const l = linksByColumn(big, descriptions)
    expect(buildLookup(l[1]![0]!, big, [1, '9007199254740993'])?.sql).toContain(
      '= 9007199254740993',
    )
  })
})

describe('describeLink', () => {
  it('says what it does', () => {
    const links = linksByColumn(all, descriptions)
    expect(describeLink(links[1]![0]!)).toBe('Go to customers.id')
    expect(describeLink(links[0]![0]!)).toBe('Find rows in order_items.order_id')
  })
})
