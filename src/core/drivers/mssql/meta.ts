import type { SchemaDetail, SchemaTable, TableColumns, TreeNode } from '@shared/driver'
import type { TableDescription } from '@shared/edit'
import { groupForeignKeys, groupReferencingKeys } from '../mysql/foreign-keys'
import { formatBytes, formatCount, nodeId, parseId } from '../mysql/tree'
import { formatType } from './types'

/** Runs a catalog query with `@p1`-style values and returns rows as arrays. */
export type MetaQuery = (sql: string, values?: unknown[]) => Promise<unknown[][]>

const SYSTEM = ['sys', 'INFORMATION_SCHEMA']
const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value))
const num = (value: unknown): number => Number(value ?? 0)

/** `@p2, @p3, …` for a list of values that follow the first parameter. */
const list = (count: number, from = 2): string =>
  Array.from({ length: count }, (_, i) => `@p${from + i}`).join(', ')

export async function schemaNames(query: MetaQuery): Promise<string[]> {
  const rows = await query(
    `SELECT name FROM sys.schemas WHERE name NOT LIKE 'db[_]%' AND name <> 'guest' ORDER BY name`,
  )
  return rows.map((r) => str(r[0]))
}

async function roots(query: MetaQuery): Promise<TreeNode[]> {
  const names = await schemaNames(query)
  const user = names.filter((n) => !SYSTEM.includes(n))
  const nodes: TreeNode[] = user.map((name) => ({
    id: nodeId('database', name),
    label: name,
    kind: 'database',
    hasChildren: true,
    scope: name,
  }))
  const system = names.filter((n) => SYSTEM.includes(n))
  if (system.length > 0) {
    nodes.push({
      id: nodeId('system'),
      label: 'System schemas',
      kind: 'group',
      hasChildren: true,
      detail: String(system.length),
    })
  }
  return nodes
}

const GROUPS = [
  { key: 'tables', label: 'Tables' },
  { key: 'views', label: 'Views' },
  { key: 'routines', label: 'Routines' },
] as const

async function schemaGroups(query: MetaQuery, schema: string): Promise<TreeNode[]> {
  const [counts] = await query(
    `SELECT (SELECT COUNT(*) FROM sys.tables WHERE schema_id = SCHEMA_ID(@p1)),
            (SELECT COUNT(*) FROM sys.views WHERE schema_id = SCHEMA_ID(@p1)),
            (SELECT COUNT(*) FROM sys.objects WHERE schema_id = SCHEMA_ID(@p1) AND type IN ('P', 'FN', 'IF', 'TF'))`,
    [schema],
  )
  return GROUPS.flatMap((group, i) => {
    const count = num(counts?.[i])
    if (count === 0 && group.key !== 'tables') return []
    return [
      {
        id: nodeId('group', schema, group.key),
        label: group.label,
        kind: 'group',
        hasChildren: count > 0,
        detail: String(count),
        scope: schema,
      },
    ]
  })
}

async function tables(query: MetaQuery, schema: string): Promise<TreeNode[]> {
  const rows = await query(
    `SELECT t.name,
            SUM(CASE WHEN p.index_id IN (0, 1) THEN p.rows ELSE 0 END),
            SUM(a.total_pages) * 8192
       FROM sys.tables t
       JOIN sys.partitions p ON p.object_id = t.object_id
       JOIN sys.allocation_units a ON a.container_id = p.partition_id
      WHERE t.schema_id = SCHEMA_ID(@p1) GROUP BY t.name ORDER BY t.name`,
    [schema],
  ).catch(() => null)
  const sized =
    rows ??
    (await query(
      `SELECT name, NULL, NULL FROM sys.tables WHERE schema_id = SCHEMA_ID(@p1) ORDER BY name`,
      [schema],
    ))
  return sized.map((row) => {
    const parts = [
      row[1] === null ? null : `~${formatCount(num(row[1]))} rows`,
      num(row[2]) > 0 ? formatBytes(num(row[2])) : null,
    ].filter(Boolean)
    return {
      id: nodeId('table', schema, str(row[0])),
      label: str(row[0]),
      kind: 'table',
      hasChildren: true,
      ...(parts.length > 0 ? { detail: parts.join(' · ') } : {}),
      scope: schema,
    }
  })
}

async function views(query: MetaQuery, schema: string): Promise<TreeNode[]> {
  const rows = await query(
    'SELECT name FROM sys.views WHERE schema_id = SCHEMA_ID(@p1) ORDER BY name',
    [schema],
  )
  return rows.map((row) => ({
    id: nodeId('view', schema, str(row[0])),
    label: str(row[0]),
    kind: 'view',
    hasChildren: true,
    scope: schema,
  }))
}

