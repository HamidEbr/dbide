import type { ForeignKey, ReferencingKey } from '@shared/edit'

/**
 * Rows of `information_schema.KEY_COLUMN_USAGE` hold one column of a constraint each. These turn them
 * into one key per constraint, with its columns in order. Rows arrive ordered by constraint and then
 * by position in the key.
 */

/** Rows: constraint, column, referenced schema, referenced table, referenced column. */
export function groupForeignKeys(rows: unknown[][]): ForeignKey[] {
  const keys = new Map<string, ForeignKey>()
  for (const row of rows) {
    const name = String(row[0])
    let key = keys.get(name)
    if (!key) {
      key = {
        name,
        columns: [],
        refSchema: String(row[2]),
        refTable: String(row[3]),
        refColumns: [],
      }
      keys.set(name, key)
    }
    key.columns.push(String(row[1]))
    key.refColumns.push(String(row[4]))
  }
  return [...keys.values()]
}

/** Rows: constraint, its schema, its table, its column, the referenced column. */
export function groupReferencingKeys(rows: unknown[][]): ReferencingKey[] {
  const keys = new Map<string, ReferencingKey>()
  for (const row of rows) {
    const schema = String(row[1])
    const table = String(row[2])
    const id = `${schema}\u0000${table}\u0000${String(row[0])}`
    let key = keys.get(id)
    if (!key) {
      key = { name: String(row[0]), schema, table, columns: [], refColumns: [] }
      keys.set(id, key)
    }
    key.columns.push(String(row[3]))
    key.refColumns.push(String(row[4]))
  }
  return [...keys.values()]
}
