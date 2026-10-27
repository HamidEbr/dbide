import type { SchemaDetail, SchemaTable, TableColumns, TreeNode } from '@shared/driver'
import type { TableDescription } from '@shared/edit'
import { groupForeignKeys, groupReferencingKeys } from '../mysql/foreign-keys'
import { formatBytes, formatCount, nodeId, parseId } from '../mysql/tree'

/** Runs a catalog query with `$1`-style values and returns rows as arrays. */
export type MetaQuery = (sql: string, values?: unknown[]) => Promise<unknown[][]>

const SYSTEM = ['information_schema', 'pg_catalog', 'pg_toast']
const isSystem = (name: string): boolean => SYSTEM.includes(name) || name.startsWith('pg_')

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value))
const num = (value: unknown): number => Number(value ?? 0)

/** A schema is what this app calls a database for PostgreSQL: the tree lists the schemas of the connected database. */
export async function schemaNames(query: MetaQuery): Promise<string[]> {
  const rows = await query(
    `SELECT nspname FROM pg_namespace
      WHERE nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%'
      ORDER BY nspname`,
  )
  return rows.map((r) => str(r[0]))
}

async function roots(query: MetaQuery): Promise<TreeNode[]> {
  const names = await schemaNames(query)
  const user = names.filter((n) => !isSystem(n))
  const system = names.filter(isSystem)
  const nodes: TreeNode[] = user.map((name) => ({
    id: nodeId('database', name),
    label: name,
    kind: 'database',
    hasChildren: true,
    scope: name,
  }))
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
    `SELECT
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')),
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('v', 'm')),
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.prokind IN ('f', 'p'))`,
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
    `SELECT c.relname, c.reltuples::bigint, pg_total_relation_size(c.oid)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') ORDER BY c.relname`,
    [schema],
  )
  return rows.map((row) => {
    const estimate = num(row[1])
    const size = num(row[2])
    const parts = [
      estimate >= 0 ? `~${formatCount(estimate)} rows` : null,
      size > 0 ? formatBytes(size) : null,
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
    `SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('v', 'm') ORDER BY c.relname`,
    [schema],
  )
  return rows.map((row) => ({
    id: nodeId('view', schema, str(row[0])),
    label: str(row[0]),
    kind: 'view',
    hasChildren: true,
    ...(str(row[1]) === 'm' ? { detail: 'materialized' } : {}),
    scope: schema,
  }))
}

async function routines(query: MetaQuery, schema: string): Promise<TreeNode[]> {
  const rows = await query(
    `SELECT p.proname, p.prokind, pg_get_function_identity_arguments(p.oid)
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') ORDER BY p.proname`,
    [schema],
  )
  return rows.map((row) => {
    const procedure = str(row[1]) === 'p'
    return {
      id: nodeId(procedure ? 'procedure' : 'function', schema, str(row[0]), str(row[2])),
      label: str(row[0]),
      kind: procedure ? 'procedure' : 'function',
      hasChildren: false,
      detail: `(${str(row[2])})`,
      scope: schema,
    }
  })
}

async function columns(
  query: MetaQuery,
  schema: string,
  table: string,
  withGroups: boolean,
): Promise<TreeNode[]> {
  const rows = await query(
    `SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
            COALESCE(i.indisprimary, false), a.attidentity <> '' OR a.atthasdef
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, table],
  )
  const nodes: TreeNode[] = rows.map((row) => ({
    id: nodeId('column', schema, table, str(row[0])),
    label: str(row[0]),
    kind: 'column',
    hasChildren: false,
    detail: [
      str(row[1]),
      row[3] === true ? 'PK' : null,
      row[2] === true ? 'not null' : null,
      row[4] === true ? 'default' : null,
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
    `SELECT ic.relname, i.indisunique, pg_get_indexdef(i.indexrelid)
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 ORDER BY ic.relname`,
    [schema, table],
  )
  return rows.map((row) => {
    const definition = str(row[2])
    const columns = /\((.*)\)/.exec(definition)?.[1] ?? ''
    return {
      id: nodeId('index', schema, table, str(row[0])),
      label: str(row[0]),
      kind: 'index',
      hasChildren: false,
      detail: `${row[1] === true ? 'unique ' : ''}(${columns})`,
      scope: schema,
    }
  })
}

/** Rows of a foreign key's columns: constraint, column, referenced schema, table and column, in key order. */
const FOREIGN_KEY_ROWS = `
  SELECT con.conname, a.attname, rn.nspname, rcl.relname, ra.attname, cl.relname
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_class rcl ON rcl.oid = con.confrelid
    JOIN pg_namespace rn ON rn.oid = rcl.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k (attnum, refattnum, ord)
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
    JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refattnum
   WHERE con.contype = 'f' AND n.nspname = $1 AND cl.relname = ANY ($2)
   ORDER BY cl.relname, con.conname, k.ord`

async function foreignKeys(query: MetaQuery, schema: string, table: string): Promise<TreeNode[]> {
  const rows = await query(FOREIGN_KEY_ROWS, [schema, [table]])
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

// ───────── What autocomplete, the diagram and the editor read ─────────

export async function schemaDetail(query: MetaQuery, schema: string): Promise<SchemaDetail> {
  const rows = await query(
    `SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ORDER BY c.relname`,
    [schema],
  )
  return {
    database: schema,
    tables: rows.map(([name, kind]) => ({
      name: str(name),
      view: str(kind) === 'v' || str(kind) === 'm',
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
  const columnRows = await query(
    `SELECT c.relname, c.relkind, obj_description(c.oid, 'pg_class'), a.attname,
            format_type(a.atttypid, a.atttypmod), a.attnotnull,
            COALESCE(pk.indisprimary, false),
            EXISTS (SELECT 1 FROM pg_index u WHERE u.indrelid = c.oid AND u.indisunique
                     AND NOT u.indisprimary AND u.indnatts = 1 AND a.attnum = ANY (u.indkey)),
            EXISTS (SELECT 1 FROM pg_index m WHERE m.indrelid = c.oid AND a.attnum = m.indkey[0]
                     AND NOT m.indisunique),
            col_description(c.oid, a.attnum)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       LEFT JOIN pg_index pk ON pk.indrelid = c.oid AND pk.indisprimary AND a.attnum = ANY (pk.indkey)
      WHERE n.nspname = $1 AND c.relname = ANY ($2) ORDER BY c.relname, a.attnum`,
    [schema, names],
  )
  const keyRows = await query(FOREIGN_KEY_ROWS, [schema, names])
  const tables = new Map<string, SchemaTable>()
  for (const [
    table,
    kind,
    comment,
    name,
    type,
    notNull,
    primary,
    unique,
    indexed,
    colComment,
  ] of columnRows) {
    let t = tables.get(str(table))
    if (!t) {
      t = {
        name: str(table),
        view: str(kind) === 'v' || str(kind) === 'm',
        comment: str(comment),
        columns: [],
      }
      tables.set(str(table), t)
    }
    t.columns.push({
      name: str(name),
      type: str(type),
      nullable: notNull !== true,
      key: primary === true ? 'PRI' : unique === true ? 'UNI' : indexed === true ? 'MUL' : '',
      comment: str(colComment),
    })
  }
  const foreignKeys = keyRows.map(([, column, refSchema, refTable, refColumn, table]) => ({
    table: str(table),
    column: str(column),
    refSchema: str(refSchema),
    refTable: str(refTable),
    refColumn: str(refColumn),
  }))
  return { tables: [...tables.values()], foreignKeys }
}

export async function describeTable(
  query: MetaQuery,
  schema: string,
  table: string,
): Promise<TableDescription> {
  const columns = await query(
    `SELECT a.attname, format_type(a.atttypid, a.atttypmod), t.typname, a.attnotnull,
            a.attidentity <> '' OR pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%',
            a.attgenerated <> ''
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t ON t.oid = a.atttypid
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, table],
  )
  if (columns.length === 0) throw new Error(`Table ${schema}.${table} was not found.`)
  const key = await query(
    `SELECT a.attname FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k (attnum, ord)
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2 ORDER BY k.ord`,
    [schema, table],
  )
  const pointsTo = await query(FOREIGN_KEY_ROWS, [schema, [table]])
  const pointedAtBy = await query(
    `SELECT con.conname, n.nspname, cl.relname, a.attname, ra.attname
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
       JOIN pg_class rcl ON rcl.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rcl.relnamespace
       CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k (attnum, refattnum, ord)
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
       JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refattnum
      WHERE con.contype = 'f' AND rn.nspname = $1 AND rcl.relname = $2
      ORDER BY n.nspname, cl.relname, con.conname, k.ord`,
    [schema, table],
  ).catch(() => null)
  return {
    schema,
    table,
    foreignKeys: groupForeignKeys(pointsTo),
    ...(pointedAtBy ? { referencedBy: groupReferencingKeys(pointedAtBy) } : {}),
    columns: columns.map((row) => ({
      name: str(row[0]),
      type: str(row[2]),
      columnType: str(row[1]),
      nullable: row[3] !== true,
      autoIncrement: row[4] === true,
      generated: row[5] === true,
    })),
    primaryKey: key.map((row) => str(row[0])),
  }
}
