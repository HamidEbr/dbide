import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newConnectionDraft, type ConnectionConfig } from '@shared/connection'
import type { DriverSession, TreeNode } from '@shared/driver'
import { argBytes, tokenize } from '@shared/redis/command'
import { STRING_LIMIT, TREE_KEY_LIMIT, type RedisApi, type RedisEdit } from '@shared/redis/types'
import { closedPort } from '../../testing'
import { redisDriver } from './driver'
import { startFakeRedis, type FakeRedis, type FakeRedisOptions } from './fake-redis'

const signal = new AbortController().signal

async function connect(
  fake: FakeRedis,
  overrides: Partial<ConnectionConfig> = {},
  secrets: { password?: string } = {},
  options: { readOnly?: boolean } = {},
): Promise<DriverSession> {
  const config: ConnectionConfig = {
    ...newConnectionDraft('redis', 'redis-test'),
    host: fake.host,
    port: fake.port,
    ...overrides,
  }
  return redisDriver.connect({
    config,
    secrets,
    endpoint: { host: fake.host, port: fake.port },
    ...(options.readOnly ? { readOnly: true } : {}),
    signal,
  })
}

/** Runs a console line and returns the reply. */
async function exec(api: RedisApi, line: string) {
  const parsed = tokenize(line)
  if (!parsed.ok) throw new Error(parsed.error)
  return (await api.exec(parsed.args, signal)).reply
}

const labels = (nodes: TreeNode[]): string[] => nodes.map((n) => n.label)

