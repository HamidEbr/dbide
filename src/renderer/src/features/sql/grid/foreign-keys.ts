import type { ColumnInfo } from '@shared/driver'
import type { TableDescription } from '@shared/edit'
import type { Cell } from '@shared/query'
import { sqlLiteral } from '@shared/value'

/** A way to jump from a row to related rows, along a foreign key. */
export interface FkLink {
  /** `references`: this row points at one row elsewhere. `referencedBy`: rows elsewhere point at this one. */
  direction: 'references' | 'referencedBy'
  name: string
  /** Where the key values are in the result: the columns on this side of the key. */
  columnIndexes: number[]
  targetSchema: string
  targetTable: string
  /** The columns on the other side, matching `columnIndexes` one for one. */
  targetColumns: string[]
}

const tableId = (schema: string, table: string): string => `${schema}\u0000${table}`

const quote = (name: string): string => `\`${name.replace(/`/g, '``')}\``

/**
 * Every link a result offers, grouped by the column it hangs on. A key that spans several columns
 * is offered from each of them, and only when every one of them is in the result, since the jump
 * needs all their values. Columns of a join are matched to their own table's keys.
 */
export function linksByColumn(
  columns: readonly ColumnInfo[],
  descriptions: ReadonlyMap<string, TableDescription>,
): FkLink[][] {
  const links: FkLink[][] = columns.map(() => [])
  const indexOf = (schema: string, table: string, column: string): number =>
    columns.findIndex(
      (c) => c.source?.schema === schema && c.source.table === table && c.source.column === column,
    )

  const seen = new Set<string>()
  for (const column of columns) {
    if (!column.source) continue
    const id = tableId(column.source.schema, column.source.table)
    if (seen.has(id)) continue
    seen.add(id)
    const table = descriptions.get(id)
    if (!table) continue

    const add = (link: FkLink): void => {
      for (const index of link.columnIndexes) links[index]!.push(link)
    }

    for (const key of table.foreignKeys ?? []) {
      const indexes = key.columns.map((c) => indexOf(table.schema, table.table, c))
      if (indexes.includes(-1)) continue
      add({
        direction: 'references',
        name: key.name,
        columnIndexes: indexes,
        targetSchema: key.refSchema,
        targetTable: key.refTable,
        targetColumns: key.refColumns,
      })
    }
    for (const key of table.referencedBy ?? []) {
      const indexes = key.refColumns.map((c) => indexOf(table.schema, table.table, c))
      if (indexes.includes(-1)) continue
      add({
        direction: 'referencedBy',
        name: key.name,
        columnIndexes: indexes,
        targetSchema: key.schema,
        targetTable: key.table,
        targetColumns: key.columns,
      })
    }
  }
  return links
}

export interface Lookup {
  sql: string
  /** A name for the tab it opens in. */
  title: string
  database: string
}

/**
 * The query that shows the rows a link leads to, for one row of the result. Null when a value of
 * the key is NULL, since NULL points at nothing.
 */
export function buildLookup(
  link: FkLink,
  columns: readonly ColumnInfo[],
  row: readonly (Cell | undefined)[],
  limit = 1000,
): Lookup | null {
  const conditions: string[] = []
  for (const [i, index] of link.columnIndexes.entries()) {
    const value = row[index]
    if (value === null || value === undefined) return null
    conditions.push(`${quote(link.targetColumns[i]!)} = ${sqlLiteral(value, columns[index]?.type)}`)
  }
  return {
    sql: `SELECT * FROM ${quote(link.targetSchema)}.${quote(link.targetTable)} WHERE ${conditions.join(' AND ')} LIMIT ${limit};`,
    title: link.targetTable,
    database: link.targetSchema,
  }
}

/** A short description of what a link does, for a tooltip or a menu. */
export function describeLink(link: FkLink): string {
  const target = `${link.targetTable}.${link.targetColumns.join(', ')}`
  return link.direction === 'references' ? `Go to ${target}` : `Find rows in ${target}`
}