async function routines(query: MetaQuery, schema: string): Promise<TreeNode[]> {
  const rows = await query(
    `SELECT name, type FROM sys.objects
      WHERE schema_id = SCHEMA_ID(@p1) AND type IN ('P', 'FN', 'IF', 'TF') ORDER BY name`,
    [schema],
  )
  return rows.map((row) => {
    const procedure = str(row[1]).trim() === 'P'
    return {
      id: nodeId(procedure ? 'procedure' : 'function', schema, str(row[0])),
      label: str(row[0]),
      kind: procedure ? 'procedure' : 'function',
      hasChildren: false,
      scope: schema,
    }
  })
}

/** The columns of tables and views, with what marks a key. `@p1` is the schema; the names follow. */
function columnSql(names: number): string {
  return `SELECT o.name, o.type, c.name, ty.name, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity,
            CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i
                    ON i.object_id = ic.object_id AND i.index_id = ic.index_id AND i.is_primary_key = 1
                   WHERE ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END,
            CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i
                    ON i.object_id = ic.object_id AND i.index_id = ic.index_id AND i.is_unique = 1 AND i.is_primary_key = 0
                   WHERE ic.object_id = c.object_id AND ic.column_id = c.column_id AND ic.key_ordinal = 1) THEN 1 ELSE 0 END,
            CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i
                    ON i.object_id = ic.object_id AND i.index_id = ic.index_id AND i.is_unique = 0
                   WHERE ic.object_id = c.object_id AND ic.column_id = c.column_id AND ic.key_ordinal = 1) THEN 1 ELSE 0 END,
            c.is_computed
       FROM sys.objects o
       JOIN sys.columns c ON c.object_id = o.object_id
       JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      WHERE o.schema_id = SCHEMA_ID(@p1) AND o.type IN ('U', 'V') AND o.name IN (${list(names)})
      ORDER BY o.name, c.column_id`
}

async function columns(
  query: MetaQuery,
  schema: string,
  table: string,
  withGroups: boolean,
): Promise<TreeNode[]> {
  const rows = await query(columnSql(1), [schema, table])
  const nodes: TreeNode[] = rows.map((row) => ({
    id: nodeId('column', schema, table, str(row[2])),
    label: str(row[2]),
    kind: 'column',
    hasChildren: false,
    detail: [
      formatType(str(row[3]), num(row[4]), num(row[5]), num(row[6])),
      num(row[9]) === 1 ? 'PK' : null,
      row[7] === false || num(row[7]) === 0 ? 'not null' : null,
      row[8] === true || num(row[8]) === 1 ? 'identity' : null,
    ]
      .filter(Boolean)
      .join(' · '),
    scope: schema,
  }))
  if (withGroups) {
    nodes.push(
      {
        id: nodeId('group', schema, 'indexes', table),
        label: 'Indexes',
        kind: 'group',
        hasChildren: true,
        scope: schema,
      },
      {
        id: nodeId('group', schema, 'foreignKeys', table),
        label: 'Foreign keys',
        kind: 'group',
        hasChildren: true,
        scope: schema,
      },
    )
  }
  return nodes
}

async function indexes(query: MetaQuery, schema: string, table: string): Promise<TreeNode[]> {
  const rows = await query(
    `SELECT i.name, i.is_unique, STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal)
       FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE i.object_id = OBJECT_ID(@p1) AND i.name IS NOT NULL
      GROUP BY i.name, i.is_unique ORDER BY i.name`,
    [`[${schema.replace(/]/g, ']]')}].[${table.replace(/]/g, ']]')}]`],
  )
  return rows.map((row) => ({
    id: nodeId('index', schema, table, str(row[0])),
    label: str(row[0]),
    kind: 'index',
    hasChildren: false,
    detail: `${row[1] === true || num(row[1]) === 1 ? 'unique ' : ''}(${str(row[2])})`,
    scope: schema,
  }))
}

/** Rows of foreign key columns: constraint, column, referenced schema, table, column, and the table that holds it. */
function foreignKeySql(names: number): string {
  return `SELECT fk.name, pc.name, SCHEMA_NAME(rt.schema_id), rt.name, rc.name, pt.name
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
       JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
       JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
       JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      WHERE pt.schema_id = SCHEMA_ID(@p1) AND pt.name IN (${list(names)})
      ORDER BY pt.name, fk.name, fkc.constraint_column_id`
}

async function foreignKeys(query: MetaQuery, schema: string, table: string): Promise<TreeNode[]> {
  const rows = await query(foreignKeySql(1), [schema, table])
  return groupForeignKeys(rows).map((fk) => ({
    id: nodeId('foreignKey', schema, table, fk.name),
    label: fk.name,
    kind: 'foreignKey',
    hasChildren: false,
    detail: `${fk.columns.join(', ')} → ${fk.refSchema === schema ? '' : `${fk.refSchema}.`}${fk.refTable}(${fk.refColumns.join(', ')})`,
    scope: schema,
  }))
}

