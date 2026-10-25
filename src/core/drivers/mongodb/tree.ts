import type { Db, Document, MongoClient } from 'mongodb'
import type { TreeNode } from '@shared/driver'
import { formatBytes, formatCount, nodeId } from '../mysql/tree'
import { plainNumber } from './bson'

const SYSTEM_DATABASES = new Set(['admin', 'local', 'config'])

export const isSystemDatabase = (name: string): boolean => SYSTEM_DATABASES.has(name)

/** How many collections get a document count in the tree. Past this the tree just lists them. */
const COUNT_LIMIT = 150
const COUNT_CONCURRENCY = 8

/** Node ids are JSON arrays of strings, as for MySQL: `["collection", "shop", "orders"]`. */
export function parseNodeId(id: string): string[] {
  try {
    const parts: unknown = JSON.parse(id)
    if (Array.isArray(parts) && parts.every((p) => typeof p === 'string')) return parts as string[]
  } catch {
    // fall through
  }
  throw new Error(`Unknown tree node "${id}"`)
}

const isUnauthorized = (error: unknown): boolean => {
  const e = error as { code?: unknown; codeName?: unknown } | null
  return (
    e?.codeName === 'Unauthorized' ||
    (e?.code !== undefined && e.code !== null && plainNumber(e.code) === 13)
  )
}

function databaseNode(name: string, sizeOnDisk: unknown, empty: unknown): TreeNode {
  const size = Number(sizeOnDisk ?? 0)
  return {
    id: nodeId('database', name),
    label: name,
    kind: 'database',
    hasChildren: true,
    detail: empty === true || size === 0 ? 'empty' : formatBytes(size),
    scope: name,
  }
}

async function roots(
  client: MongoClient,
  defaultDatabase: string | undefined,
  signal: AbortSignal,
): Promise<TreeNode[]> {
  let listed: Document[]
  try {
    const reply = await client
      .db('admin')
      .command({ listDatabases: 1, authorizedDatabases: true }, {
        promoteValues: true,
        signal,
      } as never)
    listed = reply.databases as Document[]
  } catch (error) {
    // A login that may only see its own database can't list the rest; open the one it named.
    if (isUnauthorized(error) && defaultDatabase) {
      return [databaseNode(defaultDatabase, 0, false)]
    }
    throw error
  }

  const sorted = [...listed].sort((a, b) => String(a.name).localeCompare(String(b.name)))
  const user = sorted.filter((d) => !isSystemDatabase(String(d.name)))
  const system = sorted.filter((d) => isSystemDatabase(String(d.name)))
  const nodes = user.map((d) => databaseNode(String(d.name), d.sizeOnDisk, d.empty))
  if (system.length > 0) {
    nodes.push({
      id: nodeId('system'),
      label: 'System databases',
      kind: 'group',
      hasChildren: true,
      detail: String(system.length),
    })
  }
  return nodes
}

async function counts(db: Db, names: string[], signal: AbortSignal): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < names.length && !signal.aborted) {
      const name = names[next++]!
      try {
        result.set(name, await db.collection(name).estimatedDocumentCount({ signal } as never))
      } catch {
        // No count for this one (no permission, or it is being dropped).
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(COUNT_CONCURRENCY, names.length) }, worker))
  return result
}

async function collections(
  client: MongoClient,
  database: string,
  signal: AbortSignal,
): Promise<TreeNode[]> {
  const db = client.db(database)
  const infos = await db
    .listCollections({}, { nameOnly: false, promoteValues: true, signal } as never)
    .toArray()
  const sorted = [...infos].sort((a, b) => {
    const aSystem = String(a.name).startsWith('system.')
    const bSystem = String(b.name).startsWith('system.')
    return aSystem === bSystem ? String(a.name).localeCompare(String(b.name)) : aSystem ? 1 : -1
  })

  const real = sorted.filter((info) => info.type !== 'view').map((info) => String(info.name))
  const documentCounts =
    real.length <= COUNT_LIMIT ? await counts(db, real, signal) : new Map<string, number>()

  return sorted.map((info): TreeNode => {
    const name = String(info.name)
    const isView = info.type === 'view'
    const count = documentCounts.get(name)
    return {
      id: nodeId(isView ? 'view' : 'collection', database, name),
      label: name,
      kind: isView ? 'view' : 'collection',
      hasChildren: !isView,
      ...(isView
        ? { detail: 'view' }
        : count !== undefined
          ? {
              detail:
                info.type === 'timeseries'
                  ? `time series · ${formatCount(count)}`
                  : formatCount(count),
            }
          : info.type === 'timeseries'
            ? { detail: 'time series' }
            : {}),
      scope: database,
    }
  })
}

function describeKeys(key: Document): string {
  return Object.entries(key)
    .map(([field, direction]) => {
      const value = Number(direction)
      return value === 1
        ? `${field} ↑`
        : value === -1
          ? `${field} ↓`
          : `${field} ${String(direction)}`
    })
    .join(', ')
}

async function indexes(
  client: MongoClient,
  database: string,
  collection: string,
  signal: AbortSignal,
): Promise<TreeNode[]> {
  const list = await client
    .db(database)
    .collection(collection)
    .listIndexes({ promoteValues: true, signal } as never)
    .toArray()
  return list.map((index) => {
    const flags = [
      index.unique ? 'unique' : '',
      index.sparse ? 'sparse' : '',
      index.expireAfterSeconds !== undefined ? 'TTL' : '',
    ]
      .filter(Boolean)
      .join(' · ')
    return {
      id: nodeId('index', database, collection, String(index.name)),
      label: String(index.name),
      kind: 'index',
      hasChildren: false,
      detail: [flags, describeKeys(index.key as Document)].filter(Boolean).join(' · '),
      scope: database,
    }
  })
}

export async function treeChildren(
  client: MongoClient,
  parent: TreeNode | null,
  options: { defaultDatabase?: string; signal: AbortSignal },
): Promise<TreeNode[]> {
  const { signal } = options
  if (parent === null) return roots(client, options.defaultDatabase, signal)

  const [kind, database, name] = parseNodeId(parent.id)
  switch (kind) {
    case 'system':
      return [...SYSTEM_DATABASES].sort().map((name): TreeNode => ({
        id: nodeId('database', name),
        label: name,
        kind: 'database',
        hasChildren: true,
        scope: name,
      }))
    case 'database':
      return collections(client, database!, signal)
    case 'collection':
      return indexes(client, database!, name!, signal)
    default:
      return []
  }
}

/** Collection names of a database, for autocomplete. */
export async function collectionNames(
  client: MongoClient,
  database: string,
  signal: AbortSignal,
): Promise<string[]> {
  const infos = await client
    .db(database)
    .listCollections({}, { nameOnly: true, promoteValues: true, signal } as never)
    .toArray()
  return infos.map((info) => String(info.name)).sort((a, b) => a.localeCompare(b))
}
