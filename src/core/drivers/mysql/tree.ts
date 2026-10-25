import type { TreeNode } from '@shared/driver'

/** Runs a metadata query and returns rows as arrays. */
export type MetaQuery = (sql: string, values?: unknown[]) => Promise<unknown[][]>

const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])

export const isSystemSchema = (name: string): boolean => SYSTEM_SCHEMAS.has(name.toLowerCase())

/**
 * Node ids are JSON arrays: `["table", "shop", "orders"]`. Self-describing, so `children()` needs
 * no lookup table and an id means the same thing after a reconnect.
 */
export const nodeId = (...parts: string[]): string => JSON.stringify(parts)

function parseId(id: string): string[] {
  try {
    const parts: unknown = JSON.parse(id)
    if (Array.isArray(parts) && parts.every((p) => typeof p === 'string')) return parts as string[]
  } catch {
    // fall through
  }
  throw new Error(`Unknown tree node "${id}"`)
}

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value))
const num = (value: unknown): number => Number(value ?? 0)

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

export function formatCount(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}K`
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`
}

const GROUPS = [
  { key: 'tables', label: 'Tables' },
  { key: 'views', label: 'Views' },
  { key: 'routines', label: 'Routines' },
  { key: 'triggers', label: 'Triggers' },
  { key: 'events', label: 'Events' },
] as const

