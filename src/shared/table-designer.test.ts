import { describe, expect, it } from 'vitest'
import type { TableColumn } from './edit'
import {
  buildDesignerStatements,
  draftFrom,
  isChanged,
  newColumn,
  problemWith,
} from './table-designer'

const col = (
  name: string,
  columnType: string,
  nullable = true,
  extra: Partial<TableColumn> = {},
): TableColumn => ({
  name,
  type: columnType.split('(')[0]!,
  columnType,
  nullable,
  autoIncrement: false,
  generated: false,
  ...extra,
})
const columns = [
  col('id', 'int', false, { autoIncrement: true }),
  col('name', 'varchar(50)'),
  col('total', 'decimal(10,2)', false),
]

describe('table designer', () => {
  it('starts unchanged, and knows what the columns are', () => {
    const draft = draftFrom(columns, ['id'])
    expect(isChanged(draft)).toBe(false)
    expect(draft[0]!.note).toBe('primary key, auto')
    expect(buildDesignerStatements('mysql', 'shop', 'orders', draft)).toEqual([])
  })

  it('writes MySQL statements: change, rename with CHANGE, add, drop — in an order that runs', () => {
    const draft = draftFrom(columns, ['id'])
    draft[1]!.type = 'varchar(120)'
    draft[2]!.name = 'amount'
    draft[2]!.nullable = true
    draft.push({ ...newColumn(1), name: 'note', type: 'text' })
    draft[0]!.removed = true
    expect(isChanged(draft)).toBe(true)
    expect(buildDesignerStatements('mysql', 'shop', 'orders', draft)).toEqual([
      'ALTER TABLE `shop`.`orders` MODIFY COLUMN `name` varchar(120) NULL;',
      'ALTER TABLE `shop`.`orders` CHANGE COLUMN `total` `amount` decimal(10,2) NULL;',
      'ALTER TABLE `shop`.`orders` ADD COLUMN `note` text NULL;',
      'ALTER TABLE `shop`.`orders` DROP COLUMN `id`;',
    ])
  })

  it('writes PostgreSQL and SQL Server renames and changes in their own words', () => {
    const draft = draftFrom(columns, ['id'])
    draft[2]!.name = 'amount'
    draft[2]!.type = 'numeric(12,2)'
    expect(buildDesignerStatements('postgresql', 'public', 'orders', draft)).toEqual([
      'ALTER TABLE "public"."orders" RENAME COLUMN "total" TO "amount";',
      'ALTER TABLE "public"."orders" ALTER COLUMN "amount" TYPE numeric(12,2);',
    ])
    expect(buildDesignerStatements('mssql', 'dbo', 'orders', draft)).toEqual([
      "EXEC sp_rename N'dbo.orders.total', N'amount', N'COLUMN';",
      'ALTER TABLE [dbo].[orders] ALTER COLUMN [amount] numeric(12,2) NOT NULL;',
    ])
  })

  it('says what is wrong with a draft', () => {
    const draft = draftFrom(columns, ['id'])
    expect(problemWith(draft)).toBeNull()
    draft.push(newColumn(1))
    expect(problemWith(draft)).toMatch(/needs a name/)
    draft[3]!.name = 'NAME'
    draft[3]!.type = 'int'
    expect(problemWith(draft)).toMatch(/Two columns/)
    draft[3]!.removed = true
    expect(problemWith(draft)).toBeNull()
    const everything = draftFrom(columns, []).map((c) => ({ ...c, removed: true }))
    expect(problemWith(everything)).toMatch(/at least one/)
  })
})