describe('connecting', () => {
  const servers: FakeRedis[] = []
  const start = async (options?: FakeRedisOptions): Promise<FakeRedis> => {
    const fake = await startFakeRedis(options)
    servers.push(fake)
    return fake
  }
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()))
  })

  it('connects, reports the version and pings', async () => {
    const fake = await start({ version: '7.2.4' })
    const session = await connect(fake)
    expect(session.info.serverVersion).toBe('7.2.4')
    expect(session.info.currentDatabase).toBe('0')
    expect(session.info.readOnlyEnforcedByServer).toBe(false)
    await session.ping()
    await session.close()
  })

  it('asks for a password the server needs, and says so when it is missing or wrong', async () => {
    const fake = await start({ password: 'hunter2' })
    await expect(connect(fake)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(connect(fake)).rejects.toThrow(/password/i)
    await expect(connect(fake, {}, { password: 'nope' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    const session = await connect(fake, {}, { password: 'hunter2' })
    await session.ping()
    await session.close()
  })

  it('logs in with a username and a password', async () => {
    const fake = await start({ password: 'pw', username: 'alice' })
    const session = await connect(fake, { username: 'alice' }, { password: 'pw' })
    await session.ping()
    await session.close()
    await expect(connect(fake, { username: 'bob' }, { password: 'pw' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })

  it('opens in the database the connection names', async () => {
    const fake = await start()
    fake.seed(3, 'only-in-three', 'x')
    const session = await connect(fake, { database: '3' })
    expect(session.info.currentDatabase).toBe('3')
    const page = await session.redis!.scan({ db: 3, pattern: '', cursor: null, limit: 50 }, signal)
    expect(page.keys.map((k) => k.key)).toEqual(['only-in-three'])
    await session.close()
  })

  it('says nothing answered when the port is closed', async () => {
    const port = await closedPort()
    await expect(
      redisDriver.connect({
        config: { ...newConnectionDraft('redis', 'x'), port },
        secrets: {},
        endpoint: { host: '127.0.0.1', port },
        signal,
      }),
    ).rejects.toMatchObject({ code: 'UNREACHABLE' })
  })

  it('can be cancelled while connecting', async () => {
    const fake = await start()
    const controller = new AbortController()
    controller.abort()
    await expect(
      redisDriver.connect({
        config: { ...newConnectionDraft('redis', 'x'), host: fake.host, port: fake.port },
        secrets: {},
        endpoint: { host: fake.host, port: fake.port },
        signal: controller.signal,
      }),
    ).rejects.toThrow()
  })
})

describe('a session', () => {
  let fake: FakeRedis
  let session: DriverSession
  let api: RedisApi

  beforeAll(async () => {
    fake = await startFakeRedis()
    session = await connect(fake)
    api = session.redis!
  })
  afterAll(async () => {
    await session.close()
    await fake.close()
  })
  beforeEach(async () => {
    await exec(api, 'FLUSHALL')
  })

  describe('the tree', () => {
    it('lists the databases that hold keys, and the one it opened in', async () => {
      await exec(api, 'SET a 1')
      await api.edit(2, 'b', { op: 'key.create', value: { type: 'string', value: '1' } }, signal)
      const roots = await session.children(null, signal)
      expect(roots.map((r) => [r.label, r.kind, r.detail])).toEqual([
        ['db0', 'redis-db', '1 keys'],
        ['db2', 'redis-db', '1 keys'],
      ])
      expect(roots.every((r) => r.scope === r.label.slice(2))).toBe(true)
    })

    it('shows an empty database as having no children', async () => {
      const [root] = await session.children(null, signal)
      expect(root).toMatchObject({ label: 'db0', hasChildren: false })
    })

    it('groups keys into folders by the separator, with leaves typed', async () => {
      await exec(api, 'SET user:1:name ann')
      await exec(api, 'SET user:2:name bob')
      await exec(api, 'HSET user:1 a 1')
      await exec(api, 'RPUSH queue:jobs x')
      await exec(api, 'SET plain 1')
      const [db] = await session.children(null, signal)
      const top = await session.children(db!, signal)
      expect(top.map((n) => [n.label, n.kind])).toEqual([
        ['queue:', 'redis-prefix'],
        ['user:', 'redis-prefix'],
        ['plain', 'redis-key-string'],
      ])
      expect(top[1]!.detail).toBe('3')
      const user = await session.children(top[1]!, signal)
      expect(user.map((n) => [n.label, n.kind])).toEqual([
        ['1:', 'redis-prefix'],
        ['2:', 'redis-prefix'],
        ['1', 'redis-key-hash'],
      ])
      const one = await session.children(user[0]!, signal)
      expect(one.map((n) => n.label)).toEqual(['name'])
      expect(JSON.parse(one[0]!.id)).toEqual(['key', '0', 'user:1:name'])
    })

    it('splits on the separator the connection sets, and not at all when it is empty', async () => {
      const custom = await connect(fake, { options: { separator: '/' } })
      await exec(api, 'SET a/b 1')
      await exec(api, 'SET c:d 1')
      const [db] = await custom.children(null, signal)
      expect(labels(await custom.children(db!, signal))).toEqual(['a/', 'c:d'])
      await custom.close()
      const flat = await connect(fake, { options: { folders: 'off' } })
      const [flatDb] = await flat.children(null, signal)
      expect(labels(await flat.children(flatDb!, signal))).toEqual(['a/b', 'c:d'])
      await flat.close()
    })

    it('keeps a key that is also a folder as both', async () => {
      await exec(api, 'SET a 1')
      await exec(api, 'SET a:b 1')
      const [db] = await session.children(null, signal)
      expect(labels(await session.children(db!, signal))).toEqual(['a:', 'a'])
    })

    it('puts a binary key among the top-level keys, readable', async () => {
      await exec(api, 'SET "\\xff\\xfe" 1')
      const [db] = await session.children(null, signal)
      const [leaf] = await session.children(db!, signal)
      expect(leaf!.label).toBe('\\xff\\xfe')
      expect(JSON.parse(leaf!.id)[2]!.startsWith('\u0000')).toBe(true)
    })

    it('says when a database has more keys than it shows', async () => {
      for (let i = 0; i < TREE_KEY_LIMIT + 300; i++) fake.seed(0, `bulk:${i}`, 'x')
      const [db] = await session.children(null, signal)
      const top = await session.children(db!, signal)
      expect(top[0]).toMatchObject({ label: 'bulk:' })
      const level = await session.children(top[0]!, signal)
      expect(level.at(-1)).toMatchObject({ kind: 'info' })
      expect(level.length).toBeLessThanOrEqual(TREE_KEY_LIMIT + 1)
    })
  })

  describe('scanning', () => {
    it('pages through every key with the cursor, once each', async () => {
      for (let i = 0; i < 450; i++) fake.seed(0, `k${i}`, 'x')
      const seen = new Set<string>()
      let cursor: string | null = null
      let pages = 0
      do {
        const page = await api.scan({ db: 0, pattern: '', cursor, limit: 100 }, signal)
        for (const key of page.keys) seen.add(key.key)
        cursor = page.cursor
        pages++
        if (pages === 1) expect(page.total).toBe(450)
      } while (cursor !== null)
      expect(seen.size).toBe(450)
      expect(pages).toBeGreaterThan(1)
    })

    it('filters by pattern and by type, with the type and TTL of each key', async () => {
      await exec(api, 'SET user:1 a EX 100')
      await exec(api, 'HSET user:2 f v')
      await exec(api, 'SET other 1')
      const byPattern = await api.scan(
        { db: 0, pattern: 'user:*', cursor: null, limit: 50 },
        signal,
      )
      expect(byPattern.keys.map((k) => k.key).sort()).toEqual(['user:1', 'user:2'])
      const one = byPattern.keys.find((k) => k.key === 'user:1')!
      expect(one.type).toBe('string')
      expect(one.ttlMs).toBeGreaterThan(90_000)
      expect(byPattern.keys.find((k) => k.key === 'user:2')!.ttlMs).toBeNull()
      const hashes = await api.scan(
        { db: 0, pattern: '', type: 'hash', cursor: null, limit: 50 },
        signal,
      )
      expect(hashes.keys.map((k) => k.key)).toEqual(['user:2'])
    })

    it('filters by type on a server that cannot do it itself', async () => {
      const old = await startFakeRedis({ version: '5.0.14' })
      const s = await connect(old)
      await exec(s.redis!, 'SET a 1')
      await exec(s.redis!, 'HSET h f v')
      const page = await s.redis!.scan(
        { db: 0, pattern: '', type: 'hash', cursor: null, limit: 50 },
        signal,
      )
      expect(page.keys.map((k) => k.key)).toEqual(['h'])
      await s.close()
      await old.close()
    })

    it('leaves out a key that expired after it was found', async () => {
      await exec(api, 'SET short 1 PX 50')
      await exec(api, 'SET long 1')
      fake.advanceTime(100)
      const page = await api.scan({ db: 0, pattern: '', cursor: null, limit: 50 }, signal)
      expect(page.keys.map((k) => k.key)).toEqual(['long'])
    })

    it('stops when cancelled', async () => {
      const controller = new AbortController()
      controller.abort()
      await expect(
        api.scan({ db: 0, pattern: '', cursor: null, limit: 10 }, controller.signal),
      ).rejects.toThrow()
    })
  })

  describe('reading keys', () => {
    it('reports a missing key as none', async () => {
      expect(await api.key(0, 'nope', signal)).toMatchObject({ type: 'none', ttlMs: null })
    })

    it('reads a string with its TTL, size and encoding', async () => {
      await exec(api, 'SET s hello EX 100')
      const detail = await api.key(0, 's', signal)
      expect(detail).toMatchObject({ type: 'string', length: 5, encoding: 'embstr' })
      expect(detail.ttlMs).toBeGreaterThan(90_000)
      expect(
        await api.value({ db: 0, key: 's', type: 'string', cursor: null, count: 100 }, signal),
      ).toEqual({
        type: 'string',
        value: 'hello',
        bytes: 5,
        truncated: false,
      })
    })

    it('keeps the bytes of a string that is not text', async () => {
      await exec(api, 'SET b "\\xff\\x00ab"')
      const page = await api.value(
        { db: 0, key: 'b', type: 'string', cursor: null, count: 1 },
        signal,
      )
      expect(page).toMatchObject({ type: 'string', bytes: 4 })
      expect((page as { value: string }).value.startsWith('\u0000')).toBe(true)
    })

    it('cuts a very long string and says so', async () => {
      fake.seed(0, 'big', Buffer.alloc(STRING_LIMIT + 10, 'a'))
      const page = await api.value(
        { db: 0, key: 'big', type: 'string', cursor: null, count: 1 },
        signal,
      )
      expect(page).toMatchObject({ type: 'string', bytes: STRING_LIMIT + 10, truncated: true })
      expect((page as { value: string }).value.length).toBe(STRING_LIMIT)
    })

    it('pages a hash, a list, a set and a sorted set', async () => {
      for (let i = 0; i < 25; i++) {
        await exec(api, `HSET h f${i} v${i}`)
        await exec(api, `RPUSH l item${i}`)
        await exec(api, `SADD s m${i}`)
        await exec(api, `ZADD z ${i} z${i}`)
      }
      const walk = async (key: string, type: 'hash' | 'list' | 'set' | 'zset') => {
        let cursor: string | null = null
        const all: unknown[] = []
        let pages = 0
        do {
          const page = await api.value({ db: 0, key, type, cursor, count: 10 }, signal)
          if (page.type === 'string' || page.type === 'json' || page.type === 'other')
            throw new Error('type')
          all.push(...page.items)
          cursor = page.next
          pages++
        } while (cursor !== null)
        return { all, pages }
      }
      expect((await walk('h', 'hash')).all).toHaveLength(25)
      const list = await walk('l', 'list')
      expect(list.all).toHaveLength(25)
      expect(list.pages).toBe(3)
      expect(list.all[24] as { index: number; value: string }).toEqual({
        index: 24,
        value: 'item24',
      })
      expect((await walk('s', 'set')).all).toHaveLength(25)
      const zset = await walk('z', 'zset')
      expect(zset.all[3]).toEqual({ member: 'z3', score: 3 })
    })

    it('filters hash fields by a pattern', async () => {
      await exec(api, 'HSET h apple 1 banana 2 apricot 3')
      const page = await api.value(
        { db: 0, key: 'h', type: 'hash', cursor: null, count: 50, match: 'ap*' },
        signal,
      )
      expect(page).toMatchObject({ type: 'hash' })
      expect((page as { items: { field: string }[] }).items.map((i) => i.field).sort()).toEqual([
        'apple',
        'apricot',
      ])
    })

    it('reads infinite scores', async () => {
      await exec(api, 'ZADD z inf top -inf bottom 0 mid')
      const page = await api.value(
        { db: 0, key: 'z', type: 'zset', cursor: null, count: 10 },
        signal,
      )
      expect((page as { items: { member: string; score: number }[] }).items).toEqual([
        { member: 'bottom', score: -Infinity },
        { member: 'mid', score: 0 },
        { member: 'top', score: Infinity },
      ])
    })

    it('reads a stream newest first, and pages it', async () => {
      for (let i = 1; i <= 25; i++) await exec(api, `XADD st ${i}-0 n ${i}`)
      const first = await api.value(
        { db: 0, key: 'st', type: 'stream', cursor: null, count: 10 },
        signal,
      )
      if (first.type !== 'stream') throw new Error('type')
      expect(first.items.map((e) => e.id).slice(0, 2)).toEqual(['25-0', '24-0'])
      expect(first.items[0]!.fields).toEqual([['n', '25']])
      const second = await api.value(
        { db: 0, key: 'st', type: 'stream', cursor: first.next, count: 10 },
        signal,
      )
      if (second.type !== 'stream') throw new Error('type')
      expect(second.items[0]!.id).toBe('15-0')
      const third = await api.value(
        { db: 0, key: 'st', type: 'stream', cursor: second.next, count: 10 },
        signal,
      )
      if (third.type !== 'stream') throw new Error('type')
      expect(third.items.map((e) => e.id)).toEqual(['5-0', '4-0', '3-0', '2-0', '1-0'])
      expect(third.next).toBeNull()
    })

    it('reads a JSON document, and says "other" for a type it has no editor for', async () => {
      await exec(api, 'JSON.SET doc $ \'{"a":1}\'')
      expect(
        await api.value({ db: 0, key: 'doc', type: 'ReJSON-RL', cursor: null, count: 1 }, signal),
      ).toEqual({
        type: 'json',
        value: '{"a":1}',
      })
      expect(
        await api.value({ db: 0, key: 'x', type: 'bf', cursor: null, count: 1 }, signal),
      ).toEqual({
        type: 'other',
        name: 'bf',
      })
    })

    it('reports how much memory keys take', async () => {
      await exec(api, 'SET a hello')
      const [a, missing] = await api.memory(0, ['a', 'nope'], signal)
      expect(a).toBeGreaterThan(0)
      expect(missing).toBeNull()
    })
  })

  describe('streams and consumer groups', () => {
    it('lists groups, consumers and pending entries', async () => {
      await exec(api, 'XADD st 1-0 a 1')
      await exec(api, 'XADD st 2-0 a 2')
      await exec(api, 'XGROUP CREATE st workers 0')
      await exec(api, 'XREADGROUP GROUP workers alice COUNT 2 STREAMS st >')
      const info = await api.streamInfo(0, 'st', signal)
      expect(info).toMatchObject({ length: 2, lastGeneratedId: '2-0' })
      expect(info.groups).toEqual([
        { name: 'workers', consumers: 1, pending: 2, lastDeliveredId: '2-0', lag: 0 },
      ])
      const group = await api.streamGroup(0, 'st', 'workers', signal)
      expect(group.pendingTotal).toBe(2)
      expect(group.consumers).toEqual([{ name: 'alice', pending: 2, idleMs: expect.any(Number) }])
      expect(group.pending.map((p) => [p.id, p.consumer, p.deliveries])).toEqual([
        ['1-0', 'alice', 1],
        ['2-0', 'alice', 1],
      ])
    })
  })

  describe('changing keys', () => {
    const run = (key: string, edit: RedisEdit, db = 0) => api.edit(db, key, edit, signal)
    const value = async (
      key: string,
      type: 'hash' | 'list' | 'set' | 'zset' | 'string' = 'string',
    ) => api.value({ db: 0, key, type, cursor: null, count: 100 }, signal)

    it('sets a string and keeps its TTL', async () => {
      await exec(api, 'SET s old EX 1000')
      await run('s', { op: 'string.set', value: 'new' })
      expect(await value('s')).toMatchObject({ value: 'new' })
      expect((await api.key(0, 's', signal)).ttlMs).toBeGreaterThan(900_000)
    })

    it('keeps the TTL on a server that has no KEEPTTL', async () => {
      const old = await startFakeRedis({ version: '5.0.14' })
      const s = await connect(old)
      await exec(s.redis!, 'SET s old EX 1000')
      await s.redis!.edit(0, 's', { op: 'string.set', value: 'new' }, signal)
      expect((await s.redis!.key(0, 's', signal)).ttlMs).toBeGreaterThan(900_000)
      await s.close()
      await old.close()
    })

    it('does not overwrite another type with a string', async () => {
      await exec(api, 'HSET h f v')
      await expect(run('h', { op: 'string.set', value: 'x' })).rejects.toMatchObject({
        code: 'WRONG_TYPE',
      })
      expect(await api.key(0, 'h', signal)).toMatchObject({ type: 'hash' })
    })

    it('edits a hash: set, rename a field, delete', async () => {
      await run('h', { op: 'key.create', value: { type: 'hash', field: 'a', value: '1' } })
      await run('h', { op: 'hash.set', field: 'b', value: '2' })
      await run('h', { op: 'hash.rename', field: 'a', newField: 'c' })
      expect((await value('h', 'hash')) as { items: unknown[] }).toMatchObject({
        items: expect.arrayContaining([
          { field: 'c', value: '1' },
          { field: 'b', value: '2' },
        ]),
      })
      await expect(
        run('h', { op: 'hash.rename', field: 'c', newField: 'b' }),
      ).rejects.toMatchObject({
        code: 'EXISTS',
      })
      await run('h', { op: 'hash.delete', fields: ['b', 'c'] })
      expect((await api.key(0, 'h', signal)).type).toBe('none')
    })

    it('edits a list: push, set, remove at an index', async () => {
      await run('l', { op: 'key.create', value: { type: 'list', value: 'b' } })
      await run('l', { op: 'list.push', side: 'head', values: ['a'] })
      await run('l', { op: 'list.push', side: 'tail', values: ['c', 'd'] })
      await run('l', { op: 'list.set', index: 3, value: 'D' })
      await run('l', { op: 'list.remove', index: 1 })
      const page = (await value('l', 'list')) as { items: { value: string }[] }
      expect(page.items.map((i) => i.value)).toEqual(['a', 'c', 'D'])
      await expect(run('l', { op: 'list.remove', index: 10 })).rejects.toThrow(/index/i)
    })

    it('edits a set and a sorted set', async () => {
      await run('s', { op: 'key.create', value: { type: 'set', member: 'a' } })
      await run('s', { op: 'set.add', members: ['b', 'c'] })
      await run('s', { op: 'set.remove', members: ['a'] })
      expect(((await value('s', 'set')) as { items: string[] }).items.sort()).toEqual(['b', 'c'])
      await run('z', { op: 'key.create', value: { type: 'zset', member: 'a', score: 1 } })
      await run('z', { op: 'zset.add', member: 'a', score: 5.5 })
      await run('z', { op: 'zset.add', member: 'b', score: Infinity })
      await run('z', { op: 'zset.remove', members: ['b'] })
      expect(((await value('z', 'zset')) as { items: unknown[] }).items).toEqual([
        { member: 'a', score: 5.5 },
      ])
    })

    it('adds and deletes stream entries', async () => {
      await run('st', { op: 'key.create', value: { type: 'stream', fields: [['a', '1']] } })
      await run('st', { op: 'stream.add', id: '99999999999999-0', fields: [['b', '2']] })
      const page = (await api.value(
        { db: 0, key: 'st', type: 'stream', cursor: null, count: 10 },
        signal,
      )) as {
        items: { id: string }[]
      }
      expect(page.items).toHaveLength(2)
      await run('st', { op: 'stream.delete', ids: ['99999999999999-0'] })
      expect((await api.key(0, 'st', signal)).length).toBe(1)
    })

    it('sets and clears a TTL, and says when the key is gone', async () => {
      await exec(api, 'SET s 1')
      await run('s', { op: 'ttl.set', ttlMs: 60_000 })
      expect((await api.key(0, 's', signal)).ttlMs).toBeGreaterThan(50_000)
      await run('s', { op: 'ttl.clear' })
      expect((await api.key(0, 's', signal)).ttlMs).toBeNull()
      await expect(run('gone', { op: 'ttl.set', ttlMs: 1000 })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      await expect(run('gone', { op: 'ttl.clear' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('refuses to create a key that exists', async () => {
      await exec(api, 'SET s 1')
      await expect(
        run('s', { op: 'key.create', value: { type: 'string', value: '2' } }),
      ).rejects.toMatchObject({ code: 'EXISTS' })
      await expect(
        run('s', { op: 'key.create', value: { type: 'hash', field: 'a', value: '1' } }),
      ).rejects.toMatchObject({ code: 'EXISTS' })
      expect(await value('s')).toMatchObject({ value: '1' })
    })

    it('renames a key, and only over another when told to', async () => {
      await exec(api, 'SET a 1')
      await exec(api, 'SET b 2')
      await expect(
        run('a', { op: 'key.rename', newKey: 'b', overwrite: false }),
      ).rejects.toMatchObject({
        code: 'EXISTS',
      })
      await run('a', { op: 'key.rename', newKey: 'b', overwrite: true })
      expect(await value('b')).toMatchObject({ value: '1' })
      expect((await api.key(0, 'a', signal)).type).toBe('none')
      await expect(
        run('a', { op: 'key.rename', newKey: 'c', overwrite: false }),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    })

    it('copies a key, to another database too, with its TTL', async () => {
      await exec(api, 'SET a 1 EX 1000')
      await run('a', { op: 'key.copy', newKey: 'a2', overwrite: false, toDb: null })
      expect(await value('a2')).toMatchObject({ value: '1' })
      await run('a', { op: 'key.copy', newKey: 'a3', overwrite: false, toDb: 4 })
      expect(await api.key(4, 'a3', signal)).toMatchObject({ type: 'string' })
      await expect(
        run('a', { op: 'key.copy', newKey: 'a2', overwrite: false, toDb: null }),
      ).rejects.toMatchObject({ code: 'EXISTS' })
      await run('a', { op: 'key.copy', newKey: 'a2', overwrite: true, toDb: null })
    })

    it('copies on a server that has no COPY', async () => {
      const old = await startFakeRedis({ version: '5.0.14' })
      const s = await connect(old)
      await exec(s.redis!, 'HSET h f v')
      await exec(s.redis!, 'EXPIRE h 1000')
      await s.redis!.edit(
        0,
        'h',
        { op: 'key.copy', newKey: 'h2', overwrite: false, toDb: 2 },
        signal,
      )
      const copy = await s.redis!.key(2, 'h2', signal)
      expect(copy).toMatchObject({ type: 'hash' })
      expect(copy.ttlMs).toBeGreaterThan(900_000)
      await expect(
        s.redis!.edit(0, 'h', { op: 'key.copy', newKey: 'h2', overwrite: false, toDb: 2 }, signal),
      ).rejects.toMatchObject({ code: 'EXISTS' })
      await s.close()
      await old.close()
    })

    it('deletes a key', async () => {
      await exec(api, 'SET a 1')
      await run('a', { op: 'key.delete' })
      expect((await api.key(0, 'a', signal)).type).toBe('none')
    })

    it('works on keys and values of bytes that are not text', async () => {
      const key = '\u0000' + Buffer.from([0xff, 0xfe, 0x01]).toString('base64')
      await run(key, {
        op: 'key.create',
        value: { type: 'string', value: '\u0000' + Buffer.from([0x80]).toString('base64') },
      })
      expect(await api.key(0, key, signal)).toMatchObject({ type: 'string', length: 1 })
      await run(key, { op: 'key.rename', newKey: 'plain', overwrite: false })
      expect(await value('plain')).toMatchObject({
        value: '\u0000' + Buffer.from([0x80]).toString('base64'),
      })
    })

    it('says a key holds another type when a change does not fit it', async () => {
      await exec(api, 'SET s 1')
      await expect(run('s', { op: 'hash.set', field: 'a', value: '1' })).rejects.toMatchObject({
        code: 'WRONG_TYPE',
      })
    })
  })

  describe('counting and deleting many keys', () => {
    it('counts matching keys with progress', async () => {
      for (let i = 0; i < 2500; i++) fake.seed(0, `tmp:${i}`, 'x')
      fake.seed(0, 'keep', 'x')
      const progress: number[] = []
      const result = await api.count(0, 'tmp:*', undefined, signal, (p) => progress.push(p.matched))
      expect(result).toEqual({ count: 2500, complete: true })
      expect(progress.length).toBeGreaterThan(1)
      expect(progress.at(-1)).toBe(2500)
    })

    it('deletes matching keys in batches and leaves the rest', async () => {
      for (let i = 0; i < 2500; i++) fake.seed(0, `tmp:${i}`, 'x')
      fake.seed(0, 'keep', 'x')
      const deletes: number[] = []
      const result = await api.deleteMatching(0, 'tmp:*', undefined, signal, (p) =>
        deletes.push(p.deleted),
      )
      expect(result).toEqual({ deleted: 2500, complete: true })
      expect(deletes.length).toBeGreaterThan(1)
      expect(fake.keys(0)).toEqual(['keep'])
    })

    it('deletes only the keys of the chosen type', async () => {
      await exec(api, 'SET a:1 x')
      await exec(api, 'HSET a:2 f v')
      const result = await api.deleteMatching(0, 'a:*', 'hash', signal, () => undefined)
      expect(result.deleted).toBe(1)
      expect(fake.keys(0)).toEqual(['a:1'])
    })

    it('stops when cancelled and says how far it got', async () => {
      for (let i = 0; i < 5000; i++) fake.seed(0, `tmp:${i}`, 'x')
      const controller = new AbortController()
      const result = await api.deleteMatching(0, 'tmp:*', undefined, controller.signal, (p) => {
        if (p.deleted >= 1000) controller.abort()
      })
      expect(result.complete).toBe(false)
      expect(result.deleted).toBeGreaterThanOrEqual(1000)
      expect(result.deleted).toBeLessThan(5000)
      expect(fake.keys(0).length).toBe(5000 - result.deleted)
    })

    it('uses DEL on a server without UNLINK', async () => {
      const old = await startFakeRedis({ version: '3.2.0' })
      const s = await connect(old)
      for (let i = 0; i < 10; i++) old.seed(0, `t:${i}`, 'x')
      const result = await s.redis!.deleteMatching(0, 't:*', undefined, signal, () => undefined)
      expect(result.deleted).toBe(10)
      expect(old.keys(0)).toEqual([])
      await s.close()
      await old.close()
    })
  })

  describe('the console', () => {
    // A console is a connection of its own, so what one test leaves open (MULTI, SELECT) stays out of the others.
    let c: RedisApi
    let consoleSession: DriverSession
    beforeEach(async () => {
      consoleSession = await connect(fake)
      c = consoleSession.redis!
    })
    afterEach(async () => {
      await consoleSession.close()
    })

    it('tells a status reply, a string, a number, nothing and a list apart', async () => {
      expect(await exec(c, 'SET a 1')).toEqual({ t: 'status', text: 'OK' })
      expect(await exec(c, 'GET a')).toMatchObject({ t: 'bulk', text: '1', bytes: 1 })
      expect(await exec(c, 'INCR a')).toEqual({ t: 'int', value: 2 })
      expect(await exec(c, 'GET nothing')).toEqual({ t: 'nil' })
      const list = await exec(c, 'MGET a nothing')
      expect(list).toMatchObject({ t: 'array', omitted: 0 })
      expect((list as { items: unknown[] }).items).toHaveLength(2)
      expect(await exec(c, 'PING')).toEqual({ t: 'status', text: 'PONG' })
      expect(await exec(c, 'TYPE a')).toEqual({ t: 'status', text: 'string' })
    })

    it('returns an error reply as data, not as a failure', async () => {
      await exec(c, 'SET a 1')
      expect(await exec(c, 'HGET a f')).toMatchObject({
        t: 'error',
        text: expect.stringMatching(/^WRONGTYPE/),
      })
      expect(await exec(c, 'NOPE')).toMatchObject({
        t: 'error',
        text: expect.stringMatching(/unknown command/),
      })
    })

    it('runs a transaction, showing QUEUED as a status', async () => {
      expect(await exec(c, 'MULTI')).toEqual({ t: 'status', text: 'OK' })
      expect(await exec(c, 'SET a 1')).toEqual({ t: 'status', text: 'QUEUED' })
      expect(await exec(c, 'GET a')).toEqual({ t: 'status', text: 'QUEUED' })
      const result = await exec(c, 'EXEC')
      expect(result).toMatchObject({ t: 'array' })
      expect((result as { items: unknown[] }).items).toHaveLength(2)
      // What a write answers inside EXEC is shown as the status it is.
      expect((result as { items: unknown[] }).items[0]).toEqual({ t: 'status', text: 'OK' })
      // Out of the transaction, a string that says QUEUED is just a string.
      expect(await exec(c, 'SET q QUEUED')).toEqual({ t: 'status', text: 'OK' })
      expect(await exec(c, 'GET q')).toMatchObject({ t: 'bulk', text: 'QUEUED' })
    })

    it('follows SELECT and reports the database it is in', async () => {
      const result = await c.exec(['SELECT', '5'], signal)
      expect(result.db).toBe(5)
      expect((await c.exec(['SET', 'only5', '1'], signal)).db).toBe(5)
      expect(fake.keys(5)).toEqual(['only5'])
      await c.exec(['SELECT', '0'], signal)
    })

    it('sends arguments as the bytes they were typed as', async () => {
      const parsed = tokenize('SET key "caf\\xc3\\xa9 \\xff"')
      if (!parsed.ok) throw new Error('parse')
      await c.exec(parsed.args, signal)
      const stored = fake.log.at(-1)!
      expect(Buffer.from(stored[2]!, 'latin1')).toEqual(
        Buffer.from([...Buffer.from('café '), 0xff]),
      )
      expect(argBytes(parsed.args[2]!).length).toBe(7)
      const back = await exec(c, 'GET key')
      expect(back).toMatchObject({ t: 'bulk', binary: true, bytes: 7 })
    })

    it('refuses what turns the connection into a stream', async () => {
      await expect(exec(c, 'SUBSCRIBE news')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
      await expect(exec(c, 'MONITOR')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
      await expect(exec(c, 'HELLO 3')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
      await expect(exec(c, 'QUIT')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    })

    it('can stop a command that is waiting, by dropping its connection', async () => {
      const waiting = await connect(fake)
      const controller = new AbortController()
      const pending = waiting.redis!.exec(['BLPOP', 'nothing', '0'], controller.signal)
      setTimeout(() => controller.abort(), 50)
      await expect(pending).rejects.toThrow(/cancelled/)
      // The server has seen the connection go, and the session knows it is over.
      await expect(waiting.ping()).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
      await waiting.close()
    })
  })

  describe('the server', () => {
    it('reports its numbers and keyspace', async () => {
      await exec(api, 'SET a 1')
      await exec(api, 'SET b 2 EX 100')
      const info = await api.info(signal)
      expect(info).toMatchObject({
        flavor: 'Redis',
        version: '7.2.4',
        mode: 'standalone',
        role: 'master',
        databases: 16,
        keyspace: [{ db: 0, keys: 2, expires: 1 }],
      })
      expect(info.usedMemory).toBeGreaterThan(0)
      expect(info.sections.server!.redis_version).toBe('7.2.4')
    })
  })

  it('tells a session that was closed to reconnect', async () => {
    const s = await connect(fake)
    await s.close()
    await expect(s.ping()).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
    await expect(s.children(null, signal)).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
  })
})
