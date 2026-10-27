import { addColumn, alterColumn, createTable, dropColumn, dropTable, norm } from './ddl'
import { dialectInfo, type SqlDialect } from './dialect'
import type { SchemaForeignKey, SchemaTable } from './driver'

/**
 * Comparing two schemas and writing the script that makes the second one match the first. It looks at tables,
 * columns (type and whether they allow NULL) and foreign keys. Indexes, defaults, comments and the engine's
 * own table options are not compared.
 */

export interface SchemaSnapshot {
  tables: SchemaTable[]
  foreignKeys: SchemaForeignKey[]
}

export type DiffKind =
  | 'table-added'
  | 'table-removed'
  | 'column-added'
  | 'column-removed'
  | 'column-changed'
  | 'key-added'
  | 'key-removed'

export interface SchemaChange {
  id: string
  kind: DiffKind
  table: string
  column?: string
  /** What differs, in words. */
  summary: string
  /** The statements that make the target match, in the target's own SQL. Empty when they can't be written. */
  statements: string[]
  /** The change loses data: a dropped table or column. */
  destructive: boolean
}

const keyId = (k: SchemaForeignKey): string =>
  `${k.table}.${k.column}>${k.refSchema}.${k.refTable}.${k.refColumn}`.toLowerCase()

/** The name a foreign key gets when it is created here. */
const keyName = (k: { table: string; column: string }): string => `fk_${k.table}_${k.column}`

export function compareSchemas(
  source: SchemaSnapshot,
  target: SchemaSnapshot,
  options: { schema: string; dialect: SqlDialect | null },
): SchemaChange[] {
  const { schema, dialect } = options
  // Without a dialect nothing is written, but the same code builds (and drops) the text.
  const d: SqlDialect = dialect ?? 'mysql'
  const info = dialectInfo(d)
  const changes: SchemaChange[] = []
  const targetTables = new Map(target.tables.map((t) => [t.name.toLowerCase(), t]))
  const sourceTables = new Map(source.tables.map((t) => [t.name.toLowerCase(), t]))
  const push = (c: Omit<SchemaChange, 'id'>): void => {
    changes.push({ ...c, id: `${c.kind}:${c.table}:${c.column ?? ''}:${changes.length}` })
  }
  const script = (...lines: string[]): string[] => (dialect ? lines : [])

  for (const t of source.tables) {
    const other = targetTables.get(t.name.toLowerCase())
    if (!other) {
      push({
        kind: 'table-added',
        table: t.name,
        summary: `${t.view ? 'View' : 'Table'} ${t.name} is missing in the target`,
        // A view's definition is not read here, so only a table can be written.
        statements: t.view ? [] : script(createTable(d, schema, t.name, t.columns)),
        destructive: false,
      })
      continue
    }
    if (t.view || other.view) continue
    const otherColumns = new Map(other.columns.map((c) => [c.name.toLowerCase(), c]))
    const ownColumns = new Map(t.columns.map((c) => [c.name.toLowerCase(), c]))
    for (const c of t.columns) {
      const there = otherColumns.get(c.name.toLowerCase())
      if (!there) {
        push({
          kind: 'column-added',
          table: t.name,
          column: c.name,
          summary: `${t.name}.${c.name} (${c.type}${c.nullable ? '' : ', not null'}) is missing in the target`,
          statements: script(addColumn(d, schema, t.name, c)),
          destructive: false,
        })
      } else if (norm(there.type) !== norm(c.type) || there.nullable !== c.nullable) {
        const parts = [
          norm(there.type) !== norm(c.type) ? `type ${there.type} → ${c.type}` : null,
          there.nullable !== c.nullable ? (c.nullable ? 'allows NULL' : 'not null') : null,
        ].filter(Boolean)
        push({
          kind: 'column-changed',
          table: t.name,
          column: c.name,
          summary: `${t.name}.${c.name}: ${parts.join(', ')}`,
          statements: script(...alterColumn(d, schema, t.name, there, c)),
          destructive: false,
        })
      }
    }
    for (const c of other.columns) {
      if (!ownColumns.has(c.name.toLowerCase())) {
        push({
          kind: 'column-removed',
          table: t.name,
          column: c.name,
          summary: `${t.name}.${c.name} is only in the target`,
          statements: script(dropColumn(d, schema, t.name, c.name)),
          destructive: true,
        })
      }
    }
  }
  for (const t of target.tables) {
    if (sourceTables.has(t.name.toLowerCase())) continue
    push({
      kind: 'table-removed',
      table: t.name,
      summary: `${t.view ? 'View' : 'Table'} ${t.name} is only in the target`,
      statements: script(dropTable(d, schema, t.name, t.view)),
      destructive: true,
    })
  }

  const targetKeys = new Map(target.foreignKeys.map((k) => [keyId(k), k]))
  const sourceKeys = new Map(source.foreignKeys.map((k) => [keyId(k), k]))
  for (const k of source.foreignKeys) {
    if (targetKeys.has(keyId(k))) continue
    // A key of a table that is created whole already comes with the rest of it, below.
    push({
      kind: 'key-added',
      table: k.table,
      column: k.column,
      summary: `Foreign key ${k.table}.${k.column} → ${k.refTable}.${k.refColumn} is missing in the target`,
      statements: script(
        `ALTER TABLE ${info.qualified(schema, k.table)} ADD CONSTRAINT ${info.quote(keyName(k))} FOREIGN KEY (${info.quote(k.column)}) REFERENCES ${info.qualified(k.refSchema || schema, k.refTable)} (${info.quote(k.refColumn)});`,
      ),
      destructive: false,
    })
  }
  for (const k of target.foreignKeys) {
    if (sourceKeys.has(keyId(k))) continue
    push({
      kind: 'key-removed',
      table: k.table,
      column: k.column,
      summary: `Foreign key ${k.table}.${k.column} → ${k.refTable}.${k.refColumn} is only in the target`,
      statements: script(
        dialect === 'mysql'
          ? `ALTER TABLE ${info.qualified(schema, k.table)} DROP FOREIGN KEY ${info.quote(keyName(k))};`
          : `ALTER TABLE ${info.qualified(schema, k.table)} DROP CONSTRAINT ${info.quote(keyName(k))};`,
      ),
      destructive: true,
    })
  }
  // Tables first, then columns, then keys, so a script can run top to bottom.
  const order: Record<DiffKind, number> = {
    'table-added': 0,
    'column-added': 1,
    'column-changed': 2,
    'key-added': 3,
    'key-removed': 4,
    'column-removed': 5,
    'table-removed': 6,
  }
  return changes.sort((a, b) => order[a.kind] - order[b.kind] || a.table.localeCompare(b.table))
}

/** The chosen changes as one script, a comment above each so it reads as a list of what it does. */
export function scriptOf(changes: readonly SchemaChange[]): string {
  return changes
    .filter((c) => c.statements.length > 0)
    .map(
      (c) => `-- ${c.summary}${c.destructive ? ' (removes data)' : ''}\n${c.statements.join('\n')}`,
    )
    .join('\n\n')
}
