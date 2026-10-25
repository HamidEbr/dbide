import { buildEditStatements, type RowChange, type TableDescription } from '@shared/edit'
import type { ColumnInfo } from '@shared/driver'
import type { Cell } from '@shared/query'

export type GenerateKind = 'update' | 'delete'

export type Generated = { ok: true; statements: string[] } | { ok: false; message: string }

/**
 * `UPDATE` or `DELETE` statements for rows of a result, to copy and run later or somewhere else.
 * Rows are found by primary key, so the key must be in the result. An `UPDATE` sets the selected
 * columns, or every column that can be written when the selection holds only key columns.
 *
 * `rows` hold every column of the result. The statements are built by the same code that builds the
 * ones a commit runs, so values are written the same way.
 */
export function generateStatements(
  kind: GenerateKind,
  table: TableDescription,
  columns: readonly ColumnInfo[],
  rows: readonly (readonly (Cell | undefined)[])[],
  selected: readonly number[],
): Generated {
  if (table.primaryKey.length === 0) {
    return {
      ok: false,
      message: `${table.table} has no primary key, so its rows can’t be addressed.`,
    }
  }
  const keyAt = table.primaryKey.map((name) => columns.findIndex((c) => c.source?.column === name))
  const missing = table.primaryKey.find((_, i) => keyAt[i] === -1)
  if (missing) {
    return { ok: false, message: `Include the primary key column “${missing}” in the query first.` }
  }

  const types = Object.fromEntries(table.columns.map((c) => [c.name, c.type]))
  const writable = (index: number): boolean => {
    const source = columns[index]?.source
    if (!source) return false
    const meta = table.columns.find((c) => c.name === source.column)
    return meta !== undefined && !meta.generated && !table.primaryKey.includes(source.column)
  }
  let setColumns = selected.filter(writable)
  if (kind === 'update' && setColumns.length === 0) {
    setColumns = columns.map((_, i) => i).filter(writable)
  }
  if (kind === 'update' && setColumns.length === 0) {
    return { ok: false, message: 'There is no column to set: the table is only its key.' }
  }

  const cell = (row: readonly (Cell | undefined)[], index: number): Cell => row[index] ?? null
  const changes: RowChange[] = rows.map((row) => {
    const key = Object.fromEntries(table.primaryKey.map((name, i) => [name, cell(row, keyAt[i]!)]))
    if (kind === 'delete') return { kind: 'delete', key }
    const values = Object.fromEntries(
      setColumns.map((index) => [columns[index]!.source!.column, cell(row, index)]),
    )
    return { kind: 'update', key, values }
  })
  if (changes.length === 0) return { ok: false, message: 'Select some rows first.' }

  const built = buildEditStatements({ schema: table.schema, table: table.table, changes }, types)
  return { ok: true, statements: built.map((s) => `${s.preview};`) }
}