async function roots(query: MetaQuery): Promise<TreeNode[]> {
  const rows = await query(
    'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
  )
  const names = rows.map((row) => str(row[0]))
  const user = names.filter((name) => !isSystemSchema(name))
  const system = names.filter(isSystemSchema)

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

function systemSchemas(): TreeNode[] {
  return [...SYSTEM_SCHEMAS].sort().map((name) => ({
    id: nodeId('database', name),
    label: name,
    kind: 'database',
    hasChildren: true,
    scope: name,
  }))
}

async function databaseGroups(query: MetaQuery, database: string): Promise<TreeNode[]> {
  const [counts] = await query(
    `SELECT
       (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'),
       (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'VIEW'),
       (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?),
       (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?),
       (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?)`,
    [database, database, database, database, database],
  )
  return GROUPS.flatMap((group, index) => {
    const count = num(counts?.[index])
    // Tables always show, so an empty schema doesn't look broken; other groups only when used.
    if (count === 0 && group.key !== 'tables') return []
    return [
      {
        id: nodeId('group', database, group.key),
        label: group.label,
        kind: 'group',
        hasChildren: count > 0,
        detail: String(count),
        scope: database,
      },
    ]
  })
}

async function tables(query: MetaQuery, database: string): Promise<TreeNode[]> {
  const rows = await query(
    `SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME`,
    [database],
  )
  return rows.map((row) => {
    const estimate = row[1] === null ? null : num(row[1])
    const size = num(row[2]) + num(row[3])
    const parts = [
      estimate === null ? null : `~${formatCount(estimate)} rows`,
      size > 0 ? formatBytes(size) : null,
    ].filter(Boolean)
    return {
      id: nodeId('table', database, str(row[0])),
      label: str(row[0]),
      kind: 'table',
      hasChildren: true,
      ...(parts.length > 0 ? { detail: parts.join(' · ') } : {}),
      scope: database,
    }
  })
}

async function views(query: MetaQuery, database: string): Promise<TreeNode[]> {
  const rows = await query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'VIEW' ORDER BY TABLE_NAME`,
    [database],
  )
  return rows.map((row) => ({
    id: nodeId('view', database, str(row[0])),
    label: str(row[0]),
    kind: 'view',
    hasChildren: true,
    scope: database,
  }))
}

async function routines(query: MetaQuery, database: string): Promise<TreeNode[]> {
  const rows = await query(
    `SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES
      WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`,
    [database],
  )
  return rows.map((row) => {
    const type = str(row[1]).toLowerCase()
    return {
      id: nodeId(type, database, str(row[0])),
      label: str(row[0]),
      kind: type === 'function' ? 'function' : 'procedure',
      hasChildren: false,
      detail: type,
      scope: database,
    }
  })
}

async function triggers(query: MetaQuery, database: string): Promise<TreeNode[]> {
  const rows = await query(
    `SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, EVENT_OBJECT_TABLE
       FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`,
    [database],
  )
  return rows.map((row) => ({
    id: nodeId('trigger', database, str(row[0])),
    label: str(row[0]),
    kind: 'trigger',
    hasChildren: false,
    detail: `${str(row[1])} ${str(row[2])} on ${str(row[3])}`.toLowerCase(),
    scope: database,
  }))
}

async function events(query: MetaQuery, database: string): Promise<TreeNode[]> {
  const rows = await query(
    `SELECT EVENT_NAME, STATUS FROM information_schema.EVENTS
      WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME`,
    [database],
  )
  return rows.map((row) => ({
    id: nodeId('event', database, str(row[0])),
    label: str(row[0]),
    kind: 'event',
    hasChildren: false,
    detail: str(row[1]).toLowerCase(),
    scope: database,
  }))
}

async function columns(
  query: MetaQuery,
  database: string,
  table: string,
  withGroups: boolean,
): Promise<TreeNode[]> {
  const rows = await query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [database, table],
  )
  const nodes: TreeNode[] = rows.map((row) => {
    const flags = [
      str(row[3]) === 'PRI' ? 'PK' : null,
      str(row[3]) === 'UNI' ? 'unique' : null,
      str(row[2]) === 'NO' ? 'not null' : null,
      str(row[4]).includes('auto_increment') ? 'auto' : null,
    ].filter(Boolean)
    return {
      id: nodeId('column', database, table, str(row[0])),
      label: str(row[0]),
      kind: 'column',
      hasChildren: false,
      detail: [str(row[1]), ...flags].join(' · '),
      scope: database,
    }
  })
  if (withGroups) {
    nodes.push(
      {
        id: nodeId('group', database, 'indexes', table),
        label: 'Indexes',
        kind: 'group',
        hasChildren: true,
        scope: database,
      },
      {
        id: nodeId('group', database, 'foreignKeys', table),
        label: 'Foreign keys',
        kind: 'group',
        hasChildren: true,
        scope: database,
      },
    )
  }
  return nodes
}

async function indexes(query: MetaQuery, database: string, table: string): Promise<TreeNode[]> {
  const rows = await query(
    `SELECT INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', ')
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      GROUP BY INDEX_NAME, NON_UNIQUE ORDER BY INDEX_NAME`,
    [database, table],
  )
  return rows.map((row) => ({
    id: nodeId('index', database, table, str(row[0])),
    label: str(row[0]),
    kind: 'index',
    hasChildren: false,
    detail: `${num(row[1]) === 0 ? 'unique ' : ''}(${str(row[2])})`,
    scope: database,
  }))
}

async function foreignKeys(query: MetaQuery, database: string, table: string): Promise<TreeNode[]> {
  const rows = await query(
    `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
    [database, table],
  )
  const byConstraint = new Map<string, { from: string[]; to: string[]; target: string }>()
  for (const row of rows) {
    const name = str(row[0])
    const entry = byConstraint.get(name) ?? {
      from: [],
      to: [],
      target: str(row[2]) === database ? str(row[3]) : `${str(row[2])}.${str(row[3])}`,
    }
    entry.from.push(str(row[1]))
    entry.to.push(str(row[4]))
    byConstraint.set(name, entry)
  }
  return [...byConstraint].map(([name, fk]) => ({
    id: nodeId('foreignKey', database, table, name),
    label: name,
    kind: 'foreignKey',
    hasChildren: false,
    detail: `${fk.from.join(', ')} → ${fk.target}(${fk.to.join(', ')})`,
    scope: database,
  }))
}

/** The tree below `parent`, or the roots when `parent` is null. */
export async function treeChildren(query: MetaQuery, parent: TreeNode | null): Promise<TreeNode[]> {
  if (!parent) return roots(query)

  const [kind, database = '', name = '', extra = ''] = parseId(parent.id)
  switch (kind) {
    case 'system':
      return systemSchemas()
    case 'database':
      return databaseGroups(query, database)
    case 'group':
      switch (name) {
        case 'tables':
          return tables(query, database)
        case 'views':
          return views(query, database)
        case 'routines':
          return routines(query, database)
        case 'triggers':
          return triggers(query, database)
        case 'events':
          return events(query, database)
        case 'indexes':
          return indexes(query, database, extra)
        case 'foreignKeys':
          return foreignKeys(query, database, extra)
      }
      return []
    case 'table':
      return columns(query, database, name, true)
    case 'view':
      return columns(query, database, name, false)
    default:
      return []
  }
}
