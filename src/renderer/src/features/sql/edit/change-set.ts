import type { ColumnInfo } from '@shared/driver'
import type { EditBatch, RowChange, TableDescription } from '@shared/edit'
import type { Cell } from '@shared/query'
import { cellsEqual } from '@shared/value'

/**
 * The edits a person has made to a result but not yet saved. Plain immutable data, so it can be
 * held in a store, compared, and tested without any UI. Columns are addressed by their position
 * in the result.
 */
export interface RowUpdate {
  /** Primary key of the row as it was loaded. Stays fixed even if a key column is edited. */
  key: Cell[]
  values: Record<number, Cell>
}

export interface NewRow {
  id: string
  /** Missing columns take the table's default. */
  values: Record<number, Cell>
}

export interface ChangeSet {
  updates: Record<number, RowUpdate>
  deletes: Record<number, Cell[]>
  inserts: NewRow[]
}

export const emptyChangeSet = (): ChangeSet => ({ updates: {}, deletes: {}, inserts: [] })

export const countChanges = (set: ChangeSet): number =>
  Object.keys(set.updates).length + Object.keys(set.deletes).length + set.inserts.length

export const isEmpty = (set: ChangeSet): boolean => countChanges(set) === 0

/**
 * Records a new value for one cell of a loaded row. Setting a cell back to what it was removes
 * the change, so undoing an edit by hand leaves nothing staged.
 */
export function setUpdate(
  set: ChangeSet,
  row: number,
  key: Cell[],
  col: number,
  value: Cell,
  original: Cell,
  type: string,
): ChangeSet {
  const existing = set.updates[row]
  const values = { ...(existing?.values ?? {}) }
  if (cellsEqual(original, value, type)) delete values[col]
  else values[col] = value

  const updates = { ...set.updates }
  if (Object.keys(values).length === 0) delete updates[row]
  else updates[row] = { key: existing?.key ?? key, values }
  return { ...set, updates }
}

/** Marks rows for deletion, or unmarks them if every one is already marked. */
export function toggleDeletes(set: ChangeSet, rows: { row: number; key: Cell[] }[]): ChangeSet {
  const allMarked = rows.length > 0 && rows.every(({ row }) => row in set.deletes)
  const deletes = { ...set.deletes }
  const updates = { ...set.updates }
  for (const { row, key } of rows) {
    if (allMarked) {
      delete deletes[row]
    } else {
      deletes[row] = key
      // A row that is going away has no use for pending edits.
      delete updates[row]
    }
  }
  return { ...set, deletes, updates }
}

export const addInsert = (set: ChangeSet, id: string): ChangeSet => ({
  ...set,
  inserts: [...set.inserts, { id, values: {} }],
})

export function setInsertValue(
  set: ChangeSet,
  id: string,
  col: number,
  value: Cell | undefined,
): ChangeSet {
  return {
    ...set,
    inserts: set.inserts.map((row) => {
      if (row.id !== id) return row
      const values = { ...row.values }
      if (value === undefined) delete values[col]
      else values[col] = value
      return { ...row, values }
    }),
  }
}

export const removeInsert = (set: ChangeSet, id: string): ChangeSet => ({
  ...set,
  inserts: set.inserts.filter((row) => row.id !== id),
})

export interface BatchContext {
  columns: ColumnInfo[]
  table: TableDescription
}

const sourceName = (columns: ColumnInfo[], index: number): string =>
  columns[index]?.source?.column ?? columns[index]?.name ?? ''

/**
 * Turns the staged changes into what the server is asked to do. Deletes come first, then
 * updates, then inserts, each in row order, so a re-used key can't collide with itself.
 */
export function toEditBatch(set: ChangeSet, context: BatchContext): EditBatch {
  const { columns, table } = context
  const keyOf = (key: Cell[]): Record<string, Cell> =>
    Object.fromEntries(table.primaryKey.map((name, i) => [name, key[i] as Cell]))
  const valuesOf = (values: Record<number, Cell>): Record<string, Cell> =>
    Object.fromEntries(
      Object.entries(values).map(([col, value]) => [sourceName(columns, Number(col)), value]),
    )

  const byRow = (a: string, b: string): number => Number(a) - Number(b)
  const changes: RowChange[] = [
    ...Object.keys(set.deletes)
      .sort(byRow)
      .map((row): RowChange => ({ kind: 'delete', key: keyOf(set.deletes[Number(row)]!) })),
    ...Object.keys(set.updates)
      .sort(byRow)
      .map((row): RowChange => {
        const update = set.updates[Number(row)]!
        return { kind: 'update', key: keyOf(update.key), values: valuesOf(update.values) }
      }),
    ...set.inserts.map((row): RowChange => ({ kind: 'insert', values: valuesOf(row.values) })),
  ]
  return { schema: table.schema, table: table.table, changes }
}

/** Column types by source column name, for writing readable previews. */
export function columnTypes(table: TableDescription): Record<string, string> {
  return Object.fromEntries(table.columns.map((c) => [c.name, c.type]))
}
