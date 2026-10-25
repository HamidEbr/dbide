import type { TreeNode } from '@shared/driver'
import { fromBytes, isBinary, printable } from '@shared/redis/bstring'
import { TREE_KEY_LIMIT, prefixGlob } from '@shared/redis/types'
import type { RedisInfo } from '@shared/redis/types'
import { formatCount, nodeId } from '../mysql/tree'
import { pipeline, str } from './calls'
import type { RedisConnection } from './client'
import { type Scanner } from './scan'

/** How long the navigator keeps scanning for keys under a node before it shows what it has. */
const TREE_BUDGET_MS = 4000

export function parseRedisNodeId(id: string): string[] {
  try {
    const parts: unknown = JSON.parse(id)
    if (Array.isArray(parts) && parts.every((p) => typeof p === 'string')) return parts as string[]
  } catch {
    // fall through
  }
  throw new Error(`Unknown tree node "${id}"`)
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export interface TreeSource {
  conn: RedisConnection
  scanner: Scanner
  info(signal: AbortSignal): Promise<RedisInfo>
}

/** The databases that hold keys, and the one the connection opens in. */
async function databaseNodes(source: TreeSource, signal: AbortSignal): Promise<TreeNode[]> {
  const { setup } = source.conn
  if (setup.mode === 'cluster') {
    const keys = await source.scanner.size(0, signal)
    return [
      {
        id: nodeId('db', '0'),
        label: 'Keys',
        kind: 'redis-db',
        hasChildren: keys !== 0,
        detail: keys === null ? '' : `${formatCount(keys)} keys`,
        scope: '0',
      },
    ]
  }
  let info: RedisInfo | null = null
  try {
    info = await source.info(signal)
  } catch (error) {
    // A user that may not run INFO can still browse: the database it opened in is shown, without a count.
    if ((error as { code?: string }).code !== 'FORBIDDEN') throw error
  }
  if (info === null) {
    return [
      {
        id: nodeId('db', String(setup.db)),
        label: `db${setup.db}`,
        kind: 'redis-db',
        hasChildren: true,
        detail: '',
        scope: String(setup.db),
      },
    ]
  }
  const byDb = new Map(info.keyspace.map((entry) => [entry.db, entry.keys]))
  if (!byDb.has(setup.db)) byDb.set(setup.db, 0)
  return [...byDb]
    .sort(([a], [b]) => a - b)
    .map(([db, keys]) => ({
      id: nodeId('db', String(db)),
      label: `db${db}`,
      kind: 'redis-db',
      hasChildren: keys > 0,
      detail: `${formatCount(keys)} keys`,
      scope: String(db),
    }))
}

/** The folders and keys one level below a node, from a scan of the keys under it. */
async function levelNodes(
  source: TreeSource,
  db: number,
  prefix: string,
  signal: AbortSignal,
): Promise<TreeNode[]> {
  const { separator } = source.conn.setup
  const collected: Buffer[] = []
  let complete = true
  const started = Date.now()
  for await (const batch of source.scanner.batches(
    db,
    prefix === '' ? '*' : prefixGlob(prefix),
    undefined,
    null,
    signal,
  )) {
    collected.push(...batch.keys)
    if (collected.length >= TREE_KEY_LIMIT || Date.now() - started > TREE_BUDGET_MS) {
      complete = batch.next === null
      collected.length = Math.min(collected.length, TREE_KEY_LIMIT)
      break
    }
  }

  const folders = new Map<string, number>()
  const leaves = new Map<string, Buffer>()
  for (const raw of collected) {
    const key = fromBytes(raw)
    // A key of bytes that aren't text has no folders; it is a leaf of the top level.
    if (isBinary(key)) {
      if (prefix === '') leaves.set(key, raw)
      continue
    }
    const rest = key.slice(prefix.length)
    const at = separator === '' ? -1 : rest.indexOf(separator)
    if (at >= 0) {
      const name = rest.slice(0, at)
      folders.set(name, (folders.get(name) ?? 0) + 1)
    } else {
      leaves.set(key, raw)
    }
  }

  const leafKeys = [...leaves.keys()].sort((a, b) => collator.compare(a, b))
  const types = await pipeline(
    source.conn.client(db),
    leafKeys.map((key) => ['TYPE', leaves.get(key)!]),
  )

  const nodes: TreeNode[] = [...folders.keys()]
    .sort((a, b) => collator.compare(a, b))
    .map((name) => ({
      id: nodeId('prefix', String(db), `${prefix}${name}${separator}`),
      label: `${name}${separator}`,
      kind: 'redis-prefix',
      hasChildren: true,
      detail: `${complete ? '' : '≥ '}${formatCount(folders.get(name)!)}`,
      scope: String(db),
    }))
  leafKeys.forEach((key, i) => {
    const type = str(types[i]?.[1]) || 'string'
    nodes.push({
      id: nodeId('key', String(db), key),
      label: isBinary(key) ? printable(key) : key.slice(prefix.length),
      kind: `redis-key-${type}`,
      hasChildren: false,
      detail: type === 'string' ? '' : type,
      scope: String(db),
    })
  })
  if (!complete) {
    nodes.push({
      id: nodeId('more', String(db), prefix),
      label: `Showing the first ${formatCount(TREE_KEY_LIMIT)} keys`,
      kind: 'info',
      hasChildren: false,
      detail: 'open the key browser to search',
      scope: String(db),
    })
  }
  return nodes
}

export async function treeChildren(
  source: TreeSource,
  parent: TreeNode | null,
  signal: AbortSignal,
): Promise<TreeNode[]> {
  if (parent === null) return databaseNodes(source, signal)
  const [kind, db, prefix] = parseRedisNodeId(parent.id)
  switch (kind) {
    case 'db':
      return levelNodes(source, Number(db), '', signal)
    case 'prefix':
      return levelNodes(source, Number(db), prefix ?? '', signal)
    default:
      return []
  }
}
