import type { TreeNode } from '@shared/driver'
import {
  describeQueueCounts,
  isBuiltInExchange,
  DEFAULT_EXCHANGE_LABEL,
  compactCount,
  type BrokerApi,
  type VhostListing,
  type VhostSummary,
} from '@shared/rabbitmq'
import { nodeId } from '../mysql/tree'

/** How many queues one group shows. A vhost with more says so, and the vhost view has the whole list. */
const MAX_QUEUE_NODES = 1000

export function parseBrokerNodeId(id: string): string[] {
  try {
    const parts: unknown = JSON.parse(id)
    if (Array.isArray(parts) && parts.every((p) => typeof p === 'string')) return parts as string[]
  } catch {
    // fall through
  }
  throw new Error(`Unknown tree node "${id}"`)
}

export interface TreeSource {
  vhosts(signal: AbortSignal): Promise<VhostSummary[]>
  listing(vhost: string, signal: AbortSignal): Promise<VhostListing>
  broker: BrokerApi
}

function vhostNode(vhost: VhostSummary): TreeNode {
  return {
    id: nodeId('vhost', vhost.name),
    label: vhost.name,
    kind: 'vhost',
    hasChildren: true,
    detail: vhost.messages > 0 ? `${compactCount(vhost.messages)} msgs` : '',
    scope: vhost.name,
  }
}

export async function treeChildren(
  source: TreeSource,
  parent: TreeNode | null,
  signal: AbortSignal,
): Promise<TreeNode[]> {
  if (parent === null) {
    const vhosts = await source.vhosts(signal)
    return [...vhosts].sort((a, b) => a.name.localeCompare(b.name)).map(vhostNode)
  }

  const [kind, vhost, name] = parseBrokerNodeId(parent.id)
  switch (kind) {
    case 'vhost': {
      const listing = await source.listing(vhost!, signal)
      return [
        {
          id: nodeId('group', vhost!, 'queues'),
          label: 'Queues',
          kind: 'group',
          hasChildren: listing.queues.length > 0,
          detail: String(listing.queuesTotal),
          scope: vhost!,
        },
        {
          id: nodeId('group', vhost!, 'exchanges'),
          label: 'Exchanges',
          kind: 'group',
          hasChildren: listing.exchanges.length > 0,
          detail: String(listing.exchanges.length),
          scope: vhost!,
        },
      ]
    }

    case 'group': {
      const listing = await source.listing(vhost!, signal)
      if (name === 'queues') {
        const queues = [...listing.queues].sort((a, b) => a.name.localeCompare(b.name))
        const nodes = queues.slice(0, MAX_QUEUE_NODES).map((queue): TreeNode => ({
          id: nodeId('queue', vhost!, queue.name),
          label: queue.name,
          kind: 'queue',
          hasChildren: true,
          detail: `${queue.type === 'classic' ? '' : `${queue.type} · `}${describeQueueCounts(queue)}`,
          scope: vhost!,
        }))
        if (listing.queuesTotal > nodes.length) {
          nodes.push({
            id: nodeId('more', vhost!),
            label: `${(listing.queuesTotal - nodes.length).toLocaleString()} more queues`,
            kind: 'info',
            hasChildren: false,
            detail: 'open the vhost to see them all',
            scope: vhost!,
          })
        }
        return nodes
      }
      // Exchanges you made come first; the broker's own, which every vhost has, come after.
      const exchanges = [...listing.exchanges].sort(
        (a, b) =>
          Number(isBuiltInExchange(a.name)) - Number(isBuiltInExchange(b.name)) ||
          a.name.localeCompare(b.name),
      )
      return exchanges.map((exchange): TreeNode => ({
        id: nodeId('exchange', vhost!, exchange.name),
        label: exchange.name === '' ? DEFAULT_EXCHANGE_LABEL : exchange.name,
        kind: 'exchange',
        hasChildren: exchange.name !== '',
        detail: exchange.type,
        scope: vhost!,
      }))
    }

    case 'queue': {
      const detail = await source.broker.queue(vhost!, name!, signal)
      // Every queue is bound to the default exchange by its own name; that one is implied, not worth a line.
      return detail.bindings
        .filter((binding) => binding.source !== '')
        .map((binding, i): TreeNode => ({
          id: nodeId('binding', vhost!, name!, String(i), binding.source, binding.routingKey),
          label: binding.source === '' ? DEFAULT_EXCHANGE_LABEL : binding.source,
          kind: 'binding',
          hasChildren: false,
          detail: binding.routingKey === '' ? 'no routing key' : binding.routingKey,
          scope: vhost!,
        }))
    }

    case 'exchange': {
      const detail = await source.broker.exchange(vhost!, name!, signal)
      return detail.bindingsFrom.map((binding, i): TreeNode => ({
        id: nodeId('binding', vhost!, name!, String(i), binding.destination, binding.routingKey),
        label: `→ ${binding.destination}`,
        kind: 'binding',
        hasChildren: false,
        detail: binding.routingKey === '' ? 'no routing key' : binding.routingKey,
        scope: vhost!,
      }))
    }

    default:
      return []
  }
}
