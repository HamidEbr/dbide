import type { ColumnInfo } from '@shared/driver'
import type { TableDescription } from '@shared/edit'
import type { Cell } from '@shared/query'
import type { ChangeSet } from './change-set'
import type { RowStore } from '../grid/row-store'

export interface SavedResult {
  affectedRows: number
  insertId: string | null
}

/**
 * After the server accepted a batch, makes the loaded rows say the same thing. `results` is in
 * the order `toEditBatch` produced the changes: deletes, updates, then inserts.
 *
 * New rows show what was typed, plus the id the server assigned to an auto-increment key. Other
 * server-side defaults are unknown here, so they read as NULL until the query runs again.
 */
export function applySavedChanges(
  store: RowStore,
  columns: ColumnInfo[],
  table: TableDescription,
  changes: ChangeSet,
  results: SavedResult[],
): void {
  const deleteCount = Object.keys(changes.deletes).length
  const updateCount = Object.keys(changes.updates).length

  for (const [row, update] of Object.entries(changes.updates)) {
    store.setCells(Number(row), update.values)
  }
  store.removeRows(Object.keys(changes.deletes).map(Number))

  const insertResults = results.slice(deleteCount + updateCount)
  const autoIncrement = table.columns.find((c) => c.autoIncrement)
  const autoColumn = autoIncrement
    ? columns.findIndex((c) => c.source?.column === autoIncrement.name)
    : -1

  const rows: Cell[][] = changes.inserts.map((insert, i) => {
    const row: Cell[] = columns.map((_, c) => insert.values[c] ?? null)
    const id = insertResults[i]?.insertId
    if (autoColumn >= 0 && insert.values[autoColumn] === undefined && id) {
      // BIGINT keys stay text, like everywhere else; smaller ones are numbers.
      row[autoColumn] = columns[autoColumn]!.type === 'bigint' ? id : Number(id)
    }
    return row
  })
  if (rows.length > 0) store.append(rows)
}
