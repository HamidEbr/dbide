import { addColumn, alterColumn, dropColumn, norm, renameColumn, type ColumnSpec } from './ddl'
import type { SqlDialect } from './dialect'
import { dialectInfo } from './dialect'
import type { TableColumn } from './edit'

/**
 * Editing a table's columns as a list, and turning the edits into the statements that make them. The list holds
 * each column as it was read and as it is now, so a rename, a new type and a drop are told apart.
 */

export interface DraftColumn {
  /** Stable while editing, since a name can change. */
  id: string
  /** The column as the server has it, or null for one that is being added. */
  original: ColumnSpec | null
  name: string
  type: string
  nullable: boolean
  /** The column is marked to be dropped. */
  removed: boolean
  /** Part of the primary key, or computed: shown, and not changed here. */
  locked: boolean
  note: string
}

export function draftFrom(
  columns: readonly TableColumn[],
  primaryKey: readonly string[],
): DraftColumn[] {
  return columns.map((c, i) => ({
    id: `c${i}`,
    original: { name: c.name, type: c.columnType, nullable: c.nullable },
    name: c.name,
    type: c.columnType,
    nullable: c.nullable,
    removed: false,
    locked: c.generated,
    note: [
      primaryKey.includes(c.name) ? 'primary key' : null,
      c.autoIncrement ? 'auto' : null,
      c.generated ? 'computed' : null,
    ]
      .filter(Boolean)
      .join(', '),
  }))
}

export const newColumn = (n: number): DraftColumn => ({
  id: `new${n}`,
  original: null,
  name: '',
  type: '',
  nullable: true,
  removed: false,
  locked: false,
  note: '',
})

/** Whether the draft differs from what the server has. */
export function isChanged(draft: readonly DraftColumn[]): boolean {
  return draft.some((c) =>
    c.original === null
      ? !c.removed
      : c.removed ||
        c.name !== c.original.name ||
        norm(c.type) !== norm(c.original.type) ||
        c.nullable !== c.original.nullable,
  )
}

/** What stops the draft from being applied, or null. */
export function problemWith(draft: readonly DraftColumn[]): string | null {
  const kept = draft.filter((c) => !c.removed)
  for (const c of kept) {
    if (c.name.trim() === '') return 'Every column needs a name.'
    if (c.type.trim() === '') return `Give “${c.name}” a type.`
  }
  const seen = new Set<string>()
  for (const c of kept) {
    const key = c.name.trim().toLowerCase()
    if (seen.has(key)) return `Two columns are named “${c.name}”.`
    seen.add(key)
  }
  if (kept.length === 0) return 'A table needs at least one column.'
  return null
}

/** The statements, in an order that runs: renames and changes, then new columns, then drops. */
export function buildDesignerStatements(
  dialect: SqlDialect,
  schema: string,
  table: string,
  draft: readonly DraftColumn[],
): string[] {
  const info = dialectInfo(dialect)
  const out: string[] = []
  for (const c of draft) {
    if (c.removed || c.original === null) continue
    const was = c.original
    const now: ColumnSpec = { name: c.name.trim(), type: c.type.trim(), nullable: c.nullable }
    const renamed = now.name !== was.name
    const altered = norm(now.type) !== norm(was.type) || now.nullable !== was.nullable
    if (!renamed && !altered) continue
    if (dialect === 'mysql' && renamed) {
      // CHANGE renames and redefines in one statement, and works on servers that have no RENAME COLUMN.
      out.push(
        `ALTER TABLE ${info.qualified(schema, table)} CHANGE COLUMN ${info.quote(was.name)} ${info.quote(now.name)} ${now.type}${now.nullable ? ' NULL' : ' NOT NULL'};`,
      )
      continue
    }
    if (renamed) out.push(renameColumn(dialect, schema, table, was.name, now.name))
    if (altered) out.push(...alterColumn(dialect, schema, table, { ...was, name: now.name }, now))
  }
  for (const c of draft) {
    if (c.original !== null || c.removed) continue
    out.push(
      addColumn(dialect, schema, table, {
        name: c.name.trim(),
        type: c.type.trim(),
        nullable: c.nullable,
      }),
    )
  }
  for (const c of draft) {
    if (c.original !== null && c.removed)
      out.push(dropColumn(dialect, schema, table, c.original.name))
  }
  return out
}

/** Types worth offering when typing one, per server. */
export const COMMON_TYPES: Record<SqlDialect, string[]> = {
  mysql: [
    'int',
    'bigint',
    'tinyint(1)',
    'decimal(10,2)',
    'double',
    'varchar(255)',
    'text',
    'longtext',
    'date',
    'datetime',
    'timestamp',
    'json',
    'blob',
  ],
  postgresql: [
    'integer',
    'bigint',
    'boolean',
    'numeric(10,2)',
    'double precision',
    'varchar(255)',
    'text',
    'date',
    'timestamp',
    'timestamptz',
    'uuid',
    'jsonb',
    'bytea',
  ],
  mssql: [
    'int',
    'bigint',
    'bit',
    'decimal(10,2)',
    'float',
    'nvarchar(255)',
    'nvarchar(max)',
    'date',
    'datetime2',
    'uniqueidentifier',
    'varbinary(max)',
  ],
}
