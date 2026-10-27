import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_EXPORT_OPTIONS } from '@shared/export'
import { RESIDENT_ROWS } from '@shared/query'
import { CoreEvents } from '@shared/api'
import { newConnectionDraft, secretKey, type ConnectionConfig } from '@shared/connection'
import type { HandlerContext } from '@shared/rpc'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { DriverRegistry } from './drivers/registry'
import { createFakeFiles } from './host-files'
import { SpillStore } from './results/spill'
import { createMemorySecrets, type SecretsClient } from './secrets'
import type { EditBatch } from '@shared/edit'
import type { DocumentEditBatch } from '@shared/mongo/documents'
import type { DriverSession, ResultBatch } from '@shared/driver'
import { createCoreHandlers } from './service'
import { SessionManager } from './session/manager'
import { openDatabase } from './storage/database'
import { fakeDriver, fakeSession, listenLocally } from './testing'

const ctx: HandlerContext = {
  signal: new AbortController().signal,
  portSignal: new AbortController().signal,
  emit: () => undefined,
}

function setup(
  options: {
    secrets?: SecretsClient
    drivers?: DriverRegistry
    files?: ReturnType<typeof createFakeFiles>
  } = {},
) {
  const notify = vi.fn()
  const files = options.files ?? createFakeFiles()
  const scriptsDir = join(tmpdir(), `dbide-service-${crypto.randomUUID()}`)
  const spill = new SpillStore(':memory:')
  const secrets = options.secrets ?? createMemorySecrets()
  const drivers =
    options.drivers ?? new DriverRegistry([fakeDriver('redis', undefined, { implemented: false })])
  const sessions = new SessionManager(drivers)
  const handlers = createCoreHandlers({
    db: openDatabase(':memory:'),
    secrets,
    drivers,
    sessions,
    notify,
    info: { version: '1.2.3', dataDir: '/data' },
    scriptsDir,
    files,
    spill,
  })
  return { handlers, notify, secrets, sessions, files, scriptsDir, spill }
}

const draft = (overrides: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  ...newConnectionDraft('redis', 'c1'),
  name: 'Cache',
  ...overrides,
})

describe('core service', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
  })

  it('reports app info', async () => {
    const info = await t.handlers['app.info'](undefined, ctx)
    expect(info).toMatchObject({ version: '1.2.3', dataDir: '/data' })
    expect(info.sqlite).toMatch(/^\d+\./)
  })

  it('lists the registered engines', async () => {
    expect(await t.handlers['engines.list'](undefined, ctx)).toHaveLength(1)
  })

  it('reads and updates settings', async () => {
    expect(await t.handlers['settings.get'](undefined, ctx)).toEqual(DEFAULT_SETTINGS)
    expect(await t.handlers['settings.set']({ theme: 'dark' }, ctx)).toMatchObject({
      theme: 'dark',
    })
    await expect(t.handlers['settings.set']({ nope: 1 } as never, ctx)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })

  it('saves a connection and keeps its password in the secret store only', async () => {
    const summary = await t.handlers['connections.save'](
      { config: draft(), secrets: { password: 'pw' } },
      ctx,
    )
    expect(summary).toMatchObject({ id: 'c1', name: 'Cache' })

    expect(await t.secrets.get(secretKey('c1', 'password'))).toBe('pw')
    const stored = await t.handlers['connections.get']({ id: 'c1' }, ctx)
    expect(stored).toMatchObject({ hasPassword: true })
    expect(JSON.stringify(stored?.config)).not.toContain('pw')
    expect(t.notify).toHaveBeenCalledWith(CoreEvents.connectionsChanged)
  })

  it('keeps the saved password when the form leaves it blank', async () => {
    await t.handlers['connections.save']({ config: draft(), secrets: { password: 'pw' } }, ctx)
    await t.handlers['connections.save'](
      { config: draft({ name: 'Renamed' }), secrets: { password: '' } },
      ctx,
    )
    expect(await t.secrets.get(secretKey('c1', 'password'))).toBe('pw')
    expect((await t.handlers['connections.list'](undefined, ctx))[0]?.name).toBe('Renamed')
  })

  it('rejects invalid connections before touching storage', async () => {
    await expect(
      t.handlers['connections.save']({ config: draft({ port: 0 }) }, ctx),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(await t.handlers['connections.list'](undefined, ctx)).toEqual([])
    expect(t.notify).not.toHaveBeenCalled()
  })

  it('deletes the connection and its secrets', async () => {
    await t.handlers['connections.save']({ config: draft(), secrets: { password: 'pw' } }, ctx)
    await t.handlers['connections.delete']({ id: 'c1' }, ctx)
    expect(await t.handlers['connections.list'](undefined, ctx)).toEqual([])
    expect(await t.secrets.get(secretKey('c1', 'password'))).toBeNull()
  })

  it('returns null for a connection that does not exist', async () => {
    expect(await t.handlers['connections.get']({ id: 'missing' }, ctx)).toBeNull()
  })

  it('refuses to store a password when no system keychain exists', async () => {
    const noKeychain: SecretsClient = {
      ...createMemorySecrets(),
      available: () => Promise.resolve(false),
    }
    const local = setup({ secrets: noKeychain })
    await expect(
      local.handlers['connections.save']({ config: draft(), secrets: { password: 'pw' } }, ctx),
    ).rejects.toMatchObject({ code: 'SECRETS_UNAVAILABLE' })
    // Saving without a password still works.
    await expect(
      local.handlers['connections.save']({ config: draft() }, ctx),
    ).resolves.toBeDefined()
  })

  it('tests a saved connection with its saved password when none is typed', async () => {
    const server = await listenLocally()
    try {
      let seen: unknown
      const driver = fakeDriver('redis', (context) => {
        seen = context.secrets
        return Promise.resolve(fakeSession())
      })
      const local = setup({ drivers: new DriverRegistry([driver]) })
      const config = draft({ host: '127.0.0.1', port: server.port })
      await local.handlers['connections.save']({ config, secrets: { password: 'saved' } }, ctx)

      const steps = await local.handlers['connections.test']({ config }, ctx)
      expect(steps.find((s) => s.id === 'auth')?.status).toBe('ok')
      expect(seen).toEqual({ password: 'saved' })

      await local.handlers['connections.test']({ config, secrets: { password: 'typed' } }, ctx)
      expect(seen).toEqual({ password: 'typed' })
    } finally {
      await server.close()
    }
  })
})

