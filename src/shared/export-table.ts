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

/** A name quoted for MySQL, so a name with spaces, dashes or a keyword in it still works. */
export const quoteIdentifier = (name: string): string => `\`${name.replace(/`/g, '``')}\``

/** The SELECT that reads the table. All columns are written as `*`, so a table that gains one still exports whole. */
export function buildTableSelect(source: TableExport, allColumns: readonly string[]): string {
  const everything =
    source.columns === null ||
    (source.columns.length === allColumns.length &&
      allColumns.every((name) => source.columns!.includes(name)))
  const list = everything ? '*' : source.columns!.map(quoteIdentifier).join(', ')
  const from = `${quoteIdentifier(source.schema)}.${quoteIdentifier(source.table)}`
  let sql = `SELECT ${list}\nFROM ${from}`
  const condition = source.where.trim()
  // On their own lines, so a comment at the end of the condition can't swallow the bracket or the LIMIT.
  if (condition !== '') sql += `\nWHERE (\n${condition}\n)`
  if (source.limit !== null) sql += `\nLIMIT ${Math.max(0, Math.floor(source.limit))}`
  return sql
}
