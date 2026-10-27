import { dialectInfo, type SqlDialect } from './dialect'
import type { SchemaColumn } from './driver'

/**
 * The statements that change a table, written for each server. Used to make one schema match another and by the
 * table designer, so a change is written the same way wherever it comes from.
 */

export interface ColumnSpec {
  name: string
  /** The type as the server writes it: `varchar(120)`, `int unsigned`, `numeric(10,2)`. */
  type: string
  nullable: boolean
}

export const norm = (type: string): string => type.toLowerCase().replace(/\s+/g, ' ').trim()

export function columnLine(dialect: SqlDialect, c: ColumnSpec): string {
  return `${dialectInfo(dialect).quote(c.name)} ${c.type}${c.nullable ? ' NULL' : ' NOT NULL'}`
}

export function createTable(
  dialect: SqlDialect,
  schema: string,
  table: string,
  columns: readonly (ColumnSpec & { key?: SchemaColumn['key'] })[],
): string {
  const info = dialectInfo(dialect)
  const lines = columns.map((c) => `  ${columnLine(dialect, c)}`)
  const primary = columns.filter((c) => c.key === 'PRI')
  if (primary.length > 0) {
    lines.push(`  PRIMARY KEY (${primary.map((c) => info.quote(c.name)).join(', ')})`)
  }
  return `CREATE TABLE ${info.qualified(schema, table)} (\n${lines.join(',\n')}\n);`
}

export function addColumn(
  dialect: SqlDialect,
  schema: string,
  table: string,
  column: ColumnSpec,
): string {
  const t = dialectInfo(dialect).qualified(schema, table)
  return `ALTER TABLE ${t} ADD ${dialect === 'mssql' ? '' : 'COLUMN '}${columnLine(dialect, column)};`
}

export function dropColumn(
  dialect: SqlDialect,
  schema: string,
  table: string,
  name: string,
): string {
  const info = dialectInfo(dialect)
  return `ALTER TABLE ${info.qualified(schema, table)} DROP COLUMN ${info.quote(name)};`
}

/** Changes a column's type and whether it allows NULL, writing only what differs where the server allows it. */
export function alterColumn(
  dialect: SqlDialect,
  schema: string,
  table: string,
  from: ColumnSpec,
  to: ColumnSpec,
): string[] {
  const info = dialectInfo(dialect)
  const t = info.qualified(schema, table)
  const c = info.quote(to.name)
  if (dialect === 'mysql') return [`ALTER TABLE ${t} MODIFY COLUMN ${columnLine(dialect, to)};`]
  if (dialect === 'mssql') return [`ALTER TABLE ${t} ALTER COLUMN ${columnLine(dialect, to)};`]
  const out: string[] = []
  if (norm(from.type) !== norm(to.type)) {
    out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${to.type};`)
  }
  if (from.nullable !== to.nullable) {
    out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} ${to.nullable ? 'DROP' : 'SET'} NOT NULL;`)
  }
  return out
}

export function renameColumn(
  dialect: SqlDialect,
  schema: string,
  table: string,
  from: string,
  to: string,
): string {
  const info = dialectInfo(dialect)
  if (dialect === 'mssql') {
    const path = `${schema}.${table}.${from}`.replace(/'/g, "''")
    return `EXEC sp_rename N'${path}', N'${to.replace(/'/g, "''")}', N'COLUMN';`
  }
  return `ALTER TABLE ${info.qualified(schema, table)} RENAME COLUMN ${info.quote(from)} TO ${info.quote(to)};`
}

export function renameTable(dialect: SqlDialect, schema: string, from: string, to: string): string {
  const info = dialectInfo(dialect)
  if (dialect === 'mssql') {
    const path = `${schema}.${from}`.replace(/'/g, "''")
    return `EXEC sp_rename N'${path}', N'${to.replace(/'/g, "''")}';`
  }
  if (dialect === 'postgresql') {
    return `ALTER TABLE ${info.qualified(schema, from)} RENAME TO ${info.quote(to)};`
  }
  return `RENAME TABLE ${info.qualified(schema, from)} TO ${info.qualified(schema, to)};`
}

export function dropTable(
  dialect: SqlDialect,
  schema: string,
  table: string,
  view = false,
): string {
  return `DROP ${view ? 'VIEW' : 'TABLE'} ${dialectInfo(dialect).qualified(schema, table)};`
}