describe('row editing', () => {
  const batch: EditBatch = {
    schema: 'shop',
    table: 'orders',
    changes: [{ kind: 'update', key: { id: 1 }, values: { note: 'x' } }],
  }

  /** A MySQL-like driver whose sessions record what they were asked to do. */
  function editingSetup(
    options: { readOnly?: boolean; applyEdits?: DriverSession['applyEdits'] } = {},
  ) {
    const opened: { readOnly: boolean | undefined; closed: boolean; session: DriverSession }[] = []
    const driver = fakeDriver('mysql', (context) => {
      const session = fakeSession({
        info: { serverVersion: 'fake', currentDatabase: null, readOnly: context.readOnly === true },
        describeTable: (schema, table) =>
          Promise.resolve({ schema, table, columns: [], primaryKey: ['id'] }),
        applyEdits:
          options.applyEdits ??
          (() => Promise.resolve({ ok: true, results: [{ affectedRows: 1, insertId: null }] })),
        close: () => {
          entry.closed = true
          return Promise.resolve()
        },
      })
      const entry = { readOnly: context.readOnly, closed: false, session }
      opened.push(entry)
      return Promise.resolve(session)
    })
    const t = setup({ drivers: new DriverRegistry([driver]) })
    const config = { ...newConnectionDraft('mysql', 'm1'), name: 'Shop' }
    return { ...t, opened, config }
  }

  /** Opens the script session the way a run does, so edits have a script to belong to. */
  async function withScript(t: ReturnType<typeof editingSetup>, readOnly: boolean) {
    await t.handlers['connections.save']({ config: t.config }, ctx)
    await t.sessions.open('script:s1', t.config, {}, ctx.signal, { readOnly })
    t.opened.length = 0
  }

  it('describes a table through the connection session', async () => {
    const t = editingSetup()
    await t.handlers['connections.save']({ config: t.config }, ctx)
    const description = await t.handlers['tables.describe'](
      { connectionId: 'm1', schema: 'shop', table: 'orders' },
      ctx,
    )
    expect(description).toMatchObject({ schema: 'shop', table: 'orders', primaryKey: ['id'] })
    await expect(
      t.handlers['tables.describe']({ connectionId: 'm1', schema: '', table: 'orders' }, ctx),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('serves the names autocomplete suggests, and has none for an engine that cannot', async () => {
    const detail = { database: 'shop', tables: [], foreignKeys: [] }
    const driver = fakeDriver('mysql', () =>
      Promise.resolve(
        fakeSession({
          schemaDetail: (database) => Promise.resolve({ ...detail, database }),
          databaseNames: () => Promise.resolve(['shop', 'mysql']),
          tableColumns: () => Promise.resolve({ tables: [], foreignKeys: [] }),
        }),
      ),
    )
    const t = setup({ drivers: new DriverRegistry([driver]) })
    const config = { ...newConnectionDraft('mysql', 'm1'), name: 'Shop' }
    await t.handlers['connections.save']({ config }, ctx)
    expect(await t.handlers['schema.databases']({ connectionId: 'm1' }, ctx)).toEqual([
      'shop',
      'mysql',
    ])
    expect(
      await t.handlers['schema.detail']({ connectionId: 'm1', database: 'shop' }, ctx),
    ).toEqual(detail)
    await expect(
      t.handlers['schema.detail']({ connectionId: 'm1', database: '' }, ctx),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    await expect(
      t.handlers['schema.columns']({ connectionId: 'm1', database: 'shop', tables: [] }, ctx),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      t.handlers['schema.columns'](
        { connectionId: 'm1', database: 'shop', tables: Array(201).fill('t') },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(
      await t.handlers['schema.columns'](
        { connectionId: 'm1', database: 'shop', tables: ['a'] },
        ctx,
      ),
    ).toEqual({ tables: [], foreignKeys: [] })

    const bare = setup({ drivers: new DriverRegistry([fakeDriver('mysql')]) })
    await bare.handlers['connections.save']({ config }, ctx)
    expect(await bare.handlers['schema.databases']({ connectionId: 'm1' }, ctx)).toEqual([])
    expect(
      await bare.handlers['schema.detail']({ connectionId: 'm1', database: 'x' }, ctx),
    ).toEqual({
      database: 'x',
      tables: [],
      foreignKeys: [],
    })
  })

  it('drops a connection session that died of a timeout, so the next call reconnects', async () => {
    let opened = 0
    const driver = fakeDriver('mysql', () => {
      opened++
      return Promise.resolve(
        fakeSession({
          schemaDetail: () =>
            Promise.reject(Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' })),
        }),
      )
    })
    const t = setup({ drivers: new DriverRegistry([driver]) })
    await t.handlers['connections.save'](
      { config: { ...newConnectionDraft('mysql', 'm1'), name: 'Shop' } },
      ctx,
    )
    const ask = () => t.handlers['schema.detail']({ connectionId: 'm1', database: 'shop' }, ctx)
    await expect(ask()).rejects.toThrow('ETIMEDOUT')
    await expect(ask()).rejects.toThrow('ETIMEDOUT')
    expect(opened).toBe(2)
  })

  it('says when an engine cannot describe tables', async () => {
    const driver = fakeDriver('mysql', () => {
      const session = fakeSession()
      delete (session as Partial<DriverSession>).describeTable
      return Promise.resolve(session)
    })
    const t = setup({ drivers: new DriverRegistry([driver]) })
    await t.handlers['connections.save'](
      { config: { ...newConnectionDraft('mysql', 'm1'), name: 'x' } },
      ctx,
    )
    await expect(
      t.handlers['tables.describe']({ connectionId: 'm1', schema: 's', table: 't' }, ctx),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })

  it('puts a script’s server session in step with its lock, so unlocking takes effect at once', async () => {
    const t = editingSetup()
    await withScript(t, true)
    const live = t.sessions.peek('script:s1')!.session
    const setReadOnly = vi.fn((readOnly: boolean) => {
      Object.assign(live, { info: { ...live.info, readOnly } })
      return Promise.resolve()
    })
    live.setReadOnly = setReadOnly

    await t.handlers['scripts.setReadOnly']({ scriptId: 's1', readOnly: false }, ctx)
    expect(setReadOnly).toHaveBeenCalledWith(false)
    // Now an edit goes through, where before it would have been refused as read-only.
    expect(
      await t.handlers['edits.apply']({ connectionId: 'm1', scriptId: 's1', batch }, ctx),
    ).toMatchObject({ ok: true })

    await t.handlers['scripts.setReadOnly']({ scriptId: 's1', readOnly: false }, ctx)
    expect(setReadOnly).toHaveBeenCalledTimes(1)
  })

  it('has nothing to change for a script that has not run yet', async () => {
    const t = editingSetup()
    await expect(
      t.handlers['scripts.setReadOnly']({ scriptId: 'never-ran', readOnly: false }, ctx),
    ).resolves.toBeUndefined()
  })

  it('applies changes on a private, writable connection and closes it', async () => {
    const t = editingSetup()
    await withScript(t, false)
    const result = await t.handlers['edits.apply'](
      { connectionId: 'm1', scriptId: 's1', batch },
      ctx,
    )
    expect(result).toEqual({ ok: true, results: [{ affectedRows: 1, insertId: null }] })
    expect(t.opened).toHaveLength(1)
    expect(t.opened[0]).toMatchObject({ readOnly: false, closed: true })
  })

  it('never uses the script’s own connection, so its open transaction is left alone', async () => {
    const t = editingSetup()
    await withScript(t, false)
    const scriptSession = t.sessions.peek('script:s1')!.session
    const spy = vi.spyOn(scriptSession, 'applyEdits' as never)
    await t.handlers['edits.apply']({ connectionId: 'm1', scriptId: 's1', batch }, ctx)
    expect(spy).not.toHaveBeenCalled()
  })

  it('refuses when the script is read-only', async () => {
    const t = editingSetup()
    await withScript(t, true)
    await expect(
      t.handlers['edits.apply']({ connectionId: 'm1', scriptId: 's1', batch }, ctx),
    ).rejects.toMatchObject({ code: 'READ_ONLY' })
    expect(t.opened).toHaveLength(0)
  })

  it('asks for a fresh run when the script has no live session', async () => {
    const t = editingSetup()
    await t.handlers['connections.save']({ config: t.config }, ctx)
    await expect(
      t.handlers['edits.apply']({ connectionId: 'm1', scriptId: 'gone', batch }, ctx),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('passes an expected failure back as a result, not an exception', async () => {
    const failure = {
      ok: false as const,
      failedIndex: 2,
      code: 'ROW_COUNT',
      message: 'Nothing was saved.',
    }
    const t = editingSetup({ applyEdits: () => Promise.resolve(failure) })
    await withScript(t, false)
    expect(
      await t.handlers['edits.apply']({ connectionId: 'm1', scriptId: 's1', batch }, ctx),
    ).toEqual(failure)
  })

  it('closes the private connection even when applying throws', async () => {
    const t = editingSetup({ applyEdits: () => Promise.reject(new Error('socket hang up')) })
    await withScript(t, false)
    await expect(
      t.handlers['edits.apply']({ connectionId: 'm1', scriptId: 's1', batch }, ctx),
    ).rejects.toThrow('socket hang up')
    expect(t.opened[0]!.closed).toBe(true)
  })

  it('rejects a malformed batch before touching the database', async () => {
    const t = editingSetup()
    await withScript(t, false)
    await expect(
      t.handlers['edits.apply'](
        {
          connectionId: 'm1',
          scriptId: 's1',
          batch: { schema: 'shop', table: 'orders', changes: [] },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(t.opened).toHaveLength(0)
  })
})

describe('document editing', () => {
  const batch: DocumentEditBatch = {
    database: 'shop',
    collection: 'orders',
    changes: [{ kind: 'update', id: { $numberInt: '1' }, set: { note: 'x' }, unset: [] }],
  }

  /** A MongoDB-like driver whose sessions record what they were asked to do. */
  function mongoSetup(
    options: {
      applyDocumentEdits?: DriverSession['applyDocumentEdits']
      sampleFields?: DriverSession['sampleFields']
    } = {},
  ) {
    const opened: { readOnly: boolean | undefined; closed: boolean }[] = []
    const driver = fakeDriver('mongodb', (context) => {
      const entry = { readOnly: context.readOnly, closed: false }
      opened.push(entry)
      return Promise.resolve(
        fakeSession({
          info: {
            serverVersion: 'fake',
            currentDatabase: null,
            readOnly: context.readOnly === true,
            readOnlyEnforcedByServer: false,
          },
          applyDocumentEdits:
            options.applyDocumentEdits ??
            (() => Promise.resolve({ ok: true, results: [{ document: '{}' }], atomic: true })),
          ...(options.sampleFields ? { sampleFields: options.sampleFields } : {}),
          close: () => {
            entry.closed = true
            return Promise.resolve()
          },
        }),
      )
    })
    const t = setup({ drivers: new DriverRegistry([driver]) })
    const config = { ...newConnectionDraft('mongodb', 'g1'), name: 'Shop docs' }
    return { ...t, opened, config }
  }

  async function withScript(t: ReturnType<typeof mongoSetup>, readOnly: boolean) {
    await t.handlers['connections.save']({ config: t.config }, ctx)
    await t.sessions.open('script:s1', t.config, {}, ctx.signal, { readOnly })
    t.opened.length = 0
  }

  it('applies changes on a private, writable connection and closes it', async () => {
    const t = mongoSetup()
    await withScript(t, false)
    expect(
      await t.handlers['documents.apply']({ connectionId: 'g1', scriptId: 's1', batch }, ctx),
    ).toEqual({ ok: true, results: [{ document: '{}' }], atomic: true })
    expect(t.opened).toEqual([{ readOnly: false, closed: true }])
  })

  it('refuses when the script is read-only, and when it has not run', async () => {
    const t = mongoSetup()
    await withScript(t, true)
    await expect(
      t.handlers['documents.apply']({ connectionId: 'g1', scriptId: 's1', batch }, ctx),
    ).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(
      t.handlers['documents.apply']({ connectionId: 'g1', scriptId: 'gone', batch }, ctx),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(t.opened).toHaveLength(0)
  })

  it('passes an expected failure back as a result and closes the connection when it throws', async () => {
    const failure = {
      ok: false as const,
      failedIndex: 0,
      code: 'ROW_COUNT',
      message: 'Nothing was saved.',
      applied: 0,
    }
    const failing = mongoSetup({ applyDocumentEdits: () => Promise.resolve(failure) })
    await withScript(failing, false)
    expect(
      await failing.handlers['documents.apply']({ connectionId: 'g1', scriptId: 's1', batch }, ctx),
    ).toEqual(failure)

    const throwing = mongoSetup({ applyDocumentEdits: () => Promise.reject(new Error('hang up')) })
    await withScript(throwing, false)
    await expect(
      throwing.handlers['documents.apply']({ connectionId: 'g1', scriptId: 's1', batch }, ctx),
    ).rejects.toThrow('hang up')
    expect(throwing.opened[0]!.closed).toBe(true)
  })

  it('rejects a malformed batch before touching the database', async () => {
    const t = mongoSetup()
    await withScript(t, false)
    const call = (changes: unknown) =>
      t.handlers['documents.apply'](
        {
          connectionId: 'g1',
          scriptId: 's1',
          batch: { database: 'shop', collection: 'orders', changes } as never,
        },
        ctx,
      )
    await expect(call([])).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(call([{ kind: 'delete' }])).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(call([{ kind: 'insert', document: 'text' }])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(
      call([{ kind: 'update', id: 1, set: { a: () => 1 }, unset: [] }]),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(t.opened).toHaveLength(0)
  })

  it('samples the field names of a collection, and has none to offer for an engine that cannot', async () => {
    const t = mongoSetup({ sampleFields: () => Promise.resolve(['_id', 'name']) })
    await t.handlers['connections.save']({ config: t.config }, ctx)
    expect(
      await t.handlers['schema.fields'](
        { connectionId: 'g1', database: 'shop', collection: 'orders' },
        ctx,
      ),
    ).toEqual(['_id', 'name'])
    const plain = mongoSetup()
    await plain.handlers['connections.save']({ config: plain.config }, ctx)
    expect(
      await plain.handlers['schema.fields'](
        { connectionId: 'g1', database: 'shop', collection: 'orders' },
        ctx,
      ),
    ).toEqual([])
    await expect(
      plain.handlers['schema.fields']({ connectionId: 'g1', database: '', collection: 'x' }, ctx),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('writes a script for a MongoDB connection to a .mongodb file', async () => {
    const t = mongoSetup()
    await t.handlers['connections.save']({ config: t.config }, ctx)
    const created = await t.handlers['scripts.create'](
      {
        id: '22222222-2222-4222-8222-222222222222',
        connectionId: 'g1',
        database: 'shop',
        content: 'db.orders.find({})',
      },
      ctx,
    )
    expect(created).toMatchObject({ language: 'mongodb', name: 'Script' })
    expect(readdirSync(t.scriptsDir)).toEqual(['Script.mongodb'])
    rmSync(t.scriptsDir, { recursive: true, force: true })
  })
})

describe('broker calls', () => {
  /** A RabbitMQ-like driver whose broker records every call it gets. */
  function brokerSetup(options: { fail?: Error } = {}) {
    const calls: [string, ...unknown[]][] = []
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        calls.push([name, ...args.slice(0, -1)])
        return options.fail ? Promise.reject(options.fail) : Promise.resolve(undefined as never)
      }
    const broker = {
      overview: record('overview'),
      listing: record('listing'),
      queue: record('queue'),
      exchange: record('exchange'),
      peek: record('peek'),
      publish: (...args: unknown[]) => {
        calls.push(['publish', ...args.slice(0, -1)])
        return Promise.resolve({ routed: true })
      },
      purge: record('purge'),
      declareQueue: record('declareQueue'),
      deleteQueue: record('deleteQueue'),
      declareExchange: record('declareExchange'),
      deleteExchange: record('deleteExchange'),
      bind: record('bind'),
      unbind: record('unbind'),
    } as unknown as NonNullable<DriverSession['broker']>
    let opened = 0
    const driver = fakeDriver('rabbitmq', (context) => {
      opened++
      return Promise.resolve(
        fakeSession({
          broker,
          info: {
            serverVersion: 'fake',
            currentDatabase: '/',
            readOnly: context.readOnly === true,
            readOnlyEnforcedByServer: false,
          },
        }),
      )
    })
    const t = setup({ drivers: new DriverRegistry([driver]) })
    const config = { ...newConnectionDraft('rabbitmq', 'b1'), name: 'Queue server' }
    return { ...t, calls, config, opens: () => opened }
  }

  const publish = {
    exchange: 'ex',
    routingKey: 'k',
    payload: 'hi',
    payloadEncoding: 'string' as const,
    properties: { contentType: 'text/plain', headers: { a: 1 } },
  }

  it('reads through the connection’s shared session, opened once', async () => {
    const t = brokerSetup()
    await t.handlers['connections.save']({ config: t.config }, ctx)
    await t.handlers['broker.overview']({ connectionId: 'b1' }, ctx)
    await t.handlers['broker.listing']({ connectionId: 'b1', vhost: '/' }, ctx)
    await t.handlers['broker.queue']({ connectionId: 'b1', vhost: '/', name: 'q' }, ctx)
    await t.handlers['broker.exchange']({ connectionId: 'b1', vhost: '/', name: 'e' }, ctx)
    await t.handlers['broker.peek']({ connectionId: 'b1', vhost: '/', queue: 'q', count: 5 }, ctx)
    expect(t.calls.map((c) => c[0])).toEqual(['overview', 'listing', 'queue', 'exchange', 'peek'])
    expect(t.calls[4]).toEqual(['peek', '/', 'q', { count: 5, truncate: 100_000 }])
    expect(t.opens()).toBe(1)
  })

  it('refuses every change from a tab that has writes locked, before the broker hears of it', async () => {
    const t = brokerSetup()
    await t.handlers['connections.save']({ config: t.config }, ctx)
    const locked = { connectionId: 'b1', vhost: '/', writable: false }
    const refused = (call: unknown) =>
      expect(Promise.resolve(call)).rejects.toMatchObject({ code: 'READ_ONLY' })
    await refused(t.handlers['broker.publish']({ ...locked, request: publish }, ctx))
    await refused(t.handlers['broker.purge']({ ...locked, queue: 'q' }, ctx))
    await refused(t.handlers['broker.deleteQueue']({ ...locked, name: 'q' }, ctx))
    await refused(t.handlers['broker.deleteExchange']({ ...locked, name: 'e' }, ctx))
    await refused(
      t.handlers['broker.declareQueue'](
        {
          ...locked,
          request: { name: 'q', type: 'classic', durable: true, autoDelete: false, arguments: {} },
        },
        ctx,
      ),
    )
    await refused(
      t.handlers['broker.bind'](
        {
          ...locked,
          request: {
            source: 'e',
            destination: 'q',
            destinationType: 'queue',
            routingKey: '',
            arguments: {},
          },
        },
        ctx,
      ),
    )
    expect(t.calls).toEqual([])
    expect(t.opens()).toBe(0)
  })

  it('passes a change through once writes are unlocked', async () => {
    const t = brokerSetup()
    await t.handlers['connections.save']({ config: t.config }, ctx)
    const open = { connectionId: 'b1', vhost: 'shop', writable: true }
    expect(await t.handlers['broker.publish']({ ...open, request: publish }, ctx)).toEqual({
      routed: true,
    })
    await t.handlers['broker.purge']({ ...open, queue: 'q' }, ctx)
    await t.handlers['broker.deleteQueue']({ ...open, name: 'q' }, ctx)
    expect(t.calls).toEqual([
      ['publish', 'shop', publish],
      ['purge', 'shop', 'q'],
      ['deleteQueue', 'shop', 'q'],
    ])
  })

  it('says a connection that is not a broker has none', async () => {
    const t = setup({ drivers: new DriverRegistry([fakeDriver('mysql')]) })
    await t.handlers['connections.save'](
      { config: { ...newConnectionDraft('mysql', 'm1'), name: 'SQL' } },
      ctx,
    )
    await expect(t.handlers['broker.overview']({ connectionId: 'm1' }, ctx)).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    })
  })

  it('rejects malformed requests before touching the broker', async () => {
    const t = brokerSetup()
    await t.handlers['connections.save']({ config: t.config }, ctx)
    const bad = (call: unknown) =>
      expect(Promise.resolve(call)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const open = { connectionId: 'b1', vhost: '/', writable: true }
    await bad(
      t.handlers['broker.peek']({ connectionId: 'b1', vhost: '/', queue: 'q', count: 0 }, ctx),
    )
    await bad(
      t.handlers['broker.peek']({ connectionId: 'b1', vhost: '/', queue: 'q', count: 501 }, ctx),
    )
    await bad(
      t.handlers['broker.peek']({ connectionId: 'b1', vhost: '/', queue: '', count: 5 }, ctx),
    )
    await bad(t.handlers['broker.queue']({ connectionId: 'b1', vhost: '', name: 'q' }, ctx))
    await bad(
      t.handlers['broker.queue']({ connectionId: 'b1', vhost: '/', name: 'x'.repeat(256) }, ctx),
    )
    await bad(
      t.handlers['broker.purge']({ connectionId: 'b1', vhost: '/', queue: 'q' } as never, ctx),
    )
    await bad(
      t.handlers['broker.publish'](
        { ...open, request: { ...publish, payloadEncoding: 'hex' } } as never,
        ctx,
      ),
    )
    await bad(
      t.handlers['broker.publish'](
        { ...open, request: { ...publish, properties: { deliveryMode: 3 } } } as never,
        ctx,
      ),
    )
    await bad(
      t.handlers['broker.publish'](
        { ...open, request: { ...publish, properties: { headers: [1] } } } as never,
        ctx,
      ),
    )
    await bad(
      t.handlers['broker.declareQueue'](
        { ...open, request: { name: 'q', type: 'weird', arguments: {} } } as never,
        ctx,
      ),
    )
    await bad(
      t.handlers['broker.bind'](
        {
          ...open,
          request: {
            source: '',
            destination: 'q',
            destinationType: 'queue',
            routingKey: '',
            arguments: {},
          },
        },
        ctx,
      ),
    )
    await bad(
      t.handlers['broker.unbind'](
        {
          ...open,
          request: { source: 'e', destination: 'q', destinationType: 'topic', propertiesKey: '~' },
        } as never,
        ctx,
      ),
    )
    expect(t.calls).toEqual([])
  })

  it('drops a session that died, so the next call reconnects', async () => {
    const t = brokerSetup({
      fail: Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' }),
    })
    await t.handlers['connections.save']({ config: t.config }, ctx)
    await expect(t.handlers['broker.overview']({ connectionId: 'b1' }, ctx)).rejects.toThrow(
      'closed',
    )
    await expect(t.handlers['broker.overview']({ connectionId: 'b1' }, ctx)).rejects.toThrow(
      'closed',
    )
    expect(t.opens()).toBe(2)
  })

  it('says once, when a production broker opens, that RabbitMQ has no read-only session', async () => {
    const t = brokerSetup()
    await t.handlers['connections.save']({ config: { ...t.config, environment: 'prod' } }, ctx)
    const messages: string[] = []
    const context: HandlerContext = {
      ...ctx,
      emit: (event, payload) => {
        if (event === CoreEvents.notice) messages.push((payload as { message: string }).message)
      },
    }
    await t.handlers['broker.overview']({ connectionId: 'b1' }, context)
    await t.handlers['broker.overview']({ connectionId: 'b1' }, context)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(/RabbitMQ can’t hold a connection read-only/)
  })
})

describe('scripts', () => {
  const scriptId = '11111111-1111-4111-8111-111111111111'
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
  })
  afterEach(() => rmSync(t.scriptsDir, { recursive: true, force: true }))

  const create = (overrides = {}) =>
    t.handlers['scripts.create'](
      { id: scriptId, connectionId: 'c1', database: null, content: 'SELECT 1;', ...overrides },
      ctx,
    )

  it('creates a script, saves it, reads it back, and tells every window', async () => {
    expect(await create()).toMatchObject({ name: 'Script', connectionId: 'c1' })
    expect(t.notify).toHaveBeenCalledWith(CoreEvents.scriptsChanged)
    await t.handlers['scripts.save']({ id: scriptId, content: 'SELECT 2;' }, ctx)
    expect(await t.handlers['scripts.read']({ id: scriptId }, ctx)).toMatchObject({
      content: 'SELECT 2;',
      recovered: false,
    })
    expect(await t.handlers['scripts.list'](undefined, ctx)).toHaveLength(1)
  })

  it('reports where scripts live', async () => {
    expect((await t.handlers['app.info'](undefined, ctx)).scriptsDir).toBe(t.scriptsDir)
  })

  it('keeps a labelled version for local history', async () => {
    await create()
    await t.handlers['scripts.save']({ id: scriptId, content: 'SELECT 3;', label: 'run' }, ctx)
    const versions = await t.handlers['scripts.history']({ id: scriptId }, ctx)
    expect(versions[0]).toMatchObject({ label: 'run' })
    expect(
      await t.handlers['scripts.revision']({ id: scriptId, revisionId: versions[0]!.id }, ctx),
    ).toBe('SELECT 3;')
  })

  it('rejects malformed requests', async () => {
    await expect(create({ id: '../escape' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      t.handlers['scripts.save']({ id: scriptId, content: 5 as never }, ctx),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      t.handlers['scripts.save']({ id: scriptId, content: '', label: 'nope' as never }, ctx),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      t.handlers['scripts.setOpen']({ ids: ['x'], active: null }, ctx),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('renames, duplicates and deletes, closing the script’s connection and trashing the file', async () => {
    await create()
    expect(
      await t.handlers['scripts.rename']({ id: scriptId, name: 'Report' } as never, ctx),
    ).toMatchObject({
      name: 'Report',
    })
    const copy = await t.handlers['scripts.duplicate']({ id: scriptId }, ctx)
    expect(copy.name).toBe('Report copy')

    await t.sessions.open(
      'script:' + scriptId,
      { ...newConnectionDraft('redis', 'c1') },
      {},
      ctx.signal,
    )
    await t.handlers['scripts.delete']({ id: scriptId }, ctx)
    expect(t.sessions.has('script:' + scriptId)).toBe(false)
    expect(t.files.trashed).toEqual([join(t.scriptsDir, 'Report.sql')])
    expect(await t.handlers['scripts.list'](undefined, ctx)).toHaveLength(1)
  })

  it('imports the files the user picks, and says nothing happened if they pick none', async () => {
    expect(await t.handlers['scripts.import'](undefined, ctx)).toEqual({ imported: [], failed: [] })
    const source = mkdtempSync(join(tmpdir(), 'dbide-src-'))
    try {
      writeFileSync(join(source, 'legacy.sql'), 'SELECT 9;')
      const picked = setup({ files: createFakeFiles({ openPaths: [join(source, 'legacy.sql')] }) })
      const result = await picked.handlers['scripts.import'](undefined, ctx)
      expect(result.imported.map((s) => s.name)).toEqual(['legacy'])
      rmSync(picked.scriptsDir, { recursive: true, force: true })
    } finally {
      rmSync(source, { recursive: true, force: true })
    }
  })

  it('reveals a script’s file, or the folder', async () => {
    await create()
    await t.handlers['scripts.reveal']({ id: scriptId }, ctx)
    await t.handlers['scripts.reveal']({ id: null }, ctx)
    expect(t.files.revealed).toEqual([join(t.scriptsDir, 'Script.sql'), t.scriptsDir])
  })

  it('keeps the scripts of a deleted connection', async () => {
    await t.handlers['connections.save']({ config: draft() }, ctx)
    await create({ connectionId: 'c1' })
    await t.handlers['connections.delete']({ id: 'c1' }, ctx)
    const [script] = await t.handlers['scripts.list'](undefined, ctx)
    expect(script).toMatchObject({ id: scriptId, connectionId: null })
  })
})

describe('query history', () => {
  /** A driver that answers `SELECT` with two rows and anything with `bad` with an error. */
  function historySetup() {
    const driver = fakeDriver('mysql', () =>
      Promise.resolve(
        fakeSession({
          async *execute(request) {
            if (request.text.includes('bad')) throw new Error('no such table')
            yield { kind: 'columns', columns: [{ name: 'n', type: 'int' }] } as ResultBatch
            yield { kind: 'rows', rows: [[1], [2]] } as ResultBatch
          },
        }),
      ),
    )
    const t = setup({ drivers: new DriverRegistry([driver]) })
    const config = {
      ...newConnectionDraft('mysql', 'm1'),
      name: 'Shop',
      environment: 'prod' as const,
    }
    return { ...t, config }
  }
  const run = (t: ReturnType<typeof historySetup>, statements: string[]) =>
    t.handlers['query.run'](
      {
        runId: 'r' + Math.random(),
        scriptId: 's1',
        connectionId: 'm1',
        database: 'shop',
        readOnly: true,
        statements,
        pageSize: 1000,
      },
      ctx,
    )

  it('records each statement that ran, with the connection it ran on', async () => {
    const t = historySetup()
    await t.handlers['connections.save']({ config: t.config }, ctx)
    await run(t, ['SELECT 1', 'SELECT bad'])
    const { entries } = await t.handlers['history.list']({}, ctx)
    expect(entries.map((e) => [e.sql, e.status, e.rows])).toEqual([
      ['SELECT bad', 'error', null],
      ['SELECT 1', 'ok', 2],
    ])
    expect(entries[0]).toMatchObject({
      connectionId: 'm1',
      connectionName: 'Shop',
      environment: 'prod',
      database: 'shop',
      scriptId: 's1',
      errorMessage: 'no such table',
    })
  })

  it('tells windows the history changed, once for a burst', async () => {
    vi.useFakeTimers()
    try {
      const t = historySetup()
      await t.handlers['connections.save']({ config: t.config }, ctx)
      t.notify.mockClear()
      await run(t, ['SELECT 1', 'SELECT 2', 'SELECT 3'])
      expect(t.notify).not.toHaveBeenCalledWith(CoreEvents.historyChanged)
      await vi.advanceTimersByTimeAsync(300)
      expect(t.notify.mock.calls.filter(([e]) => e === CoreEvents.historyChanged)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('searches, filters and clears', async () => {
    const t = historySetup()
    await t.handlers['connections.save']({ config: t.config }, ctx)
    await run(t, ['SELECT 1', 'SELECT bad'])
    expect((await t.handlers['history.list']({ status: 'error' }, ctx)).entries).toHaveLength(1)
    expect((await t.handlers['history.list']({ search: 'select 1' }, ctx)).entries).toHaveLength(1)
    await expect(
      t.handlers['history.list']({ status: 'weird' as never }, ctx),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await t.handlers['history.clear']({}, ctx)
    expect((await t.handlers['history.list']({}, ctx)).entries).toEqual([])
  })

  it('records nothing while history is turned off', async () => {
    const t = historySetup()
    await t.handlers['connections.save']({ config: t.config }, ctx)
    await t.handlers['settings.set']({ recordHistory: false }, ctx)
    await run(t, ['SELECT 1'])
    expect((await t.handlers['history.list']({}, ctx)).entries).toEqual([])
  })

  it('records a run that could not connect', async () => {
    const driver = fakeDriver('mysql', () => Promise.reject(new Error('connection refused')))
    const t = setup({ drivers: new DriverRegistry([driver]) })
    await t.handlers['connections.save'](
      { config: { ...newConnectionDraft('mysql', 'm1'), name: 'Shop' } },
      ctx,
    )
    await run(t as never, ['SELECT 1'])
    expect((await t.handlers['history.list']({}, ctx)).entries[0]).toMatchObject({
      sql: 'SELECT 1',
      status: 'error',
      errorMessage: 'connection refused',
    })
  })
})

describe('export', () => {
  let out: string
  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), 'dbide-out-'))
  })
  afterEach(() => rmSync(out, { recursive: true, force: true }))

  function exportSetup(savePath: string | null) {
    const opened: { readOnly: boolean | undefined; closed: boolean }[] = []
    const driver = fakeDriver('mysql', (context) => {
      const entry = { readOnly: context.readOnly, closed: false }
      opened.push(entry)
      return Promise.resolve(
        fakeSession({
          async *execute() {
            yield { kind: 'columns', columns: [{ name: 'n', type: 'int' }] } as ResultBatch
            yield { kind: 'rows', rows: [[1], [2], [3]] } as ResultBatch
          },
          close: () => {
            entry.closed = true
            return Promise.resolve()
          },
        }),
      )
    })
    const t = setup({
      drivers: new DriverRegistry([driver]),
      files: createFakeFiles({ savePath }),
    })
    return { ...t, opened }
  }

  const params = (sql: string, overrides = {}) => ({
    exportId: 'e1',
    connectionId: 'm1',
    database: 'shop',
    sql,
    format: 'csv' as const,
    options: DEFAULT_EXPORT_OPTIONS,
    fileName: 'orders-2026-03-01.csv',
    ...overrides,
  })

  const save = (t: ReturnType<typeof exportSetup>) =>
    t.handlers['connections.save'](
      { config: { ...newConnectionDraft('mysql', 'm1'), name: 'Shop' } },
      ctx,
    )

  it('writes every row to the chosen file on a connection that cannot write', async () => {
    const path = join(out, 'orders.csv')
    const t = exportSetup(path)
    await save(t)
    const emitted: unknown[] = []
    const result = await t.handlers['export.run'](params('SELECT n FROM t'), {
      ...ctx,
      emit: (event, payload) => emitted.push([event, payload]),
    })
    expect(result).toMatchObject({ status: 'saved', path, rows: 3 })
    expect(readFileSync(path, 'utf8')).toBe('n\n1\n2\n3\n')
    expect(t.files.saveAsked).toEqual(['orders-2026-03-01.csv'])
    expect(t.opened).toEqual([{ readOnly: true, closed: true }])
    expect(emitted.at(-1)).toEqual([
      CoreEvents.exportProgress,
      { exportId: 'e1', rows: 3, bytes: 8 },
    ])
  })

  it('writes a gzip file when asked, and says so in the save dialog', async () => {
    const path = join(out, 'orders.csv.gz')
    const t = exportSetup(path)
    await save(t)
    const result = await t.handlers['export.run'](
      params('SELECT n FROM t', { compress: true }),
      ctx,
    )
    expect(result).toMatchObject({ status: 'saved', path, rows: 3 })
    expect(gunzipSync(readFileSync(path)).toString()).toBe('n\n1\n2\n3\n')
    expect(t.files.saveAsked).toEqual(['orders-2026-03-01.csv.gz'])
    // The size reported is the file's, not the text's.
    expect((result as { bytes: number }).bytes).toBe(readFileSync(path).length)
  })

  it('does not compress an Excel file, which is a zip already', async () => {
    const path = join(out, 'orders.xlsx')
    const t = exportSetup(path)
    await save(t)
    await t.handlers['export.run'](
      params('SELECT n FROM t', { format: 'xlsx', compress: true, fileName: 'orders.xlsx' }),
      ctx,
    )
    expect(t.files.saveAsked).toEqual(['orders.xlsx'])
    expect(readFileSync(path).subarray(0, 2).toString()).toBe('PK')
  })

  it('does nothing when the save dialog is dismissed', async () => {
    const t = exportSetup(null)
    await save(t)
    expect(await t.handlers['export.run'](params('SELECT 1'), ctx)).toEqual({ status: 'dismissed' })
    expect(t.opened).toEqual([])
  })

  it('only exports a query that reads, and only one at a time', async () => {
    const t = exportSetup(join(out, 'x.csv'))
    await save(t)
    for (const sql of [
      'DELETE FROM t',
      'UPDATE t SET a = 1',
      'SELECT * FROM t INTO OUTFILE "/tmp/x"',
      "select 1 into   dumpfile '/tmp/y'",
      'CALL purge()',
    ]) {
      await expect(t.handlers['export.run'](params(sql), ctx)).rejects.toMatchObject({
        code: 'NOT_A_QUERY',
      })
    }
    await expect(t.handlers['export.run'](params('SELECT 1; SELECT 2'), ctx)).rejects.toMatchObject(
      { code: 'INVALID_INPUT' },
    )
    expect(t.files.saveAsked).toEqual([])
    expect(t.opened).toEqual([])
  })

  it('lets a comment or a string mention OUTFILE', async () => {
    const t = exportSetup(join(out, 'x.csv'))
    await save(t)
    await expect(
      t.handlers['export.run'](params("SELECT 'INTO OUTFILE' AS s /* INTO DUMPFILE */"), ctx),
    ).resolves.toMatchObject({ status: 'saved' })
  })

  it('validates the options and the format', async () => {
    const t = exportSetup(join(out, 'x.csv'))
    await save(t)
    await expect(
      t.handlers['export.run'](params('SELECT 1', { format: 'pdf' }), ctx),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      t.handlers['export.run'](params('SELECT 1', { options: { delimiter: 'x' } }), ctx),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      t.handlers['export.run'](params('SELECT 1', { options: { rowsPerInsert: 0 } }), ctx),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('removes the partial file when the query fails, and closes the connection', async () => {
    const path = join(out, 'orders.csv')
    const driver = fakeDriver('mysql', () =>
      Promise.resolve(
        fakeSession({
          async *execute() {
            yield { kind: 'columns', columns: [{ name: 'n', type: 'int' }] } as ResultBatch
            yield { kind: 'rows', rows: [[1]] } as ResultBatch
            throw new Error('lost connection')
          },
        }),
      ),
    )
    const t = setup({
      drivers: new DriverRegistry([driver]),
      files: createFakeFiles({ savePath: path }),
    })
    await t.handlers['connections.save'](
      { config: { ...newConnectionDraft('mysql', 'm1'), name: 'Shop' } },
      ctx,
    )
    await expect(t.handlers['export.run'](params('SELECT n FROM t'), ctx)).rejects.toThrow(
      'lost connection',
    )
    expect(readdirSync(out)).toEqual([])
  })

  it('shows only files this session exported', async () => {
    const path = join(out, 'orders.csv')
    const t = exportSetup(path)
    await save(t)
    await t.handlers['export.run'](params('SELECT n FROM t'), ctx)
    await t.handlers['export.reveal']({ path }, ctx)
    expect(t.files.revealed).toEqual([path])
    await expect(t.handlers['export.reveal']({ path: '/etc/passwd' }, ctx)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

describe('big results', () => {
  const total = RESIDENT_ROWS + 500

  function bigSetup() {
    const driver = fakeDriver('mysql', () =>
      Promise.resolve(
        fakeSession({
          async *execute() {
            yield { kind: 'columns', columns: [{ name: 'n', type: 'int' }] } as ResultBatch
            yield {
              kind: 'rows',
              rows: Array.from({ length: total }, (_, i) => [i]),
            } as ResultBatch
          },
        }),
      ),
    )
    const t = setup({ drivers: new DriverRegistry([driver]) })
    const events: { type: string; count?: number; rows?: number }[] = []
    const run = async (runId: string, scriptId = 's1') => {
      await t.handlers['query.run'](
        {
          runId,
          scriptId,
          connectionId: 'm1',
          database: null,
          readOnly: true,
          statements: ['SELECT n FROM t'],
          pageSize: total + 10,
        },
        {
          ...ctx,
          emit: (_event, payload) => {
            const event = (payload as { event: { type: string; count?: number; rows?: unknown[] } })
              .event
            events.push({ type: event.type, count: event.count, rows: event.rows?.length })
          },
        },
      )
    }
    return { ...t, run, events }
  }

  const connect = (t: ReturnType<typeof bigSetup>) =>
    t.handlers['connections.save'](
      { config: { ...newConnectionDraft('mysql', 'm1'), name: 'Shop' } },
      ctx,
    )

  it('keeps the rows past what the window holds, and serves them a page at a time', async () => {
    const t = bigSetup()
    await connect(t)
    await t.run('r1')
    expect(t.events.filter((e) => e.type === 'rows').reduce((n, e) => n + (e.rows ?? 0), 0)).toBe(
      RESIDENT_ROWS,
    )
    expect(t.events.filter((e) => e.type === 'spilled')).toEqual([{ type: 'spilled', count: 500 }])

    const key = 'r1:0.0'
    expect(await t.handlers['results.fetch']({ key, from: 0, count: 3 }, ctx)).toEqual([
      [RESIDENT_ROWS],
      [RESIDENT_ROWS + 1],
      [RESIDENT_ROWS + 2],
    ])
    expect((await t.handlers['results.fetch']({ key, from: 498, count: 10 }, ctx)).length).toBe(2)
  })

  it('adds up the numbers in the held rows for the selection statistics', async () => {
    const t = bigSetup()
    await connect(t)
    await t.run('r1')
    const stats = await t.handlers['results.stats'](
      { key: 'r1:0.0', from: 0, count: 4, columns: [{ index: 0, type: 'int' }] },
      ctx,
    )
    const first = RESIDENT_ROWS
    expect(stats).toEqual({
      numeric: 4,
      sum: first * 4 + 6,
      min: first,
      max: first + 3,
      partial: false,
    })
  })

  it('lets go of the earlier run when the script runs again', async () => {
    const t = bigSetup()
    await connect(t)
    await t.run('r1')
    await t.run('r2')
    expect(await t.handlers['results.fetch']({ key: 'r1:0.0', from: 0, count: 5 }, ctx)).toEqual([])
    expect(
      (await t.handlers['results.fetch']({ key: 'r2:0.0', from: 0, count: 5 }, ctx)).length,
    ).toBe(5)
  })

  it('keeps another script’s results, and lets go of a script’s when it closes', async () => {
    const t = bigSetup()
    await connect(t)
    await t.run('r1', 's1')
    await t.run('r2', 's2')
    await t.handlers['scripts.close']({ scriptId: 's1' }, ctx)
    expect(await t.handlers['results.fetch']({ key: 'r1:0.0', from: 0, count: 5 }, ctx)).toEqual([])
    expect(
      (await t.handlers['results.fetch']({ key: 'r2:0.0', from: 0, count: 5 }, ctx)).length,
    ).toBe(5)
  })

  it('lets go of a script’s results when the window that ran it goes away', async () => {
    const t = bigSetup()
    await connect(t)
    const gone = new AbortController()
    await t.handlers['query.run'](
      {
        runId: 'r1',
        scriptId: 's1',
        connectionId: 'm1',
        database: null,
        readOnly: true,
        statements: ['SELECT n FROM t'],
        pageSize: total + 10,
      },
      { ...ctx, portSignal: gone.signal },
    )
    expect(
      (await t.handlers['results.fetch']({ key: 'r1:0.0', from: 0, count: 1 }, ctx)).length,
    ).toBe(1)
    gone.abort()
    expect(await t.handlers['results.fetch']({ key: 'r1:0.0', from: 0, count: 1 }, ctx)).toEqual([])
  })

  it('refuses malformed requests', async () => {
    const t = bigSetup()
    for (const bad of [
      { key: '', from: 0, count: 1 },
      { key: 'k', from: -1, count: 1 },
      { key: 'k', from: 0, count: 0 },
      { key: 'k', from: 0, count: 5001 },
      { key: 'k', from: 0.5, count: 1 },
    ]) {
      await expect(t.handlers['results.fetch'](bad, ctx)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      })
    }
    await expect(
      t.handlers['results.stats'](
        { key: 'k', from: 0, count: 1, columns: [{ index: -1, type: 'int' }] },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('a server that can not enforce read-only', () => {
  function oldServer(enforced: boolean | undefined) {
    const driver = fakeDriver('mysql', (context) =>
      Promise.resolve(
        fakeSession({
          info: {
            serverVersion: '5.5.62',
            currentDatabase: null,
            readOnly: context.readOnly === true,
            ...(enforced === undefined ? {} : { readOnlyEnforcedByServer: enforced }),
          },
        }),
      ),
    )
    const t = setup({ drivers: new DriverRegistry([driver]) })
    const notices: unknown[] = []
    const emitting = {
      ...ctx,
      emit: (event: string, payload?: unknown) => {
        if (event === CoreEvents.notice) notices.push(payload)
      },
    }
    return { ...t, notices, emitting }
  }
  const prod = {
    ...newConnectionDraft('mysql', 'm1'),
    name: 'Legacy',
    environment: 'prod' as const,
  }

  it('says so once for a read-only connection, naming the server', async () => {
    const t = oldServer(false)
    await t.handlers['connections.save']({ config: prod }, ctx)
    await t.handlers['tree.children']({ connectionId: 'm1', parent: null }, t.emitting)
    await t.handlers['tree.children']({ connectionId: 'm1', parent: null }, t.emitting)
    expect(t.notices).toHaveLength(1)
    expect((t.notices[0] as { message: string }).message).toMatch(/Legacy runs MySQL 5\.5\.62/)
  })

  it('says nothing for a server that enforces it, or for a connection that can write', async () => {
    const enforcing = oldServer(true)
    await enforcing.handlers['connections.save']({ config: prod }, ctx)
    await enforcing.handlers['tree.children'](
      { connectionId: 'm1', parent: null },
      enforcing.emitting,
    )
    expect(enforcing.notices).toEqual([])

    const unknown = oldServer(undefined)
    await unknown.handlers['connections.save']({ config: prod }, ctx)
    await unknown.handlers['tree.children']({ connectionId: 'm1', parent: null }, unknown.emitting)
    expect(unknown.notices).toEqual([])

    const dev = oldServer(false)
    await dev.handlers['connections.save'](
      { config: { ...prod, environment: 'dev' as const } },
      ctx,
    )
    await dev.handlers['tree.children']({ connectionId: 'm1', parent: null }, dev.emitting)
    expect(dev.notices).toEqual([])
  })

  it('says so again after the connection is edited, since the server may have changed', async () => {
    const t = oldServer(false)
    await t.handlers['connections.save']({ config: prod }, ctx)
    await t.handlers['tree.children']({ connectionId: 'm1', parent: null }, t.emitting)
    await t.handlers['connections.save']({ config: { ...prod, name: 'Legacy 2' } }, ctx)
    await t.handlers['tree.children']({ connectionId: 'm1', parent: null }, t.emitting)
    expect(t.notices).toHaveLength(2)
  })
})
