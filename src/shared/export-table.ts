/**
 * Exporting a table from the tree: the SELECT that reads it, built from what the person chose in the dialog
 * (which columns, which rows, how many). The core still checks the result is one statement that only reads,
 * so a filter that tries to add a second statement is refused there.
 */

export interface TableExport {
  schema: string
  table: string
  /** The columns to write, in the order of the table. Null writes them all. */
  columns: string[] | null
  /** A condition such as `status = 'paid'`, without the word WHERE. Empty writes every row. */
  where: string
  /** The most rows to write. Null writes them all. */
  limit: number | null
}

import { dialectInfo, type SqlDialect } from './dialect'

/** A name quoted for the server, so a name with spaces, dashes or a keyword in it still works. */
export const quoteIdentifier = (name: string, dialect: SqlDialect = 'mysql'): string =>
  dialectInfo(dialect).quote(name)

/** The SELECT that reads the table. All columns are written as `*`, so a table that gains one still exports whole. */
export function buildTableSelect(
  source: TableExport,
  allColumns: readonly string[],
  dialect: SqlDialect = 'mysql',
): string {
  const everything =
    source.columns === null ||
    (source.columns.length === allColumns.length &&
      allColumns.every((name) => source.columns!.includes(name)))
  const list = everything ? '*' : source.columns!.map((c) => quoteIdentifier(c, dialect)).join(', ')
  const from = dialectInfo(dialect).qualified(source.schema, source.table)
  const rows = source.limit === null ? null : Math.max(0, Math.floor(source.limit))
  // SQL Server has no LIMIT: the count goes after SELECT.
  const top = dialect === 'mssql' && rows !== null ? `TOP (${rows}) ` : ''
  let sql = `SELECT ${top}${list}\nFROM ${from}`
  const condition = source.where.trim()
  // On their own lines, so a comment at the end of the condition can't swallow the bracket or the LIMIT.
  if (condition !== '') sql += `\nWHERE (\n${condition}\n)`
  if (rows !== null && dialect !== 'mssql') sql += `\nLIMIT ${rows}`
  return sql
}
