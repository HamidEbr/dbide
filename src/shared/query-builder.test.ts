import { describe, expect, it } from 'vitest'
import { aliasFor, buildSql, emptyBuilder, suggestJoin, type Builder } from './query-builder'

const orders = { alias: 'o', schema: 'shop', table: 'orders' }
const customers = { alias: 'c', schema: 'shop', table: 'customers' }
const keys = [
  {
    table: 'orders',
    column: 'customer_id',
    refSchema: 'shop',
    refTable: 'customers',
    refColumn: 'id',
  },
]

describe('suggestJoin and aliasFor', () => {
  it('joins on the foreign key, whichever table holds it', () => {
    expect(suggestJoin(customers, [orders], keys)).toEqual({
      type: 'INNER',
      on: [{ alias: 'c', column: 'id', otherAlias: 'o', otherColumn: 'customer_id' }],
    })
    expect(suggestJoin(orders, [customers], keys)!.on[0]).toEqual({
      alias: 'o',
      column: 'customer_id',
      otherAlias: 'c',
      otherColumn: 'id',
    })
    expect(
      suggestJoin({ alias: 'p', schema: 'shop', table: 'products' }, [orders], keys),
    ).toBeUndefined()
  })

  it('makes an alias from initials that is not taken', () => {
    expect(aliasFor('order_items', [])).toBe('oi')
    expect(aliasFor('orders', ['o'])).toBe('o2')
    expect(aliasFor('2fa_codes', [])).toBe('t2c')
  })
})

describe('buildSql', () => {
  const builder = (): Builder => ({
    ...emptyBuilder(),
    tables: [
      orders,
      {
        ...customers,
        join: {
          type: 'LEFT',
          on: [{ alias: 'c', column: 'id', otherAlias: 'o', otherColumn: 'customer_id' }],
        },
      },
    ],
    columns: [
      { alias: 'c', column: 'name' },
      { alias: 'o', column: 'total', aggregate: 'SUM', as: 'revenue' },
    ],
    filters: [
      { alias: 'o', column: 'status', operator: '=', value: "it's", kind: 'text', logic: 'AND' },
      { alias: 'o', column: 'total', operator: '>', value: '10', kind: 'number', logic: 'AND' },
      {
        alias: 'o',
        column: 'day',
        operator: 'BETWEEN',
        value: 'since,until',
        kind: 'parameter',
        logic: 'OR',
      },
    ],
    orderBy: [{ alias: 'o', column: 'total', direction: 'DESC' }],
    limit: 50,
  })

  it('writes the select, joins, filters, grouping, order and limit for MySQL', () => {
    expect(buildSql(builder(), 'mysql')).toBe(
      [
        'SELECT `c`.`name`,',
        '       SUM(`o`.`total`) AS `revenue`',
        'FROM `shop`.`orders` `o`',
        'LEFT JOIN `shop`.`customers` `c` ON `c`.`id` = `o`.`customer_id`',
        "WHERE `o`.`status` = 'it''s'",
        '  AND `o`.`total` > 10',
        '  OR `o`.`day` BETWEEN :since AND :until',
        'GROUP BY `c`.`name`',
        'ORDER BY `o`.`total` DESC',
        'LIMIT 50;',
      ].join('\n'),
    )
  })

  it('writes SQL Server’s TOP and PostgreSQL’s quotes', () => {
    expect(buildSql(builder(), 'mssql')!.split('\n')[0]).toBe('SELECT TOP (50) [c].[name],')
    expect(buildSql(builder(), 'mssql')).not.toContain('LIMIT')
    expect(buildSql(builder(), 'postgresql')).toContain('FROM "shop"."orders" "o"')
  })

  it('selects every column when none is picked, and is null with no table', () => {
    expect(buildSql(emptyBuilder(), 'mysql')).toBeNull()
    expect(buildSql({ ...emptyBuilder(), tables: [orders], limit: null }, 'mysql')).toBe(
      'SELECT *\nFROM `shop`.`orders` `o`;',
    )
    expect(
      buildSql({ ...emptyBuilder(), tables: [orders, customers], limit: null }, 'mysql')!.split(
        '\n',
      )[0],
    ).toBe('SELECT `o`.*')
  })

  it('writes IN lists and NULL tests', () => {
    const b: Builder = {
      ...emptyBuilder(),
      tables: [orders],
      limit: null,
      filters: [
        { alias: 'o', column: 'id', operator: 'IN', value: '1, 2,3', kind: 'number', logic: 'AND' },
        { alias: 'o', column: 'note', operator: 'IS NULL', value: '', kind: 'text', logic: 'AND' },
      ],
    }
    expect(buildSql(b, 'mysql')).toContain('WHERE `o`.`id` IN (1, 2, 3)\n  AND `o`.`note` IS NULL')
  })
})
