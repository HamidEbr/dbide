import { describe, expect, it } from 'vitest'
import type { ColumnInfo } from '@shared/driver'
import type { TableColumn, TableDescription } from '@shared/edit'
import { generateStatements } from './generate'

const meta = (name: string, type: string, extra: Partial<TableColumn> = {}): TableColumn => ({
  name,
  type,
  columnType: type,
  nullable: true,
  autoIncrement: false,
  generated: false,
  ...extra,
})

const table: TableDescription = {
  schema: 'shop',
  table: 'orders',
  primaryKey: ['id'],
  columns: [
    meta('id', 'int', { autoIncrement: true, nullable: false }),
    meta('customer', 'varchar'),
    meta('total', 'decimal'),
    meta('total_cents', 'int', { generated: true }),
    meta('note', 'text'),
  ],
}

const col = (name: string, type: string, alias = name): ColumnInfo => ({
  name: alias,
  type,
  source: { schema: 'shop', table: 'orders', column: name },
})

const columns = [
  col('id', 'int'),
  col('customer', 'varchar'),
  col('total', 'decimal'),
  col('total_cents', 'int'),
  col('note', 'text'),
]

const rows = [
  [1, "O'Brien", '12.50', 1250, null],
  [2, 'Ada', '0.99', 99, 'line\nbreak'],
]

describe('generateStatements', () => {
  it('writes an UPDATE per row that sets the selected columns, addressed by primary key', () => {
    const result = generateStatements('update', table, columns, rows, [1, 2])
    expect(result).toEqual({
      ok: true,
      statements: [
        "UPDATE `shop`.`orders` SET `customer` = 'O''Brien', `total` = 12.50 WHERE `id` = 1;",
        "UPDATE `shop`.`orders` SET `customer` = 'Ada', `total` = 0.99 WHERE `id` = 2;",
      ],
    })
  })

  it('sets every writable column when only key columns are selected, leaving out computed ones', () => {
    const result = generateStatements('update', table, columns, [rows[0]!], [0])
    expect(result).toEqual({
      ok: true,
      statements: [
        "UPDATE `shop`.`orders` SET `customer` = 'O''Brien', `total` = 12.50, `note` = NULL WHERE `id` = 1;",
      ],
    })
  })

  it('never sets a computed column, even if it is selected', () => {
    const result = generateStatements('update', table, columns, [rows[0]!], [3, 4])
    expect(result).toMatchObject({
      ok: true,
      statements: ['UPDATE `shop`.`orders` SET `note` = NULL WHERE `id` = 1;'],
    })
  })

  it('writes a DELETE per row, whatever the selection', () => {
    expect(generateStatements('delete', table, columns, rows, [1])).toEqual({
      ok: true,
      statements: [
        'DELETE FROM `shop`.`orders` WHERE `id` = 1;',
        'DELETE FROM `shop`.`orders` WHERE `id` = 2;',
      ],
    })
  })

  it('uses the real column names when the query renamed them', () => {
    const aliased = [col('id', 'int', 'order_id'), col('customer', 'varchar', 'who')]
    const result = generateStatements('update', table, aliased, [[7, 'Eve']], [1])
    expect(result).toMatchObject({
      statements: ["UPDATE `shop`.`orders` SET `customer` = 'Eve' WHERE `id` = 7;"],
    })
  })

  it('handles a key made of several columns', () => {
    const pair: TableDescription = {
      schema: 's',
      table: 'links',
      primaryKey: ['a', 'b'],
      columns: [meta('a', 'int'), meta('b', 'varchar'), meta('weight', 'int')],
    }
    const cols: ColumnInfo[] = ['a', 'b', 'weight'].map((name, i) => ({
      name,
      type: ['int', 'varchar', 'int'][i]!,
      source: { schema: 's', table: 'links', column: name },
    }))
    expect(generateStatements('delete', pair, cols, [[1, 'x', 5]], [])).toEqual({
      ok: true,
      statements: ["DELETE FROM `s`.`links` WHERE `a` = 1 AND `b` = 'x';"],
    })
  })

  it('treats a value the server will choose (a new row’s default) as NULL', () => {
    const result = generateStatements(
      'update',
      table,
      columns,
      [[3, undefined, undefined, undefined, undefined]],
      [1],
    )
    expect(result).toMatchObject({
      statements: ['UPDATE `shop`.`orders` SET `customer` = NULL WHERE `id` = 3;'],
    })
  })

  it('says why it can not, rather than writing a statement that would touch the wrong rows', () => {
    expect(
      generateStatements('delete', { ...table, primaryKey: [] }, columns, rows, []),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining('no primary key'),
    })
    expect(generateStatements('delete', table, columns.slice(1), [['x']], [])).toMatchObject({
      ok: false,
      message: expect.stringContaining('“id”'),
    })
    expect(generateStatements('delete', table, columns, [], [])).toMatchObject({ ok: false })
    const onlyKey: TableDescription = { ...table, columns: [meta('id', 'int')] }
    expect(generateStatements('update', onlyKey, [columns[0]!], [[1]], [0])).toMatchObject({
      ok: false,
      message: expect.stringContaining('only its key'),
    })
  })
})
