import type { EngineKind } from './connection'

/** The ways SQL differs between the servers DBIDE talks to: how names are quoted, how rows are limited, how values are written. */
export type SqlDialect = 'mysql' | 'postgresql' | 'mssql'

export function dialectOf(engine: EngineKind): SqlDialect | null {
  return engine === 'mysql' || engine === 'postgresql' || engine === 'mssql' ? engine : null
}

export interface DialectInfo {
  id: SqlDialect
  label: string
  /** A name written so a space, a dash or a keyword in it still works. */
  quote(name: string): string
  /** `schema.table`, each part quoted. */
  qualified(schema: string, table: string): string
  /** The statement that starts a transaction. */
  begin: string
  /** A schema that belongs to the server, listed last and left out of suggestions by default. */
  systemSchemas: ReadonlySet<string>
  /** What a person calls the thing a connection lists at its top: a MySQL schema is a database. */
  topLevel: 'database' | 'schema'
}

const MYSQL: DialectInfo = {
  id: 'mysql',
  label: 'MySQL',
  quote: (name) => `\`${name.replace(/`/g, '``')}\``,
  qualified: (schema, table) => `${MYSQL.quote(schema)}.${MYSQL.quote(table)}`,
  begin: 'START TRANSACTION',
  systemSchemas: new Set(['information_schema', 'mysql', 'performance_schema', 'sys']),
  topLevel: 'database',
}

const POSTGRESQL: DialectInfo = {
  id: 'postgresql',
  label: 'PostgreSQL',
  quote: (name) => `"${name.replace(/"/g, '""')}"`,
  qualified: (schema, table) => `${POSTGRESQL.quote(schema)}.${POSTGRESQL.quote(table)}`,
  begin: 'BEGIN',
  systemSchemas: new Set(['information_schema', 'pg_catalog', 'pg_toast']),
  topLevel: 'schema',
}

const MSSQL: DialectInfo = {
  id: 'mssql',
  label: 'SQL Server',
  quote: (name) => `[${name.replace(/]/g, ']]')}]`,
  qualified: (schema, table) => `${MSSQL.quote(schema)}.${MSSQL.quote(table)}`,
  begin: 'BEGIN TRANSACTION',
  systemSchemas: new Set(['sys', 'INFORMATION_SCHEMA', 'guest']),
  topLevel: 'schema',
}

const DIALECTS: Record<SqlDialect, DialectInfo> = {
  mysql: MYSQL,
  postgresql: POSTGRESQL,
  mssql: MSSQL,
}

export const dialectInfo = (dialect: SqlDialect = 'mysql'): DialectInfo => DIALECTS[dialect]

/** A SELECT of a table's rows, limited: `LIMIT n`, or `TOP (n)` where the server has no LIMIT. */
export function selectRows(
  dialect: SqlDialect,
  schema: string,
  table: string,
  limit: number,
): string {
  const from = dialectInfo(dialect).qualified(schema, table)
  return dialect === 'mssql'
    ? `SELECT TOP (${limit}) * FROM ${from};`
    : `SELECT * FROM ${from} LIMIT ${limit};`
}