export async function treeChildren(query: MetaQuery, parent: TreeNode | null): Promise<TreeNode[]> {
  if (!parent) return roots(query)
  const [kind, schema = '', name = '', extra = ''] = parseId(parent.id)
  switch (kind) {
    case 'system':
      return SYSTEM.map((n) => ({
        id: nodeId('database', n),
        label: n,
        kind: 'database',
        hasChildren: true,
        scope: n,
      }))
    case 'database':
      return schemaGroups(query, schema)
    case 'group':
      switch (name) {
        case 'tables':
          return tables(query, schema)
        case 'views':
          return views(query, schema)
        case 'routines':
          return routines(query, schema)
        case 'indexes':
          return indexes(query, schema, extra)
        case 'foreignKeys':
          return foreignKeys(query, schema, extra)
      }
      return []
    case 'table':
      return columns(query, schema, name, true)
    case 'view':
      return columns(query, schema, name, false)
    default:
      return []
  }
}

export async function schemaDetail(query: MetaQuery, schema: string): Promise<SchemaDetail> {
  const rows = await query(
    `SELECT name, type FROM sys.objects
      WHERE schema_id = SCHEMA_ID(@p1) AND type IN ('U', 'V') ORDER BY name`,
    [schema],
  )
  return {
    database: schema,
    tables: rows.map(([name, type]) => ({
      name: str(name),
      view: str(type).trim() === 'V',
      comment: '',
      columns: [],
    })),
    foreignKeys: [],
  }
}

export async function tableColumns(
  query: MetaQuery,
  schema: string,
  names: string[],
): Promise<TableColumns> {
  const rows = await query(columnSql(names.length), [schema, ...names])
  const keys = await query(foreignKeySql(names.length), [schema, ...names])
  const tables = new Map<string, SchemaTable>()
  for (const row of rows) {
    const table = str(row[0])
    let t = tables.get(table)
    if (!t) {
      t = { name: table, view: str(row[1]).trim() === 'V', comment: '', columns: [] }
      tables.set(table, t)
    }
    t.columns.push({
      name: str(row[2]),
      type: formatType(str(row[3]), num(row[4]), num(row[5]), num(row[6])),
      nullable: row[7] === true || num(row[7]) === 1,
      key: num(row[9]) === 1 ? 'PRI' : num(row[10]) === 1 ? 'UNI' : num(row[11]) === 1 ? 'MUL' : '',
      comment: '',
    })
  }
  return {
    tables: [...tables.values()],
    foreignKeys: keys.map(([, column, refSchema, refTable, refColumn, table]) => ({
      table: str(table),
      column: str(column),
      refSchema: str(refSchema),
      refTable: str(refTable),
      refColumn: str(refColumn),
    })),
  }
}

export async function describeTable(
  query: MetaQuery,
  schema: string,
  table: string,
): Promise<TableDescription> {
  const columnRows = await query(columnSql(1), [schema, table])
  if (columnRows.length === 0) throw new Error(`Table ${schema}.${table} was not found.`)
  const pointsTo = await query(foreignKeySql(1), [schema, table])
  const pointedAtBy = await query(
    `SELECT fk.name, SCHEMA_NAME(pt.schema_id), pt.name, pc.name, rc.name
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
       JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
       JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
       JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      WHERE rt.schema_id = SCHEMA_ID(@p1) AND rt.name = @p2
      ORDER BY pt.name, fk.name, fkc.constraint_column_id`,
    [schema, table],
  ).catch(() => null)
  const key = await query(
    `SELECT c.name FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE i.is_primary_key = 1 AND i.object_id = OBJECT_ID(@p1) ORDER BY ic.key_ordinal`,
    [`[${schema.replace(/]/g, ']]')}].[${table.replace(/]/g, ']]')}]`],
  )
  return {
    schema,
    table,
    foreignKeys: groupForeignKeys(pointsTo),
    ...(pointedAtBy ? { referencedBy: groupReferencingKeys(pointedAtBy) } : {}),
    columns: columnRows.map((row) => ({
      name: str(row[2]),
      type: str(row[3]).toLowerCase(),
      columnType: formatType(str(row[3]), num(row[4]), num(row[5]), num(row[6])),
      nullable: row[7] === true || num(row[7]) === 1,
      autoIncrement: row[8] === true || num(row[8]) === 1,
      generated: row[12] === true || num(row[12]) === 1,
    })),
    primaryKey: key.map((row) => str(row[0])),
  }
}
