import type { ConnectionSummary } from '@shared/connection'
import type { TreeNode } from '@shared/driver'
import { treeKey, type Branch } from '@/state/tree'

export type TreeRow =
  | { type: 'connection'; key: string; depth: 0; connection: ConnectionSummary; expanded: boolean }
  | {
      type: 'node'
      key: string
      depth: number
      connectionId: string
      node: TreeNode
      expanded: boolean
      parentKey: string
    }
  | {
      type: 'status'
      key: string
      depth: number
      text: string
      error: boolean
      connectionId: string
      node: TreeNode | null
    }

/** Whether a name matches the filter: every word of it appears, in any order, ignoring case. */
export function matchesFilter(text: string, filter: string): boolean {
  const haystack = text.toLowerCase()
  return filter
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word))
}

/**
 * Turns the expanded parts of every connection's tree into one flat list of rows.
 *
 * With a filter, a row is kept when its own name matches, when a name above it matches (so a matching
 * schema still shows its tables), or when something already loaded below it matches (so the way to
 * it stays visible, opened up). Only what has been loaded can be searched; the rest is not fetched.
 */
export function flattenTree(
  connections: ConnectionSummary[],
  expanded: Record<string, true>,
  branches: Record<string, Branch>,
  filter = '',
): TreeRow[] {
  const rows: TreeRow[] = []
  const filtering = filter.trim() !== ''

  /** Whether anything loaded under this node matches. Cached: a node is asked about once per run. */
  const below = new Map<string, boolean>()
  const hasMatchBelow = (connectionId: string, parentKey: string): boolean => {
    const cached = below.get(parentKey)
    if (cached !== undefined) return cached
    const branch = branches[parentKey]
    let found = false
    for (const node of branch?.nodes ?? []) {
      if (
        matchesFilter(node.label, filter) ||
        hasMatchBelow(connectionId, treeKey(connectionId, node))
      ) {
        found = true
        break
      }
    }
    below.set(parentKey, found)
    return found
  }

  const addBranch = (
    connectionId: string,
    parent: TreeNode | null,
    parentKey: string,
    depth: number,
    // A name above matched, so everything under it is shown.
    covered: boolean,
  ): void => {
    const branch = branches[parentKey]
    if (!branch || branch.status === 'loading') {
      rows.push({
        type: 'status',
        key: `${parentKey}#status`,
        depth,
        text: parent ? 'Loading…' : 'Connecting…',
        error: false,
        connectionId,
        node: parent,
      })
      return
    }
    if (branch.status === 'error') {
      rows.push({
        type: 'status',
        key: `${parentKey}#status`,
        depth,
        text: branch.error ?? 'Couldn’t load this.',
        error: true,
        connectionId,
        node: parent,
      })
      return
    }
    if (branch.nodes.length === 0) {
      if (!filtering) {
        rows.push({
          type: 'status',
          key: `${parentKey}#status`,
          depth,
          text: 'Nothing here.',
          error: false,
          connectionId,
          node: parent,
        })
      }
      return
    }
    for (const node of branch.nodes) {
      const key = treeKey(connectionId, node)
      const own = !filtering || matchesFilter(node.label, filter)
      const inside = filtering && node.hasChildren && hasMatchBelow(connectionId, key)
      if (filtering && !covered && !own && !inside) continue

      // A match deeper down opens the way to it, whatever the user had open.
      const isExpanded = node.hasChildren && (expanded[key] === true || inside)
      rows.push({ type: 'node', key, depth, connectionId, node, expanded: isExpanded, parentKey })
      if (isExpanded) addBranch(connectionId, node, key, depth + 1, covered || own)
    }
  }

  for (const connection of connections) {
    const key = treeKey(connection.id, null)
    const own =
      !filtering ||
      matchesFilter(`${connection.name} ${connection.host} ${connection.engine}`, filter)
    const inside = filtering && hasMatchBelow(connection.id, key)
    if (filtering && !own && !inside) continue

    const isExpanded = expanded[key] === true || inside
    rows.push({ type: 'connection', key, depth: 0, connection, expanded: isExpanded })
    if (isExpanded) addBranch(connection.id, null, key, 1, own)
  }
  return rows
}
