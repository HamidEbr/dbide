import type { ColumnInfo } from './driver'
import type { Cell } from './query'
import { dialectInfo, type SqlDialect } from './dialect'
import { sqlLiteral } from './value'

/** What the server says about one column of a table, beyond what a result carries. */
export interface TableColumn {
  name: string
  /** The data type, such as `int` or `varchar`. */
  type: string
  /** The full definition, such as `int unsigned` or `varchar(255)`. */
  columnType: string
  nullable: boolean
  autoIncrement: boolean
  /** Computed by the server; it can't be written. */
  generated: boolean
}

/** A foreign key of the table being described: its columns point at columns of another table. */
export interface ForeignKey {
  name: string
  /** This table's columns, in key order. */
  columns: string[]
  refSchema: string
  refTable: string
  /** The referenced table's columns, matching `columns` one for one. */
  refColumns: string[]
}

/** A foreign key of another table that points at the table being described. */
export interface ReferencingKey {
  name: string
  /** The table that holds the reference. */
  schema: string
  table: string
  /** That table's columns, in key order. */
  columns: string[]
  /** This table's columns they point at, matching `columns` one for one. */
  refColumns: string[]
}

export interface TableDescription {
  schema: string
  table: string
  columns: TableColumn[]
  /** Primary key columns in key order. Empty when the table has none. */
  primaryKey: string[]
  /** Where this table's columns point. Missing when the engine can't say. */
  foreignKeys?: ForeignKey[]
  /** Which other tables point at this one. Missing when the engine can't say. */
  referencedBy?: ReferencingKey[]
}

/** A change to one row. `key` holds the primary key of the row as it was loaded. */
export type RowChange =
  | { kind: 'update'; key: Record<string, Cell>; values: Record<string, Cell> }
  | { kind: 'delete'; key: Record<string, Cell> }
  | { kind: 'insert'; values: Record<string, Cell> }

export interface EditBatch {
  schema: string
  table: string
  changes: RowChange[]
}

export interface EditStatement {
  kind: RowChange['kind']
  /** SQL with `?` placeholders. This is what runs. */
  sql: string
  params: Cell[]
  /** The same statement with the values written in, for showing to a person. */
  preview: string
}

export type EditResult =
  | { ok: true; results: { affectedRows: number; insertId: string | null }[] }
  | { ok: false; failedIndex: number; code: string | null; message: string }

export const MAX_CHANGES_PER_BATCH = 5000

function inline(
  sql: string,
  params: Cell[],
  types: (string | undefined)[],
  dialect: SqlDialect,
): string {
  let index = 0
  return sql.replace(/\?/g, () => {
    const at = index++
    return sqlLiteral(params[at], types[at], dialect)
  })
}

/**
 * The statements that apply a batch, with bound parameters. Updates and deletes are addressed by
 * primary key only. The same function builds the preview shown before commit and the statements
 * that run, so the two can never disagree.
 */
export function buildEditStatements(
  batch: EditBatch,
  columnTypes: Record<string, string>,
  dialect: SqlDialect = 'mysql',
): EditStatement[] {
  const quote = dialectInfo(dialect).quote
  const table = dialectInfo(dialect).qualified(batch.schema, batch.table)

  const where = (
    key: Record<string, Cell>,
  ): { sql: string; params: Cell[]; types: (string | undefined)[] } => {
    const names = Object.keys(key)
    if (names.length === 0) throw new Error('A change needs the row’s primary key.')
    return {
      sql: names.map((name) => `${quote(name)} = ?`).join(' AND '),
      params: names.map((name) => key[name] as Cell),
      types: names.map((name) => columnTypes[name]),
    }
  }

  return batch.changes.map((change): EditStatement => {
    if (change.kind === 'update') {
      const names = Object.keys(change.values)
      if (names.length === 0) throw new Error('An update needs at least one value.')
      const condition = where(change.key)
      const sql = `UPDATE ${table} SET ${names.map((n) => `${quote(n)} = ?`).join(', ')} WHERE ${condition.sql}`
      const params = [...names.map((n) => change.values[n] as Cell), ...condition.params]
      const types = [...names.map((n) => columnTypes[n]), ...condition.types]
      return { kind: 'update', sql, params, preview: inline(sql, params, types, dialect) }
    }
    if (change.kind === 'delete') {
      const condition = where(change.key)
      const sql = `DELETE FROM ${table} WHERE ${condition.sql}`
      return {
        kind: 'delete',
        sql,
        params: condition.params,
        preview: inline(sql, condition.params, condition.types, dialect),
      }
    }
    const names = Object.keys(change.values)
    const sql =
      names.length === 0
        ? dialect === 'mysql'
          ? `INSERT INTO ${table} () VALUES ()`
          : `INSERT INTO ${table} DEFAULT VALUES`
        : `INSERT INTO ${table} (${names.map(quote).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
    const params = names.map((n) => change.values[n] as Cell)
    return {
      kind: 'insert',
      sql,
      params,
      preview: inline(
        sql,
        params,
        names.map((n) => columnTypes[n]),
        dialect,
      ),
    }
  })
}

/**
 * The one table a result comes from, if every column is a plain column of the same table. Joins,
 * expressions, and aggregates make a result read-only, because a cell then has no single row to
 * write back to.
 */
export function singleSourceTable(
  columns: ColumnInfo[],
): { schema: string; table: string } | { reason: string } {
  if (columns.length === 0) return { reason: 'This result has no columns.' }
  let schema: string | null = null
  let table: string | null = null
  for (const column of columns) {
    if (!column.source) {
      return { reason: `“${column.name}” is computed, so these rows can’t be edited.` }
    }
    if (schema === null) {
      schema = column.source.schema
      table = column.source.table
    } else if (schema !== column.source.schema || table !== column.source.table) {
      return { reason: 'This result joins several tables, so it can’t be edited.' }
    }
  }
  return { schema: schema!, table: table! }
}
