/**
 * Runs the Redis driver against real servers. Skipped unless DBIDE_TEST_REDIS_URL is set, e.g.
 *
 *   DBIDE_TEST_REDIS_URL=redis://127.0.0.1:6379 pnpm test
 *
 * The same suite passes against Redis and Valkey. Every key the tests make is named `dbide-it-<random>:…`, in
 * databases 0 and 1, and removed at the end; nothing flushes a database. More servers are covered by the
 * later suites, each skipped without its variable:
 *
 *   DBIDE_TEST_REDIS_AUTH_URL      redis://user:password@host:port, a server that wants a login (a user name
 *                                  only for a server with ACL users)
 *   DBIDE_TEST_REDIS_TLS_URL       rediss://host:port, with the CA that signed its certificate in DBIDE_TEST_REDIS_CA
 *   DBIDE_TEST_REDIS_CLUSTER_URL   redis://host:port of any node of a cluster whose nodes are reachable from here
 *   DBIDE_TEST_REDIS_SENTINEL_URL  redis://host:port of a Sentinel, with the primary's name in
 *                                  DBIDE_TEST_REDIS_SENTINEL_MASTER (default mymaster)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newConnectionDraft, type ConnectionConfig } from '@shared/connection'
import type { DriverSession } from '@shared/driver'
import { tokenize } from '@shared/redis/command'
import type { RedisApi, RedisEdit, ValuePage } from '@shared/redis/types'
import { parseConnectionUri } from '@shared/uri'
import { redisDriver } from './driver'

const url = process.env.DBIDE_TEST_REDIS_URL
const parsed = url ? parseConnectionUri(url) : null
const none = (): AbortSignal => new AbortController().signal

async function connect(
  uri: string,
  overrides: Partial<ConnectionConfig> = {},
  password?: string,
): Promise<DriverSession> {
  const target = parseConnectionUri(uri)!
  const config: ConnectionConfig = {
    ...newConnectionDraft('redis', 'it'),
    name: 'integration',
    host: target.host,
    port: target.port,
    ...(target.username ? { username: target.username } : {}),
    ...(target.database ? { database: target.database } : {}),
    ...(target.tls ? { tls: { enabled: true, allowInvalidCertificates: false } } : {}),
    ...overrides,
  }
  return redisDriver.connect({
    config,
    secrets: {
      ...((password ?? target.password) ? { password: password ?? target.password! } : {}),
    },
    endpoint: { host: config.host, port: config.port },
    signal: none(),
  })
}

async function exec(api: RedisApi, line: string) {
  const parsedLine = tokenize(line)
  if (!parsedLine.ok) throw new Error(parsedLine.error)
  return (await api.exec(parsedLine.args, none())).reply
}

const run = Math.random().toString(16).slice(2, 8)
const P = `dbide-it-${run}`
const k = (name: string): string => `${P}:${name}`

async function wipe(api: RedisApi, db: number): Promise<void> {
  await api.deleteMatching(db, `${P}:*`, undefined, none(), () => undefined)
}

describe.skipIf(!parsed)('Redis driver (live server)', { timeout: 60_000 }, () => {
  let session: DriverSession
  let api: RedisApi
  const edit = (key: string, e: RedisEdit, db = 0) => api.edit(db, key, e, none())
  const page = (key: string, type: string, db = 0, cursor: string | null = null, count = 100) =>
    api.value({ db, key, type, cursor, count }, none())
  const all = async (key: string, type: 'hash' | 'list' | 'set' | 'zset' | 'stream') => {
    const items: unknown[] = []
    let cursor: string | null = null
    do {
      const p: ValuePage = await page(key, type, 0, cursor, 60)
      if (!('items' in p)) throw new Error('expected a collection')
      items.push(...(p.items as unknown[]))
      cursor = p.next
    } while (cursor !== null)
    return items
  }

  beforeAll(async () => {
    session = await connect(url!)
    api = session.redis!
    await wipe(api, 0)
    await wipe(api, 1)
  })
  afterAll(async () => {
    await wipe(api, 0)
    await wipe(api, 1)
    await session.close()
  })

  it('logs in and reports the server', async () => {
    expect(session.info.serverVersion).toMatch(/^\d+\.\d+/)
    await session.ping()
    const info = await api.info(none())
    expect(info.version).toBe(session.info.serverVersion)
    expect(info.mode).toBe('standalone')
    expect(info.usedMemory).toBeGreaterThan(0)
    expect(info.sections.server).toBeDefined()
    expect(['Redis', 'Valkey', 'Dragonfly']).toContain(info.flavor)
  })

  describe('keys of every type', () => {
    it('creates, reads and measures a key of each type', async () => {
      await edit(k('str'), { op: 'key.create', value: { type: 'string', value: 'héllo' } })
      await edit(k('hash'), { op: 'key.create', value: { type: 'hash', field: 'a', value: '1' } })
      await edit(k('list'), { op: 'key.create', value: { type: 'list', value: 'x' } })
      await edit(k('set'), { op: 'key.create', value: { type: 'set', member: 'm' } })
      await edit(k('zset'), { op: 'key.create', value: { type: 'zset', member: 'm', score: 1.5 } })
      await edit(k('stream'), { op: 'key.create', value: { type: 'stream', fields: [['f', 'v']] } })
      for (const [name, type, length] of [
        ['str', 'string', 6],
        ['hash', 'hash', 1],
        ['list', 'list', 1],
        ['set', 'set', 1],
        ['zset', 'zset', 1],
        ['stream', 'stream', 1],
      ] as const) {
        const detail = await api.key(0, k(name), none())
        expect(detail, name).toMatchObject({ type, length, ttlMs: null })
        expect(detail.encoding, name).toEqual(expect.any(String))
      }
      const [size, missing] = await api.memory(0, [k('str'), k('nope')], none())
      expect(size).toBeGreaterThan(0)
      expect(missing).toBeNull()
    })

    it('says a key that does not exist is none', async () => {
      expect(await api.key(0, k('absent'), none())).toMatchObject({ type: 'none' })
    })

    it('refuses a change that does not fit the type, and does not overwrite', async () => {
      await expect(edit(k('hash'), { op: 'string.set', value: 'x' })).rejects.toMatchObject({
        code: 'WRONG_TYPE',
      })
      await expect(
        edit(k('str'), { op: 'hash.set', field: 'a', value: '1' }),
      ).rejects.toMatchObject({ code: 'WRONG_TYPE' })
      expect((await api.key(0, k('hash'), none())).type).toBe('hash')
    })

    it('pages collections of a few hundred members, each once', async () => {
      for (let i = 0; i < 250; i++) {
        await exec(api, `HSET ${k('big:hash')} f${i} v${i}`)
        await exec(api, `RPUSH ${k('big:list')} item${i}`)
        await exec(api, `SADD ${k('big:set')} m${i}`)
        await exec(api, `ZADD ${k('big:zset')} ${i} z${i}`)
        await exec(api, `XADD ${k('big:stream')} ${i + 1}-0 n ${i}`)
      }
      expect(
        new Set((await all(k('big:hash'), 'hash')).map((i) => (i as { field: string }).field)).size,
      ).toBe(250)
      expect(new Set((await all(k('big:set'), 'set')) as string[]).size).toBe(250)
      const list = (await all(k('big:list'), 'list')) as { index: number; value: string }[]
      expect(list.map((i) => i.index)).toEqual(Array.from({ length: 250 }, (_, i) => i))
      const zset = (await all(k('big:zset'), 'zset')) as { member: string; score: number }[]
      expect(zset.map((i) => i.score)).toEqual(Array.from({ length: 250 }, (_, i) => i))
      const stream = (await all(k('big:stream'), 'stream')) as { id: string }[]
      expect(stream).toHaveLength(250)
      expect(stream[0]!.id).toBe('250-0')
      expect(stream.at(-1)!.id).toBe('1-0')
    })

    it('reads infinite scores and scores that are not whole', async () => {
      await exec(api, `ZADD ${k('inf')} inf top -inf bottom 0.1 tenth`)
      const items = (
        (await page(k('inf'), 'zset')) as { items: { member: string; score: number }[] }
      ).items
      expect(items).toEqual([
        { member: 'bottom', score: -Infinity },
        { member: 'tenth', score: 0.1 },
        { member: 'top', score: Infinity },
      ])
    })

    it('keeps every byte of a key and a value that are not text', async () => {
      const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
      const binary = '\u0000' + bytes.toString('base64')
      await edit(binary, { op: 'key.create', value: { type: 'string', value: binary } })
      const read = (await page(binary, 'string')) as { value: string; bytes: number }
      expect(read.value).toBe(binary)
      expect(read.bytes).toBe(256)
      await edit(binary, { op: 'key.rename', newKey: k('from-binary'), overwrite: false })
      expect(((await page(k('from-binary'), 'string')) as { value: string }).value).toBe(binary)
    })
  })

  describe('changes', () => {
    it('edits a hash, a list, a set and a sorted set', async () => {
      await edit(k('h'), { op: 'key.create', value: { type: 'hash', field: 'a', value: '1' } })
      await edit(k('h'), { op: 'hash.set', field: 'b', value: '2' })
      await edit(k('h'), { op: 'hash.rename', field: 'a', newField: 'c' })
      await expect(
        edit(k('h'), { op: 'hash.rename', field: 'c', newField: 'b' }),
      ).rejects.toMatchObject({
        code: 'EXISTS',
      })
      await edit(k('h'), { op: 'hash.delete', fields: ['b'] })
      expect(await all(k('h'), 'hash')).toEqual([{ field: 'c', value: '1' }])

      await edit(k('l'), { op: 'key.create', value: { type: 'list', value: 'b' } })
      await edit(k('l'), { op: 'list.push', side: 'head', values: ['a'] })
      await edit(k('l'), { op: 'list.push', side: 'tail', values: ['c', 'd'] })
      await edit(k('l'), { op: 'list.set', index: 3, value: 'D' })
      await edit(k('l'), { op: 'list.remove', index: 1 })
      expect(((await all(k('l'), 'list')) as { value: string }[]).map((i) => i.value)).toEqual([
        'a',
        'c',
        'D',
      ])

      await edit(k('s'), { op: 'key.create', value: { type: 'set', member: 'a' } })
      await edit(k('s'), { op: 'set.add', members: ['b', 'c'] })
      await edit(k('s'), { op: 'set.remove', members: ['a'] })
      expect(((await all(k('s'), 'set')) as string[]).sort()).toEqual(['b', 'c'])

      await edit(k('z'), { op: 'key.create', value: { type: 'zset', member: 'a', score: 1 } })
      await edit(k('z'), { op: 'zset.add', member: 'a', score: 5.5 })
      await edit(k('z'), { op: 'zset.add', member: 'b', score: Infinity })
      await edit(k('z'), { op: 'zset.remove', members: ['b'] })
      expect(await all(k('z'), 'zset')).toEqual([{ member: 'a', score: 5.5 }])
    })

    it('adds and deletes stream entries, and reads groups with their pending entries', async () => {
      await edit(k('st'), { op: 'key.create', value: { type: 'stream', fields: [['a', '1']] } })
      await edit(k('st'), { op: 'stream.add', id: '99999999999999-0', fields: [['b', '2']] })
      expect((await api.key(0, k('st'), none())).length).toBe(2)
      await edit(k('st'), { op: 'stream.delete', ids: ['99999999999999-0'] })
      expect((await api.key(0, k('st'), none())).length).toBe(1)

      await exec(api, `XADD ${k('grp')} 1-0 t signup`)
      await exec(api, `XADD ${k('grp')} 2-0 t login`)
      await exec(api, `XGROUP CREATE ${k('grp')} workers 0`)
      await exec(api, `XREADGROUP GROUP workers alice COUNT 1 STREAMS ${k('grp')} >`)
      const info = await api.streamInfo(0, k('grp'), none())
      expect(info).toMatchObject({ length: 2, lastGeneratedId: '2-0' })
      expect(info.groups[0]).toMatchObject({
        name: 'workers',
        consumers: 1,
        pending: 1,
        lastDeliveredId: '1-0',
      })
      const group = await api.streamGroup(0, k('grp'), 'workers', none())
      expect(group.consumers).toEqual([{ name: 'alice', pending: 1, idleMs: expect.any(Number) }])
      expect(group.pending.map((p) => [p.id, p.consumer, p.deliveries])).toEqual([
        ['1-0', 'alice', 1],
      ])
      expect(group.pendingTotal).toBe(1)
    })

    it('sets, keeps and clears a TTL', async () => {
      await exec(api, `SET ${k('t')} old EX 1000`)
      await edit(k('t'), { op: 'string.set', value: 'new' })
      const kept = await api.key(0, k('t'), none())
      expect(kept.ttlMs).toBeGreaterThan(900_000)
      await edit(k('t'), { op: 'ttl.set', ttlMs: 60_000 })
      expect((await api.key(0, k('t'), none())).ttlMs).toBeLessThanOrEqual(60_000)
      await edit(k('t'), { op: 'ttl.clear' })
      expect((await api.key(0, k('t'), none())).ttlMs).toBeNull()
      await expect(edit(k('gone'), { op: 'ttl.set', ttlMs: 1000 })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    })

    it('renames and copies, to another database too, with the TTL', async () => {
      await exec(api, `SET ${k('r1')} a EX 1000`)
      await exec(api, `SET ${k('r2')} b`)
      await expect(
        edit(k('r1'), { op: 'key.rename', newKey: k('r2'), overwrite: false }),
      ).rejects.toMatchObject({ code: 'EXISTS' })
      await edit(k('r1'), { op: 'key.rename', newKey: k('r2'), overwrite: true })
      expect(((await page(k('r2'), 'string')) as { value: string }).value).toBe('a')
      await edit(k('r2'), { op: 'key.copy', newKey: k('r3'), overwrite: false, toDb: null })
      await edit(k('r2'), { op: 'key.copy', newKey: k('r4'), overwrite: false, toDb: 1 })
      expect((await api.key(0, k('r3'), none())).ttlMs).toBeGreaterThan(900_000)
      expect(await api.key(1, k('r4'), none())).toMatchObject({ type: 'string' })
      await expect(
        edit(k('r2'), { op: 'key.copy', newKey: k('r3'), overwrite: false, toDb: null }),
      ).rejects.toMatchObject({ code: 'EXISTS' })
      await edit(k('r2'), { op: 'key.delete' })
      expect((await api.key(0, k('r2'), none())).type).toBe('none')
    })
  })

  describe('scanning', () => {
    it('finds every key once, by pattern and by type', async () => {
      for (let start = 0; start < 1500; start += 500) {
        let line = 'MSET'
        for (let i = start; i < start + 500; i++) line += ` ${k(`scan:${i}`)} v`
        await exec(api, line)
      }
      const seen = new Set<string>()
      let cursor: string | null = null
      let pages = 0
      do {
        const p = await api.scan({ db: 0, pattern: `${P}:scan:*`, cursor, limit: 200 }, none())
        for (const key of p.keys) seen.add(key.key)
        cursor = p.cursor
        pages++
      } while (cursor !== null)
      expect(seen.size).toBe(1500)
      expect(pages).toBeGreaterThan(1)
      const hashes = await api.scan(
        { db: 0, pattern: `${P}:big:*`, type: 'hash', cursor: null, limit: 50 },
        none(),
      )
      expect(hashes.keys.map((x) => x.key)).toEqual([k('big:hash')])
    })

    it('reports how many keys the database holds', async () => {
      const first = await api.scan({ db: 0, pattern: `${P}:*`, cursor: null, limit: 10 }, none())
      expect(first.total).toBeGreaterThan(1500)
    })
  })

  describe('the tree', () => {
    it('groups keys into folders with their types', async () => {
      const roots = await session.children(null, none())
      const db0 = roots.find((r) => r.label === 'db0')!
      expect(db0).toMatchObject({ kind: 'redis-db', hasChildren: true })
      const folder = (await session.children(db0, none())).find((n) => n.label === `${P}:`)!
      expect(folder.kind).toBe('redis-prefix')
      const level = await session.children(folder, none())
      expect(level.find((n) => n.label === 'big:')).toBeDefined()
      expect(level.find((n) => n.label === 'zset')!.kind).toBe('redis-key-zset')
      expect(level.find((n) => n.label === 'str')!.kind).toBe('redis-key-string')
    })
  })

  describe('bulk work', () => {
    it('counts, then deletes, by pattern, a batch at a time', async () => {
      for (let start = 0; start < 3000; start += 500) {
        let line = 'MSET'
        for (let i = start; i < start + 500; i++) line += ` ${k(`bulk:${i}`)} v`
        await exec(api, line)
      }
      const progress: number[] = []
      const counted = await api.count(0, `${P}:bulk:*`, undefined, none(), (p) =>
        progress.push(p.matched),
      )
      expect(counted).toEqual({ count: 3000, complete: true })
      expect(progress.length).toBeGreaterThan(1)
      const deleted = await api.deleteMatching(0, `${P}:bulk:*`, undefined, none(), () => undefined)
      expect(deleted).toEqual({ deleted: 3000, complete: true })
      expect((await api.count(0, `${P}:bulk:*`, undefined, none(), () => undefined)).count).toBe(0)
    })

    it('stops when cancelled, and says how far it got', async () => {
      for (let start = 0; start < 5000; start += 500) {
        let line = 'MSET'
        for (let i = start; i < start + 500; i++) line += ` ${k(`cancel:${i}`)} v`
        await exec(api, line)
      }
      const controller = new AbortController()
      const result = await api.deleteMatching(
        0,
        `${P}:cancel:*`,
        undefined,
        controller.signal,
        (p) => {
          if (p.deleted >= 1000) controller.abort()
        },
      )
      expect(result.complete).toBe(false)
      expect(result.deleted).toBeGreaterThanOrEqual(1000)
      const left = await api.count(0, `${P}:cancel:*`, undefined, none(), () => undefined)
      expect(left.count).toBe(5000 - result.deleted)
      await api.deleteMatching(0, `${P}:cancel:*`, undefined, none(), () => undefined)
    })
  })

  describe('the console', () => {
    let consoleSession: DriverSession
    let c: RedisApi
    beforeAll(async () => {
      consoleSession = await connect(url!)
      c = consoleSession.redis!
    })
    afterAll(async () => {
      await consoleSession.close()
    })

    it('tells a status reply, a string, a number, nothing and a list apart', async () => {
      expect(await exec(c, `SET ${k('c1')} hello`)).toEqual({ t: 'status', text: 'OK' })
      expect(await exec(c, `GET ${k('c1')}`)).toMatchObject({ t: 'bulk', text: 'hello', bytes: 5 })
      expect(await exec(c, `APPEND ${k('c1')} !`)).toEqual({ t: 'int', value: 6 })
      expect(await exec(c, `GET ${k('c-none')}`)).toEqual({ t: 'nil' })
      expect(await exec(c, 'PING')).toEqual({ t: 'status', text: 'PONG' })
      expect(await exec(c, `TYPE ${k('c1')}`)).toEqual({ t: 'status', text: 'string' })
      const list = await exec(c, `MGET ${k('c1')} ${k('c-none')}`)
      expect(list).toMatchObject({ t: 'array', omitted: 0 })
    })

    it('returns an error reply as data', async () => {
      expect(await exec(c, `HGET ${k('c1')} f`)).toMatchObject({
        t: 'error',
        text: expect.stringMatching(/^WRONGTYPE/),
      })
      expect(await exec(c, 'NOSUCHCOMMAND')).toMatchObject({
        t: 'error',
        text: expect.stringMatching(/unknown command/i),
      })
    })

    it('runs a transaction, and follows SELECT', async () => {
      expect(await exec(c, 'MULTI')).toEqual({ t: 'status', text: 'OK' })
      expect(await exec(c, `SET ${k('tx')} 1`)).toEqual({ t: 'status', text: 'QUEUED' })
      const result = await exec(c, 'EXEC')
      expect(result).toMatchObject({ t: 'array' })
      expect((result as { items: unknown[] }).items[0]).toEqual({ t: 'status', text: 'OK' })
      expect((await c.exec(['SELECT', '1'], none())).db).toBe(1)
      await exec(c, `SET ${k('in1')} x`)
      expect((await api.key(1, k('in1'), none())).type).toBe('string')
      await c.exec(['SELECT', '0'], none())
    })

    it('can stop a command that is waiting', async () => {
      const waiting = await connect(url!)
      const controller = new AbortController()
      const pending = waiting.redis!.exec(['BLPOP', k('wait'), '0'], controller.signal)
      setTimeout(() => controller.abort(), 100)
      await expect(pending).rejects.toThrow(/cancelled/)
      await expect(waiting.ping()).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
      await waiting.close()
    })
  })

  describe('an older server', () => {
    it('does what this server version can, whichever it is', async () => {
      // Whatever the version, a copy, a keep-TTL write and a typed scan must work, by SET KEEPTTL or the way before it.
      await exec(api, `SET ${k('v1')} a EX 1000`)
      await edit(k('v1'), { op: 'string.set', value: 'b' })
      expect((await api.key(0, k('v1'), none())).ttlMs).toBeGreaterThan(900_000)
      await edit(k('v1'), { op: 'key.copy', newKey: k('v2'), overwrite: false, toDb: 1 })
      expect((await api.key(1, k('v2'), none())).type).toBe('string')
      const typed = await api.scan(
        { db: 0, pattern: `${P}:v1`, type: 'string', cursor: null, limit: 10 },
        none(),
      )
      expect(typed.keys.map((x) => x.key)).toEqual([k('v1')])
    })
  })
})

const authUrl = process.env.DBIDE_TEST_REDIS_AUTH_URL
describe.skipIf(!authUrl)('Redis driver (a server that wants a login)', { timeout: 30_000 }, () => {
  it('works for a user that may only read, and says what it may not do', async () => {
    const admin = await connect(authUrl!)
    const target = parseConnectionUri(authUrl!)!
    try {
      await exec(admin.redis!, 'SET dbide-it-reader:k hello')
      // ACL users arrived with Redis 6.
      const made = await exec(admin.redis!, 'ACL SETUSER dbide-reader on >rpw ~* +@read +ping')
      if (made.t === 'error') return
      const reader = await connect(`redis://dbide-reader:rpw@${target.host}:${target.port}`)
      const api = reader.redis!
      // INFO is not a read, so the version is unknown and the tree has no counts, but it still lists keys.
      const roots = await reader.children(null, none())
      expect(roots).toHaveLength(1)
      expect(roots[0]).toMatchObject({ label: 'db0', kind: 'redis-db', hasChildren: true })
      const level = await reader.children(roots[0]!, none())
      expect(level.some((n) => n.label === 'dbide-it-reader:')).toBe(true)
      const page = await api.scan(
        { db: 0, pattern: 'dbide-it-reader:*', cursor: null, limit: 10 },
        none(),
      )
      expect(page.keys.map((x) => x.key)).toEqual(['dbide-it-reader:k'])
      expect(await api.key(0, 'dbide-it-reader:k', none())).toMatchObject({
        type: 'string',
        length: 5,
      })
      await expect(
        api.edit(0, 'dbide-it-reader:k', { op: 'string.set', value: 'x' }, none()),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(await exec(api, 'SET dbide-it-reader:k x')).toMatchObject({
        t: 'error',
        text: expect.stringMatching(/^NOPERM/),
      })
      await expect(api.info(none())).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await reader.close()
    } finally {
      await exec(admin.redis!, 'DEL dbide-it-reader:k')
      await exec(admin.redis!, 'ACL DELUSER dbide-reader')
      await admin.close()
    }
  })

  it('logs in with the right password, and says what is wrong otherwise', async () => {
    const good = await connect(authUrl!)
    await good.ping()
    await good.close()
    await expect(connect(authUrl!, {}, 'wrong-password')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    const target = parseConnectionUri(authUrl!)!
    const noPassword = connect(
      `redis://${target.host}:${target.port}`,
      {
        ...(target.username ? { username: target.username } : {}),
      },
      '',
    )
    await expect(noPassword).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})

const tlsUrl = process.env.DBIDE_TEST_REDIS_TLS_URL
const tlsCa = process.env.DBIDE_TEST_REDIS_CA
describe.skipIf(!tlsUrl || !tlsCa)('Redis driver (TLS)', { timeout: 30_000 }, () => {
  it('connects when it trusts the certificate authority', async () => {
    const session = await connect(tlsUrl!, {
      tls: { enabled: true, caPath: tlsCa!, allowInvalidCertificates: false },
    })
    await session.ping()
    expect((await session.redis!.info(none())).mode).toBe('standalone')
    await session.close()
  })

  it('refuses an authority it does not know, saying so', async () => {
    await expect(connect(tlsUrl!)).rejects.toMatchObject({
      code: expect.stringMatching(/TLS_ERROR|CONNECTION_CLOSED/),
    })
  })

  it('connects when told not to check the certificate', async () => {
    const session = await connect(tlsUrl!, {
      tls: { enabled: true, allowInvalidCertificates: true },
    })
    await session.ping()
    await session.close()
  })

  it('says a server that does not speak TLS does not', async () => {
    if (!url) return
    await expect(
      connect(url, { tls: { enabled: true, allowInvalidCertificates: true } }),
    ).rejects.toBeTruthy()
  })
})

const clusterUrl = process.env.DBIDE_TEST_REDIS_CLUSTER_URL
describe.skipIf(!clusterUrl)('Redis driver (a cluster)', { timeout: 60_000 }, () => {
  let session: DriverSession
  let api: RedisApi
  beforeAll(async () => {
    session = await connect(clusterUrl!, { options: { mode: 'cluster' } })
    api = session.redis!
    await wipe(api, 0)
  })
  afterAll(async () => {
    await wipe(api, 0)
    await session.close()
  })

  it('knows it is a cluster, and lists one set of keys', async () => {
    expect((await api.info(none())).mode).toBe('cluster')
    const roots = await session.children(null, none())
    expect(roots).toHaveLength(1)
    expect(roots[0]).toMatchObject({ label: 'Keys', kind: 'redis-db' })
  })

  it('finds the keys of every primary, once each', async () => {
    for (let i = 0; i < 300; i++) {
      await api.edit(
        0,
        k(`c:${i}`),
        { op: 'key.create', value: { type: 'string', value: 'v' } },
        none(),
      )
    }
    const seen = new Set<string>()
    let cursor: string | null = null
    do {
      const p = await api.scan({ db: 0, pattern: `${P}:c:*`, cursor, limit: 100 }, none())
      for (const key of p.keys) seen.add(key.key)
      cursor = p.cursor
    } while (cursor !== null)
    expect(seen.size).toBe(300)
    expect((await api.count(0, `${P}:c:*`, undefined, none(), () => undefined)).count).toBe(300)
  })

  it('edits keys wherever they live, and says when a command would cross slots', async () => {
    await api.edit(
      0,
      k('x'),
      { op: 'key.create', value: { type: 'hash', field: 'a', value: '1' } },
      none(),
    )
    await api.edit(0, k('x'), { op: 'hash.rename', field: 'a', newField: 'b' }, none())
    await api
      .edit(0, k('x'), { op: 'key.rename', newKey: `{${P}}:tagged1`, overwrite: false }, none())
      .catch(() => undefined)
    await api.edit(0, k('y1'), { op: 'key.create', value: { type: 'string', value: '1' } }, none())
    await expect(
      api.edit(
        0,
        k('y1'),
        { op: 'key.rename', newKey: k('y-other-slot-zzz'), overwrite: false },
        none(),
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/CROSSSLOT|EXISTS|REDIS_ERROR/) })
  })

  it('deletes by pattern across the primaries', async () => {
    const result = await api.deleteMatching(0, `${P}:c:*`, undefined, none(), () => undefined)
    expect(result.deleted).toBe(300)
  })
})

const sentinelUrl = process.env.DBIDE_TEST_REDIS_SENTINEL_URL
describe.skipIf(!sentinelUrl)('Redis driver (Sentinel)', { timeout: 30_000 }, () => {
  it('finds the primary through the sentinel, and works on it', async () => {
    const session = await connect(sentinelUrl!, {
      options: {
        mode: 'sentinel',
        master: process.env.DBIDE_TEST_REDIS_SENTINEL_MASTER ?? 'mymaster',
      },
    })
    const api = session.redis!
    await api.edit(
      0,
      k('sentinel'),
      { op: 'key.create', value: { type: 'string', value: 'ok' } },
      none(),
    )
    expect(
      (
        (await api.value(
          { db: 0, key: k('sentinel'), type: 'string', cursor: null, count: 1 },
          none(),
        )) as { value: string }
      ).value,
    ).toBe('ok')
    expect((await api.info(none())).role).toBe('master')
    await wipe(api, 0)
    await session.close()
  })

  it('says no sentinel answered when the primary’s name is wrong', async () => {
    await expect(
      connect(sentinelUrl!, { options: { mode: 'sentinel', master: 'no-such-primary' } }),
    ).rejects.toBeTruthy()
  })
})
