import { describe, expect, it } from 'vitest'
import type { ColumnInfo } from '@shared/driver'
import { buildEditStatements, type TableDescription } from '@shared/edit'
import {
  addInsert,
  columnTypes,
  countChanges,
  emptyChangeSet,
  isEmpty,
  removeInsert,
  setInsertValue,
  setUpdate,
  toEditBatch,
  toggleDeletes,
} from './change-set'

const col = (name: string, type: string, column = name): ColumnInfo => ({
  name,
  type,
  source: { schema: 'shop', table: 'items', column },
})

// The result lists the columns in a different order than the table, and renames one.
const columns = [col('label', 'varchar', 'name'), col('id', 'int'), col('price', 'decimal')]
const table: TableDescription = {
  schema: 'shop',
  table: 'items',
  primaryKey: ['id'],
  columns: [
    {
      name: 'id',
      type: 'int',
      columnType: 'int',
      nullable: false,
      autoIncrement: true,
      generated: false,
    },
    {
      name: 'name',
      type: 'varchar',
      columnType: 'varchar(50)',
      nullable: false,
      autoIncrement: false,
      generated: false,
    },
    {
      name: 'price',
      type: 'decimal',
      columnType: 'decimal(10,2)',
      nullable: true,
      autoIncrement: false,
      generated: false,
    },
  ],
}

describe('updates', () => {
  it('records a changed cell with the key the row was loaded with', () => {
    const set = setUpdate(emptyChangeSet(), 3, [7], 0, 'new', 'old', 'varchar')
    expect(set.updates).toEqual({ 3: { key: [7], values: { 0: 'new' } } })
    expect(countChanges(set)).toBe(1)
  })

  it('keeps the original key even if a later edit would suggest another', () => {
    let set = setUpdate(emptyChangeSet(), 0, [1], 1, 99, 1, 'int')
    set = setUpdate(set, 0, [99], 0, 'x', 'y', 'varchar')
    expect(set.updates[0]!.key).toEqual([1])
    expect(set.updates[0]!.values).toEqual({ 1: 99, 0: 'x' })
  })

  it('forgets a change that puts the original value back', () => {
    let set = setUpdate(emptyChangeSet(), 0, [1], 0, 'new', 'old', 'varchar')
    set = setUpdate(set, 0, [1], 0, 'old', 'old', 'varchar')
    expect(isEmpty(set)).toBe(true)
  })

  it('counts 1.50 typed over 1.5 as no change for a decimal column', () => {
    expect(isEmpty(setUpdate(emptyChangeSet(), 0, [1], 2, '1.50', '1.5', 'decimal'))).toBe(true)
  })

  it('does not mutate the set it was given', () => {
    const before = emptyChangeSet()
    setUpdate(before, 0, [1], 0, 'a', 'b', 'varchar')
    expect(before).toEqual(emptyChangeSet())
  })
})

describe('deletes', () => {
  it('marks rows and drops their pending edits', () => {
    let set = setUpdate(emptyChangeSet(), 2, [5], 0, 'x', 'y', 'varchar')
    set = toggleDeletes(set, [
      { row: 2, key: [5] },
      { row: 4, key: [9] },
    ])
    expect(set.deletes).toEqual({ 2: [5], 4: [9] })
    expect(set.updates).toEqual({})
  })

  it('unmarks when every selected row is already marked, and marks the rest otherwise', () => {
    const marked = toggleDeletes(emptyChangeSet(), [{ row: 1, key: [1] }])
    expect(toggleDeletes(marked, [{ row: 1, key: [1] }]).deletes).toEqual({})
    const mixed = toggleDeletes(marked, [
      { row: 1, key: [1] },
      { row: 2, key: [2] },
    ])
    expect(Object.keys(mixed.deletes)).toEqual(['1', '2'])
  })
})

describe('inserts', () => {
  it('adds a row of defaults and fills in values', () => {
    let set = addInsert(emptyChangeSet(), 'a')
    set = addInsert(set, 'b')
    set = setInsertValue(set, 'a', 0, 'hello')
    set = setInsertValue(set, 'a', 2, null)
    expect(set.inserts).toEqual([
      { id: 'a', values: { 0: 'hello', 2: null } },
      { id: 'b', values: {} },
    ])
  })

  it('goes back to the default when a value is cleared', () => {
    let set = setInsertValue(addInsert(emptyChangeSet(), 'a'), 'a', 0, 'x')
    set = setInsertValue(set, 'a', 0, undefined)
    expect(set.inserts[0]!.values).toEqual({})
  })

  it('removes a row', () => {
    const set = removeInsert(addInsert(addInsert(emptyChangeSet(), 'a'), 'b'), 'a')
    expect(set.inserts.map((r) => r.id)).toEqual(['b'])
  })
})

describe('toEditBatch', () => {
  it('maps result columns back to table columns, whatever their order or alias', () => {
    let set = setUpdate(emptyChangeSet(), 0, [7], 0, 'Renamed', 'Old', 'varchar')
    set = setUpdate(set, 0, [7], 2, '9.99', '1.00', 'decimal')
    const batch = toEditBatch(set, { columns, table })
    expect(batch).toEqual({
      schema: 'shop',
      table: 'items',
      changes: [{ kind: 'update', key: { id: 7 }, values: { name: 'Renamed', price: '9.99' } }],
    })
  })

  it('orders deletes, then updates, then inserts, each by row', () => {
    let set = setUpdate(emptyChangeSet(), 5, [5], 0, 'a', 'b', 'varchar')
    set = setUpdate(set, 2, [2], 0, 'a', 'b', 'varchar')
    set = toggleDeletes(set, [
      { row: 9, key: [9] },
      { row: 1, key: [1] },
    ])
    set = setInsertValue(addInsert(set, 'n'), 'n', 0, 'fresh')
    const batch = toEditBatch(set, { columns, table })
    expect(
      batch.changes.map((c) => (c.kind === 'insert' ? 'insert' : `${c.kind}:${c.key.id}`)),
    ).toEqual(['delete:1', 'delete:9', 'update:2', 'update:5', 'insert'])
  })

  it('leaves unset columns out of an insert so defaults and auto-increment apply', () => {
    const set = setInsertValue(addInsert(emptyChangeSet(), 'n'), 'n', 0, 'only name')
    expect(toEditBatch(set, { columns, table }).changes).toEqual([
      { kind: 'insert', values: { name: 'only name' } },
    ])
  })

  it('addresses a row by the key it was loaded with, even after its key column is edited', () => {
    const set = setUpdate(emptyChangeSet(), 0, [7], 1, 8, 7, 'int')
    expect(toEditBatch(set, { columns, table }).changes).toEqual([
      { kind: 'update', key: { id: 7 }, values: { id: 8 } },
    ])
  })

  it('produces statements the server can run, previewed with the values written in', () => {
    let set = setUpdate(emptyChangeSet(), 0, [7], 0, "O'Brien", 'x', 'varchar')
    set = toggleDeletes(set, [{ row: 3, key: [3] }])
    const statements = buildEditStatements(toEditBatch(set, { columns, table }), columnTypes(table))
    expect(statements.map((s) => s.preview)).toEqual([
      'DELETE FROM `shop`.`items` WHERE `id` = 3',
      "UPDATE `shop`.`items` SET `name` = 'O''Brien' WHERE `id` = 7",
    ])
  })
})
