import { describe, expect, it } from 'vitest'
import type { ColumnInfo } from '@shared/driver'
import type { TableDescription } from '@shared/edit'
import { applySavedChanges } from './apply'
import {
  addInsert,
  emptyChangeSet,
  setInsertValue,
  setUpdate,
  toggleDeletes,
  type ChangeSet,
} from './change-set'
import { RowStore } from '../grid/row-store'

const col = (name: string, type: string): ColumnInfo => ({
  name,
  type,
  source: { schema: 's', table: 't', column: name },
})
const columns = [col('id', 'int'), col('name', 'varchar'), col('note', 'text')]
const table: TableDescription = {
  schema: 's',
  table: 't',
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
      columnType: 'varchar(9)',
      nullable: false,
      autoIncrement: false,
      generated: false,
    },
    {
      name: 'note',
      type: 'text',
      columnType: 'text',
      nullable: true,
      autoIncrement: false,
      generated: false,
    },
  ],
}

const store = (): RowStore => {
  const s = new RowStore((callback) => callback())
  s.append([
    [1, 'one', null],
    [2, 'two', null],
    [3, 'three', 'x'],
    [4, 'four', null],
  ])
  return s
}

describe('applySavedChanges', () => {
  it('updates cells, removes deleted rows, and appends new ones', () => {
    let changes: ChangeSet = setUpdate(emptyChangeSet(), 0, [1], 1, 'ONE', 'one', 'varchar')
    changes = toggleDeletes(changes, [{ row: 2, key: [3] }])
    changes = setInsertValue(addInsert(changes, 'n'), 'n', 1, 'five')
    const rows = store()

    applySavedChanges(rows, columns, table, changes, [
      { affectedRows: 1, insertId: null },
      { affectedRows: 1, insertId: null },
      { affectedRows: 1, insertId: '5' },
    ])

    expect(rows.rows).toEqual([
      [1, 'ONE', null],
      [2, 'two', null],
      [4, 'four', null],
      [5, 'five', null],
    ])
  })

  it('removes several deleted rows without disturbing the order of the rest', () => {
    const changes = toggleDeletes(emptyChangeSet(), [
      { row: 0, key: [1] },
      { row: 3, key: [4] },
    ])
    const rows = store()
    applySavedChanges(rows, columns, table, changes, [
      { affectedRows: 1, insertId: null },
      { affectedRows: 1, insertId: null },
    ])
    expect(rows.rows.map((r) => r[0])).toEqual([2, 3])
  })

  it('fills in the auto-increment key from the server, as text for bigint', () => {
    const changes = setInsertValue(addInsert(emptyChangeSet(), 'n'), 'n', 1, 'x')
    const intRows = store()
    applySavedChanges(intRows, columns, table, changes, [{ affectedRows: 1, insertId: '42' }])
    expect(intRows.getRow(4)).toEqual([42, 'x', null])

    const bigColumns = [col('id', 'bigint'), col('name', 'varchar'), col('note', 'text')]
    const bigRows = store()
    applySavedChanges(bigRows, bigColumns, table, changes, [
      { affectedRows: 1, insertId: '9007199254740993' },
    ])
    expect(bigRows.getRow(4)![0]).toBe('9007199254740993')
  })

  it('keeps a key the person typed instead of overwriting it', () => {
    const changes = setInsertValue(addInsert(emptyChangeSet(), 'n'), 'n', 0, 777)
    const rows = store()
    applySavedChanges(rows, columns, table, changes, [{ affectedRows: 1, insertId: '5' }])
    expect(rows.getRow(4)![0]).toBe(777)
  })

  it('leaves the key as NULL when the result does not include the auto-increment column', () => {
    const narrow = [col('name', 'varchar')]
    const changes = setInsertValue(addInsert(emptyChangeSet(), 'n'), 'n', 0, 'x')
    const rows = new RowStore((callback) => callback())
    applySavedChanges(rows, narrow, table, changes, [{ affectedRows: 1, insertId: '5' }])
    expect(rows.rows).toEqual([['x']])
  })

  it('does nothing for an empty change set', () => {
    const rows = store()
    applySavedChanges(rows, columns, table, emptyChangeSet(), [])
    expect(rows.length).toBe(4)
  })
})
