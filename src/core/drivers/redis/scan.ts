import { fromBytes } from '@shared/redis/bstring'
import type { KeySummary, RedisType, ScanPage, ScanRequest } from '@shared/redis/types'
import { list, num, pipeline, send, sleep, str } from './calls'
import type { RedisConnection } from './client'
import { isUnsupported } from './errors'

/** How long one page of the browser may keep scanning for keys that match, before it hands back what it has. */
const PAGE_BUDGET_MS = 1200
/** The pause between batches of a long task, so a big keyspace is never hammered. */
const BATCH_PAUSE_MS = 2

export interface ScanBatch {
  keys: Buffer[]
  /** Where to continue, or null once every node has been looked at. */
  next: string | null
  /** How many keys the server was asked to look at. */
  examined: number
}

const parseToken = (token: string | null): [number, string] => {
  if (token === null) return [0, '0']
  const at = token.indexOf(':')
  return [Number(token.slice(0, at)) || 0, token.slice(at + 1)]
}

/**
 * Walks a keyspace with SCAN, never KEYS: a few keys at a time, so a server with millions of them is never
 * stalled. A cluster is walked one primary after another, and the cursor says which.
 */
export class Scanner {
  /** Servers older than 6.0 don't filter by type themselves; then the type of every key found is asked. */
  private serverFiltersType = true

  constructor(private readonly conn: RedisConnection) {}

  async *batches(
    db: number,
    pattern: string,
    type: RedisType | undefined,
    from: string | null,
    signal: AbortSignal,
    size = 1000,
  ): AsyncGenerator<ScanBatch> {
    const nodes = this.conn.nodes(db)
    let [node, cursor] = parseToken(from)
    const count = pattern === '*' ? Math.min(size, 1000) : 1000
    while (node < nodes.length) {
      signal.throwIfAborted()
      const client = nodes[node]!
      const args: (string | number)[] = [cursor]
      if (pattern !== '*') args.push('MATCH', pattern)
      args.push('COUNT', count)
      if (type && this.serverFiltersType) args.push('TYPE', type)
      let reply: unknown
      try {
        reply = await send(client, 'SCAN', ...args)
      } catch (error) {
        if (type && this.serverFiltersType && isUnsupported(error)) {
          this.serverFiltersType = false
          continue
        }
        throw error
      }
      const [next, found] = list(reply)
      cursor = str(next)
      let keys = list(found) as Buffer[]
      if (type && !this.serverFiltersType) keys = await this.onlyOfType(client, keys, type)
      if (cursor === '0') {
        node++
        cursor = '0'
      }
      yield {
        keys,
        next: node >= nodes.length ? null : `${node}:${cursor}`,
        examined: count,
      }
    }
  }

  private async onlyOfType(
    client: ReturnType<RedisConnection['client']>,
    keys: Buffer[],
    type: RedisType,
  ): Promise<Buffer[]> {
    const types = await pipeline(
      client,
      keys.map((key) => ['TYPE', key]),
    )
    return keys.filter((_, i) => str(types[i]?.[1]) === type)
  }

  /** One page for the browser: about `limit` keys, with the type and TTL of each. */
  async page(request: ScanRequest, signal: AbortSignal): Promise<ScanPage> {
    const found: Buffer[] = []
    const seen = new Set<string>()
    let next: string | null = request.cursor
    let examined = 0
    const started = Date.now()
    let finished = true
    for await (const batch of this.batches(
      request.db,
      request.pattern || '*',
      request.type,
      request.cursor,
      signal,
      request.limit,
    )) {
      examined += batch.examined
      next = batch.next
      for (const key of batch.keys) {
        const id = key.toString('latin1')
        if (!seen.has(id)) {
          seen.add(id)
          found.push(key)
        }
      }
      if (found.length >= request.limit || Date.now() - started > PAGE_BUDGET_MS) {
        finished = batch.next === null
        break
      }
    }
    if (finished) next = null

    const client = this.conn.client(request.db)
    const settled = await pipeline(
      client,
      found.flatMap((key) => [
        ['TYPE', key],
        ['PTTL', key],
      ]),
    )
    const keys: KeySummary[] = []
    found.forEach((key, i) => {
      const type = str(settled[i * 2]?.[1])
      // A key that expired between the scan and now has no type.
      if (type === '' || type === 'none') return
      const ttl = num(settled[i * 2 + 1]?.[1])
      keys.push({ key: fromBytes(key), type, ttlMs: ttl >= 0 ? ttl : null })
    })

    const total = request.cursor === null ? await this.size(request.db, signal) : null
    return { keys, cursor: next, examined, total }
  }

  /** How many keys a database holds. */
  async size(db: number, signal: AbortSignal): Promise<number | null> {
    try {
      let total = 0
      for (const node of this.conn.nodes(db)) {
        signal.throwIfAborted()
        total += num(await send(node, 'DBSIZE'))
      }
      return total
    } catch (error) {
      if (signal.aborted) throw error
      return null
    }
  }

  /** Visits every key matching a pattern, a batch at a time, pausing between batches. */
  async sweep(
    db: number,
    pattern: string,
    type: RedisType | undefined,
    signal: AbortSignal,
    visit: (keys: Buffer[], examined: number) => Promise<void>,
  ): Promise<void> {
    let examined = 0
    for await (const batch of this.batches(db, pattern || '*', type, null, signal)) {
      examined += batch.examined
      await visit(batch.keys, examined)
      await sleep(BATCH_PAUSE_MS)
    }
  }
}
