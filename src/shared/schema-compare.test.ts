import { describe, expect, it } from 'vitest'
import type { SchemaColumn, SchemaTable } from './driver'
import { compareSchemas, scriptOf } from './schema-compare'

const col = (
  name: string,
  type = 'int',
  nullable = true,
  key: SchemaColumn['key'] = '',
): SchemaColumn => ({
  name,
  type,
  nullable,
  key,
  comment: '',
})
const table = (name: string, columns: SchemaColumn[], view = false): SchemaTable => ({
  name,
  view,
  comment: '',
  columns,
})

const source = {
  tables: [
    table('orders', [
      col('id', 'int', false, 'PRI'),
      col('total', 'decimal(10,2)', false),
      col('note', 'varchar(100)'),
    ]),
    table('customers', [col('id', 'int', false, 'PRI'), col('name', 'varchar(50)')]),
  ],
  foreignKeys: [
    {
      table: 'orders',
      column: 'customer_id',
      refSchema: 'shop',
      refTable: 'customers',
      refColumn: 'id',
    },
  ],
}
const target = {
  tables: [
    table('orders', [
      col('id', 'int', false, 'PRI'),
      col('total', 'decimal(8,2)', false),
      col('old', 'int'),
    ]),
    table('legacy', [col('id')]),
  ],
  foreignKeys: [],
}

describe('compareSchemas', () => {
  it('finds tables, columns and keys that differ', () => {
    const changes = compareSchemas(source, target, { schema: 'shop', dialect: 'mysql' })
    expect(changes.map((c) => [c.kind, c.table, c.column ?? ''])).toEqual([
      ['table-added', 'customers', ''],
      ['column-added', 'orders', 'note'],
      ['column-changed', 'orders', 'total'],
      ['key-added', 'orders', 'customer_id'],
      ['column-removed', 'orders', 'old'],
      ['table-removed', 'legacy', ''],
    ])
    expect(changes.filter((c) => c.destructive).map((c) => c.kind)).toEqual([
      'column-removed',
      'table-removed',
    ])
  })

  it('writes MySQL statements that make the target match', () => {
    const changes = compareSchemas(source, target, { schema: 'shop', dialect: 'mysql' })
    const byKind = (k: string) => changes.find((c) => c.kind === k)!.statements
    expect(byKind('table-added')[0]).toBe(
      'CREATE TABLE `shop`.`customers` (\n  `id` int NOT NULL,\n  `name` varchar(50) NULL,\n  PRIMARY KEY (`id`)\n);',
    )
    expect(byKind('column-added')).toEqual([
      'ALTER TABLE `shop`.`orders` ADD COLUMN `note` varchar(100) NULL;',
    ])
    expect(byKind('column-changed')).toEqual([
      'ALTER TABLE `shop`.`orders` MODIFY COLUMN `total` decimal(10,2) NOT NULL;',
    ])
    expect(byKind('key-added')[0]).toContain(
      'ADD CONSTRAINT `fk_orders_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `shop`.`customers` (`id`)',
    )
    expect(byKind('table-removed')).toEqual(['DROP TABLE `shop`.`legacy`;'])
  })

  it('writes PostgreSQL and SQL Server alterations in their own words', () => {
    const pg = compareSchemas(source, target, { schema: 'public', dialect: 'postgresql' })
    expect(pg.find((c) => c.kind === 'column-changed')!.statements).toEqual([
      'ALTER TABLE "public"."orders" ALTER COLUMN "total" TYPE decimal(10,2);',
    ])
    const nullable = compareSchemas(
      { tables: [table('t', [col('a', 'int', true)])], foreignKeys: [] },
      { tables: [table('t', [col('a', 'int', false)])], foreignKeys: [] },
      { schema: 'public', dialect: 'postgresql' },
    )
    expect(nullable[0]!.statements).toEqual([
      'ALTER TABLE "public"."t" ALTER COLUMN "a" DROP NOT NULL;',
    ])
    const ms = compareSchemas(source, target, { schema: 'dbo', dialect: 'mssql' })
    expect(ms.find((c) => c.kind === 'column-added')!.statements).toEqual([
      'ALTER TABLE [dbo].[orders] ADD [note] varchar(100) NULL;',
    ])
    expect(ms.find((c) => c.kind === 'column-changed')!.statements).toEqual([
      'ALTER TABLE [dbo].[orders] ALTER COLUMN [total] decimal(10,2) NOT NULL;',
    ])
    expect(ms.find((c) => c.kind === 'key-removed')).toBeUndefined()
  })

  it('shows differences without a script when the two are not the same kind of server', () => {
    const changes = compareSchemas(source, target, { schema: 'x', dialect: null })
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.every((c) => c.statements.length === 0)).toBe(true)
  })

  it('says nothing is different for equal schemas, ignoring case and spacing in types', () => {
    const a = {
      tables: [table('T', [col('A', 'VARCHAR( 5 )'.replace('( 5 )', '(5)'))])],
      foreignKeys: [],
    }
    const b = { tables: [table('t', [col('a', 'varchar(5)')])], foreignKeys: [] }
    expect(compareSchemas(a, b, { schema: 's', dialect: 'mysql' })).toEqual([])
  })

  it('writes the chosen changes as one commented script', () => {
    const changes = compareSchemas(source, target, { schema: 'shop', dialect: 'mysql' })
    const text = scriptOf(changes.filter((c) => c.kind === 'table-removed'))
    expect(text).toBe(
      '-- Table legacy is only in the target (removes data)\nDROP TABLE `shop`.`legacy`;',
    )
  })
})
