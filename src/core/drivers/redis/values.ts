import {
  STRING_LIMIT,
  type KeyDetail,
  type ValuePage,
  type ValueRequest,
} from '@shared/redis/types'
import type { RedisConnection } from './client'
import { K, bin, list, num, pipeline, score, send, str } from './calls'

const LENGTH_COMMANDS: Record<string, string> = {
  string: 'STRLEN',
  hash: 'HLEN',
  list: 'LLEN',
  set: 'SCARD',
  zset: 'ZCARD',
  stream: 'XLEN',
}

/** What a key is, how long it lives and how big it is. A key that isn't there comes back as type `none`. */
export async function keyDetail(
  conn: RedisConnection,
  db: number,
  key: string,
): Promise<KeyDetail> {
  const client = conn.client(db)
  const k = K(key)
  const [type, ttl, encoding] = await pipeline(client, [
    ['TYPE', k],
    ['PTTL', k],
    ['OBJECT', 'ENCODING', k],
  ])
  if (type?.[0]) throw type[0]
  const kind = str(type?.[1])
  if (kind === 'none' || kind === '') {
    return { key, db, type: 'none', ttlMs: null, encoding: null, length: null }
  }
  const lengthCommand = LENGTH_COMMANDS[kind]
  let length: number | null = null
  if (lengthCommand) {
    try {
      length = num(await send(client, lengthCommand, k))
    } catch {
      length = null
    }
  }
  const ms = num(ttl?.[1])
  return {
    key,
    db,
    type: kind,
    ttlMs: ms >= 0 ? ms : null,
    encoding: encoding?.[0] || encoding?.[1] == null ? null : str(encoding[1]),
    length,
  }
}

/** One page of what a key holds. */
export async function valuePage(conn: RedisConnection, request: ValueRequest): Promise<ValuePage> {
  const client = conn.client(request.db)
  const k = K(request.key)
  const count = request.count

  switch (request.type) {
    case 'string': {
      const [bytes, text] = await pipeline(client, [
        ['STRLEN', k],
        ['GETRANGE', k, 0, STRING_LIMIT - 1],
      ])
      if (bytes?.[0]) throw bytes[0]
      if (text?.[0]) throw text[0]
      const total = num(bytes?.[1])
      return {
        type: 'string',
        value: bin(text?.[1]),
        bytes: total,
        truncated: total > STRING_LIMIT,
      }
    }

    case 'hash':
    case 'set': {
      // HSCAN and SSCAN may hand back fewer than asked for, or none, and still have more.
      const hash = request.type === 'hash'
      const items: { field: string; value: string }[] = []
      const members: string[] = []
      let cursor = request.cursor ?? '0'
      let finished = false
      for (let calls = 0; calls < 200; calls++) {
        const args: (string | number)[] = [cursor]
        if (request.match) args.push('MATCH', request.match)
        args.push('COUNT', Math.max(count, 10))
        const [next, found] = list(await send(client, hash ? 'HSCAN' : 'SSCAN', k, ...args))
        cursor = str(next)
        const flat = list(found) as Buffer[]
        if (hash) {
          for (let i = 0; i + 1 < flat.length; i += 2) {
            items.push({ field: bin(flat[i]), value: bin(flat[i + 1]) })
          }
        } else {
          for (const member of flat) members.push(bin(member))
        }
        if (cursor === '0') {
          finished = true
          break
        }
        if ((hash ? items.length : members.length) >= count) break
      }
      const next = finished ? null : cursor
      return hash ? { type: 'hash', items, next } : { type: 'set', items: members, next }
    }

    case 'list': {
      const start = Number(request.cursor ?? 0)
      const [total, range] = await pipeline(client, [
        ['LLEN', k],
        ['LRANGE', k, start, start + count - 1],
      ])
      if (range?.[0]) throw range[0]
      const items = list(range?.[1]).map((value, i) => ({ index: start + i, value: bin(value) }))
      const length = num(total?.[1])
      return {
        type: 'list',
        items,
        next: start + items.length < length ? String(start + items.length) : null,
      }
    }

    case 'zset': {
      const start = Number(request.cursor ?? 0)
      const [total, range] = await pipeline(client, [
        ['ZCARD', k],
        ['ZRANGE', k, start, start + count - 1, 'WITHSCORES'],
      ])
      if (range?.[0]) throw range[0]
      const flat = list(range?.[1])
      const items: { member: string; score: number }[] = []
      for (let i = 0; i + 1 < flat.length; i += 2) {
        items.push({ member: bin(flat[i]), score: score(flat[i + 1]) })
      }
      const length = num(total?.[1])
      return {
        type: 'zset',
        items,
        next: start + items.length < length ? String(start + items.length) : null,
      }
    }

    case 'stream': {
      // Newest first. The next page starts just below the last id shown.
      const end = request.cursor ? previousId(request.cursor) : '+'
      const raw = list(await send(client, 'XREVRANGE', k, end, '-', 'COUNT', count))
      const items = raw.map((entry) => {
        const [id, flat] = list(entry)
        const values = list(flat)
        const fields: [string, string][] = []
        for (let i = 0; i + 1 < values.length; i += 2)
          fields.push([bin(values[i]), bin(values[i + 1])])
        return { id: str(id), fields }
      })
      const last = items[items.length - 1]
      return { type: 'stream', items, next: items.length >= count && last ? last.id : null }
    }

    case 'ReJSON-RL': {
      const text = await send(client, 'JSON.GET', k)
      return { type: 'json', value: bin(text) }
    }

    default:
      return { type: 'other', name: request.type }
  }
}

/** The stream id just before this one, for a range that must stop short of it. */
export function previousId(id: string): string {
  const [ms = '0', seq = '0'] = id.split('-')
  const s = BigInt(seq)
  if (s > 0n) return `${ms}-${s - 1n}`
  const m = BigInt(ms)
  return m > 0n ? `${m - 1n}-18446744073709551615` : '0-0'
}
