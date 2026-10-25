import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CoreEvents } from '@shared/api'
import { newConnectionDraft, type ConnectionConfig } from '@shared/connection'
import type { HandlerContext } from '@shared/rpc'
import { DriverRegistry } from './drivers/registry'
import { redisDriver } from './drivers/redis/driver'
import { startFakeRedis, type FakeRedis } from './drivers/redis/fake-redis'
import { createFakeFiles } from './host-files'
import { fakeDriver } from './testing'
import { SpillStore } from './results/spill'
import { createMemorySecrets } from './secrets'
import { createCoreHandlers } from './service'
import { SessionManager } from './session/manager'
import { openDatabase } from './storage/database'

const quiet: HandlerContext = {
  signal: new AbortController().signal,
  portSignal: new AbortController().signal,
  emit: () => undefined,
}

function context(overrides: Partial<HandlerContext> = {}) {
  const emitted: [string, unknown][] = []
  const ctx: HandlerContext = {
    ...quiet,
    emit: (event, payload) => emitted.push([event, payload]),
    ...overrides,
  }
  return { ctx, emitted }
}

describe('Redis calls', () => {
  let fake: FakeRedis

  beforeAll(async () => {
    fake = await startFakeRedis()
  })
  afterAll(async () => {
    await fake.close()
  })

  function setup(
    configOverrides: Partial<ConnectionConfig> = {},
    drivers = new DriverRegistry([redisDriver]),
  ) {
    const sessions = new SessionManager(drivers)
    const notify = vi.fn()
    const handlers = createCoreHandlers({
      db: openDatabase(':memory:'),
      secrets: createMemorySecrets(),
      drivers,
      sessions,
      notify,
      info: { version: '1.2.3', dataDir: '/data' },
      scriptsDir: join(tmpdir(), `dbide-redis-${crypto.randomUUID()}`),
      files: createFakeFiles(),
      spill: new SpillStore(':memory:'),
    })
    const config: ConnectionConfig = {
      ...newConnectionDraft('redis', 'r1'),
      name: 'Cache',
      host: fake.host,
      port: fake.port,
      ...configOverrides,
    }
    return { handlers, sessions, notify, config }
  }

  const save = async (t: ReturnType<typeof setup>) => {
    await t.handlers['connections.save']({ config: t.config }, quiet)
  }

  beforeEach(async () => {
    const t = setup()
    await save(t)
    await t.handlers['redis.exec'](
      { connectionId: 'r1', consoleId: 'wipe', writable: true, line: 'FLUSHALL' },
      quiet,
    )
    await t.sessions.closeAll()
  })

  it('reads through the connection’s shared session, opened once', async () => {
    const t = setup()
    await save(t)
    fake.seed(0, 'a', '1')
    const page = await t.handlers['redis.scan'](
      { connectionId: 'r1', db: 0, pattern: '', cursor: null, limit: 10 },
      quiet,
    )
    expect(page.keys.map((k) => k.key)).toEqual(['a'])
    expect(
      await t.handlers['redis.key']({ connectionId: 'r1', db: 0, key: 'a' }, quiet),
    ).toMatchObject({
      type: 'string',
    })
    expect(await t.handlers['redis.info']({ connectionId: 'r1' }, quiet)).toMatchObject({
      flavor: 'Redis',
    })
    expect(fake.clients()).toBeLessThanOrEqual(2)
    await t.sessions.closeAll()
  })

  it('lists the tree through tree.children', async () => {
    const t = setup()
    await save(t)
    fake.seed(0, 'user:1', 'x')
    const roots = await t.handlers['tree.children']({ connectionId: 'r1', parent: null }, quiet)
    expect(roots[0]).toMatchObject({ label: 'db0', kind: 'redis-db' })
    const level = await t.handlers['tree.children'](
      { connectionId: 'r1', parent: roots[0]! },
      quiet,
    )
    expect(level[0]).toMatchObject({ label: 'user:', kind: 'redis-prefix' })
    await t.sessions.closeAll()
  })

  it('refuses every change from a tab that has writes locked, before the server hears of it', async () => {
    const t = setup()
    await save(t)
    fake.seed(0, 'a', '1')
    const before = fake.log.length
    const locked = { connectionId: 'r1', db: 0, writable: false }
    const refused = (p: unknown) =>
      expect(Promise.resolve(p)).rejects.toMatchObject({ code: 'READ_ONLY' })
    await refused(
      t.handlers['redis.edit']({ ...locked, key: 'a', edit: { op: 'key.delete' } }, quiet),
    )
    await refused(
      t.handlers['redis.deleteMatching']({ ...locked, pattern: '*', taskId: 't' }, quiet),
    )
    expect(fake.log.slice(before).filter(([name]) => name === 'UNLINK' || name === 'DEL')).toEqual(
      [],
    )
    expect(fake.keys(0)).toEqual(['a'])
    await t.sessions.closeAll()
  })

  it('passes a change through once writes are unlocked', async () => {
    const t = setup()
    await save(t)
    fake.seed(0, 'a', '1')
    await t.handlers['redis.edit'](
      {
        connectionId: 'r1',
        db: 0,
        writable: true,
        key: 'a',
        edit: { op: 'string.set', value: '2' },
      },
      quiet,
    )
    const page = await t.handlers['redis.value'](
      { connectionId: 'r1', db: 0, key: 'a', type: 'string', cursor: null, count: 10 },
      quiet,
    )
    expect(page).toMatchObject({ value: '2' })
    await t.sessions.closeAll()
  })

  it('rejects malformed requests before touching the server', async () => {
    const t = setup()
    await save(t)
    const before = fake.log.length
    const bad = (p: unknown) =>
      expect(Promise.resolve(p)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await bad(
      t.handlers['redis.scan'](
        { connectionId: 'r1', db: -1, pattern: '', cursor: null, limit: 5 },
        quiet,
      ),
    )
    await bad(
      t.handlers['redis.scan'](
        { connectionId: 'r1', db: 0, pattern: 5, cursor: null, limit: 5 } as never,
        quiet,
      ),
    )
    await bad(
      t.handlers['redis.scan'](
        { connectionId: 'r1', db: 0, pattern: '', cursor: null, limit: 0 },
        quiet,
      ),
    )
    await bad(t.handlers['redis.key']({ connectionId: 'r1', db: 0, key: '' }, quiet))
    await bad(t.handlers['redis.memory']({ connectionId: 'r1', db: 0, keys: [] }, quiet))
    await bad(
      t.handlers['redis.edit'](
        { connectionId: 'r1', db: 0, writable: true, key: 'a', edit: { op: 'flush' } as never },
        quiet,
      ),
    )
    await bad(
      t.handlers['redis.edit'](
        {
          connectionId: 'r1',
          db: 0,
          writable: true,
          key: 'a',
          edit: { op: 'zset.add', member: 'm', score: NaN },
        },
        quiet,
      ),
    )
    await bad(
      t.handlers['redis.edit'](
        { connectionId: 'r1', db: 0, writable: true, key: 'a', edit: { op: 'ttl.set', ttlMs: 0 } },
        quiet,
      ),
    )
    await bad(
      t.handlers['redis.edit'](
        {
          connectionId: 'r1',
          db: 0,
          writable: true,
          key: 'a',
          edit: { op: 'stream.delete', ids: ['nope'] },
        },
        quiet,
      ),
    )
    await bad(
      t.handlers['redis.exec'](
        { connectionId: 'r1', consoleId: 'c', writable: true, line: 5 } as never,
        quiet,
      ),
    )
    expect(fake.log.length).toBe(before)
    await t.sessions.closeAll()
  })

  it('says a connection that is not Redis has none', async () => {
    const drivers = new DriverRegistry([redisDriver, fakeDriver('mongodb')])
    const t = setup({}, drivers)
    await t.handlers['connections.save'](
      { config: { ...newConnectionDraft('mongodb', 'm1'), name: 'Documents' } },
      quiet,
    )
    await expect(t.handlers['redis.info']({ connectionId: 'm1' }, quiet)).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    })
  })

  describe('the console', () => {
    it('keeps a console on its own connection, so MULTI and SELECT carry over', async () => {
      const t = setup()
      await save(t)
      const line = (consoleId: string, text: string, writable = true) =>
        t.handlers['redis.exec']({ connectionId: 'r1', consoleId, writable, line: text }, quiet)
      await line('c1', 'SELECT 4')
      expect((await line('c1', 'SET a 1')).db).toBe(4)
      // Another console is not in database 4.
      expect((await line('c2', 'PING')).db).toBe(0)
      expect(fake.keys(4)).toEqual(['a'])
      await t.handlers['redis.consoleClose']({ consoleId: 'c1' }, quiet)
      // A new console on the same id starts again from the connection's own database.
      expect((await line('c1', 'PING')).db).toBe(0)
      await t.sessions.closeAll()
    })

    it('never sends a command that may change data while it is locked', async () => {
      const t = setup()
      await save(t)
      const before = fake.log.length
      const line = (text: string) =>
        t.handlers['redis.exec'](
          { connectionId: 'r1', consoleId: 'c', writable: false, line: text },
          quiet,
        )
      await expect(line('SET a 1')).rejects.toMatchObject({ code: 'READ_ONLY' })
      await expect(line('FLUSHALL')).rejects.toMatchObject({ code: 'READ_ONLY' })
      await expect(line('EVAL "return 1" 0')).rejects.toMatchObject({ code: 'READ_ONLY' })
      await expect(line('mystery arg')).rejects.toThrow(/doesn’t know whether/)
      await expect(line('CONFIG SET maxmemory 1')).rejects.toMatchObject({ code: 'READ_ONLY' })
      expect(fake.log.length).toBe(before)
      // Reads, and the commands that only change the connection, still run.
      expect((await line('GET a')).reply).toEqual({ t: 'nil' })
      expect((await line('SELECT 1')).db).toBe(1)
      expect((await line('CONFIG GET databases')).reply).toMatchObject({ t: 'array' })
      await t.sessions.closeAll()
    })

    it('reports a line that cannot be read, and an empty one', async () => {
      const t = setup()
      await save(t)
      const line = (text: string) =>
        t.handlers['redis.exec'](
          { connectionId: 'r1', consoleId: 'c', writable: true, line: text },
          quiet,
        )
      await expect(line('SET a "unclosed')).rejects.toMatchObject({ code: 'SYNTAX' })
      await expect(line('   ')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await t.sessions.closeAll()
    })

    it('lifts a console’s lock the moment writes are unlocked', async () => {
      const t = setup()
      await save(t)
      const line = (writable: boolean, text: string) =>
        t.handlers['redis.exec'](
          { connectionId: 'r1', consoleId: 'c', writable, line: text },
          quiet,
        )
      await expect(line(false, 'SET a 1')).rejects.toMatchObject({ code: 'READ_ONLY' })
      expect((await line(true, 'SET a 1')).reply).toEqual({ t: 'status', text: 'OK' })
      await expect(line(false, 'SET a 2')).rejects.toMatchObject({ code: 'READ_ONLY' })
      await t.sessions.closeAll()
    })

    it('stops a waiting command and reconnects for the next one', async () => {
      const t = setup()
      await save(t)
      const controller = new AbortController()
      const { ctx } = context({ signal: controller.signal })
      const waiting = t.handlers['redis.exec'](
        { connectionId: 'r1', consoleId: 'w', writable: true, line: 'BLPOP nothing 0' },
        ctx,
      )
      setTimeout(() => controller.abort(), 60)
      await expect(waiting).rejects.toThrow()
      const next = await t.handlers['redis.exec'](
        { connectionId: 'r1', consoleId: 'w', writable: true, line: 'PING' },
        quiet,
      )
      expect(next.reply).toEqual({ t: 'status', text: 'PONG' })
      await t.sessions.closeAll()
    })

    it('closes its consoles when the connection is edited or deleted', async () => {
      const t = setup()
      await save(t)
      await t.handlers['redis.exec'](
        { connectionId: 'r1', consoleId: 'c', writable: true, line: 'PING' },
        quiet,
      )
      expect(t.sessions.has('console:c')).toBe(true)
      await t.handlers['connections.save']({ config: t.config }, quiet)
      expect(t.sessions.has('console:c')).toBe(false)
      await t.handlers['redis.exec'](
        { connectionId: 'r1', consoleId: 'c', writable: true, line: 'PING' },
        quiet,
      )
      await t.handlers['connections.delete']({ id: 'r1' }, quiet)
      expect(t.sessions.has('console:c')).toBe(false)
    })

    it('closes a console when its window goes away', async () => {
      const t = setup()
      await save(t)
      const port = new AbortController()
      const { ctx } = context({ portSignal: port.signal })
      await t.handlers['redis.exec'](
        { connectionId: 'r1', consoleId: 'gone', writable: true, line: 'PING' },
        ctx,
      )
      expect(t.sessions.has('console:gone')).toBe(true)
      port.abort()
      await vi.waitFor(() => expect(t.sessions.has('console:gone')).toBe(false))
    })
  })

  describe('long tasks', () => {
    it('counts and deletes by pattern, telling the window how far each has got', async () => {
      const t = setup()
      await save(t)
      for (let i = 0; i < 3000; i++) fake.seed(0, `tmp:${i}`, 'x')
      fake.seed(0, 'keep', 'x')
      const counting = context()
      const counted = await t.handlers['redis.count'](
        { connectionId: 'r1', db: 0, pattern: 'tmp:*', taskId: 'count' },
        counting.ctx,
      )
      expect(counted.count).toBe(3000)
      const last = counting.emitted.at(-1)!
      expect(last[0]).toBe(CoreEvents.redisProgress)
      expect(last[1]).toMatchObject({ taskId: 'count', matched: 3000 })

      const deleting = context()
      const deleted = await t.handlers['redis.deleteMatching'](
        { connectionId: 'r1', db: 0, writable: true, pattern: 'tmp:*', taskId: 'del' },
        deleting.ctx,
      )
      expect(deleted).toEqual({ deleted: 3000, complete: true })
      expect(deleting.emitted.at(-1)![1]).toMatchObject({ taskId: 'del', deleted: 3000 })
      expect(fake.keys(0)).toEqual(['keep'])
      await t.sessions.closeAll()
    })
  })

  it('says once, when a production Redis opens, that Redis has no read-only session', async () => {
    const t = setup({ environment: 'prod' })
    await save(t)
    const { ctx, emitted } = context()
    await t.handlers['redis.info']({ connectionId: 'r1' }, ctx)
    await t.handlers['redis.info']({ connectionId: 'r1' }, ctx)
    const notices = emitted.filter(([event]) => event === CoreEvents.notice)
    expect(notices).toHaveLength(1)
    expect((notices[0]![1] as { message: string }).message).toMatch(
      /Redis can’t hold a connection read-only/,
    )
    await t.sessions.closeAll()
  })

  it('drops a session that died, so the next call reconnects', async () => {
    const t = setup()
    await save(t)
    await t.handlers['redis.info']({ connectionId: 'r1' }, quiet)
    const key = 'conn:r1'
    expect(t.sessions.has(key)).toBe(true)
    // The connection goes away underneath the session.
    await t.sessions.peek(key)!.session.close()
    await expect(t.handlers['redis.info']({ connectionId: 'r1' }, quiet)).rejects.toMatchObject({
      code: 'CONNECTION_CLOSED',
    })
    expect(t.sessions.has(key)).toBe(false)
    expect(await t.handlers['redis.info']({ connectionId: 'r1' }, quiet)).toMatchObject({
      flavor: 'Redis',
    })
    await t.sessions.closeAll()
  })
})
