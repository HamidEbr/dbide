import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newConnectionDraft, type ConnectionConfig } from '@shared/connection'
import type { DriverSession, TreeNode } from '@shared/driver'
import { MAX_LISTED_QUEUES } from '@shared/rabbitmq'
import { startFakeBroker, type FakeBroker, type FakeBrokerOptions } from './fake-broker'
import { rabbitmqDriver } from './driver'
import { ManagementError } from './errors'
import { ManagementClient } from './http'

let broker: FakeBroker
let sessions: DriverSession[] = []
const none = (): AbortSignal => new AbortController().signal

async function open(
  overrides: Partial<ConnectionConfig> = {},
  password: string | undefined = 'guest',
  extra: { readOnly?: boolean } = {},
): Promise<DriverSession> {
  const config: ConnectionConfig = {
    ...newConnectionDraft('rabbitmq', 'r'),
    name: 'Broker',
    host: '127.0.0.1',
    username: 'guest',
    options: { managementPort: String(broker.port) },
    ...overrides,
  }
  const session = await rabbitmqDriver.connect({
    config,
    secrets: password === undefined ? {} : { password },
    endpoint: { host: config.host, port: config.port },
    signal: none(),
    ...(extra.readOnly ? { readOnly: true } : {}),
  })
  sessions.push(session)
  return session
}

async function withBroker(options?: FakeBrokerOptions): Promise<void> {
  await broker?.close()
  broker = await startFakeBroker(options)
}

beforeEach(async () => {
  await withBroker()
})
afterEach(async () => {
  for (const session of sessions) await session.close()
  sessions = []
  await broker.close()
})

describe('connecting', () => {
  it('logs in through the management API and reports the broker and the vhost', async () => {
    const session = await open({ database: 'shop' })
    expect(session.info).toEqual({
      serverVersion: '3.13.7',
      currentDatabase: 'shop',
      readOnly: false,
      readOnlyEnforcedByServer: false,
    })
    expect(session.broker).toBeDefined()
    expect((await open({}, 'guest', { readOnly: true })).info.readOnly).toBe(true)
    expect((await open()).info.currentDatabase).toBe('/')
  })

  it('uses guest when no login is given, and is turned away with the wrong password', async () => {
    await open({ username: undefined }, undefined)
    await expect(open({}, 'nope')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: expect.stringContaining('refused the login'),
    })
  })

  it('says what to do when the management API is not there', async () => {
    const dead = await startFakeBroker()
    const port = dead.port
    await dead.close()
    await expect(open({ options: { managementPort: String(port) } })).rejects.toMatchObject({
      code: 'UNREACHABLE',
      message: expect.stringMatching(/management plugin/),
    })
  })

  it('refuses a login that has no tag the management API accepts', async () => {
    await withBroker({ tags: ['impersonator'] })
    await expect(open()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringMatching(/management tag/),
    })
    await withBroker({ tags: [] })
    await open()
  })

  it('does not execute statements: RabbitMQ has none', async () => {
    const session = await open()
    await expect(
      (async () => {
        for await (const _ of session.execute({ text: 'x' }, none())) void _
      })(),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })

  it('refuses calls once closed', async () => {
    const session = await open()
    await session.close()
    await expect(session.ping()).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
    await expect(session.children(null, none())).rejects.toMatchObject({
      code: 'CONNECTION_CLOSED',
    })
  })
})

describe('the tree', () => {
  const label = (nodes: TreeNode[]): string[] => nodes.map((n) => n.label)

  beforeEach(() => {
    broker.addQueue('/', 'orders', { type: 'quorum' })
    broker.addMessages('/', 'orders', 12)
    broker.addQueue('/', 'audit')
    broker.addQueue('shop', 'carts')
    broker.state.exchanges.push({
      name: 'events',
      vhost: '/',
      type: 'topic',
      durable: true,
      auto_delete: false,
      internal: false,
      arguments: {},
    })
    broker.state.bindings.push({
      source: 'events',
      vhost: '/',
      destination: 'orders',
      destination_type: 'queue',
      routing_key: 'order.*',
      arguments: {},
    })
  })

  it('lists the vhosts with how many messages they hold', async () => {
    const roots = await (await open()).children(null, none())
    expect(roots.map((n) => [n.label, n.kind, n.detail])).toEqual([
      ['/', 'vhost', '12 msgs'],
      ['shop', 'vhost', ''],
    ])
  })

  it('falls back to the vhost it was given when the login may not list them', async () => {
    await withBroker({ hideVhosts: true })
    broker.addQueue('/', 'a')
    const roots = await (await open({ database: '/' })).children(null, none())
    expect(label(roots)).toEqual(['/'])
    await expect((await open({ database: '' })).children(null, none())).resolves.toHaveLength(1)
  })

  it('shows a vhost as its queues and its exchanges, with counts', async () => {
    const session = await open()
    const [vhost] = await session.children(null, none())
    const groups = await session.children(vhost!, none())
    expect(groups.map((n) => [n.label, n.detail, n.hasChildren])).toEqual([
      ['Queues', '2', true],
      ['Exchanges', '6', true],
    ])
  })

  it('lists queues by name, with their type and what they hold', async () => {
    const session = await open()
    const [vhost] = await session.children(null, none())
    const [queues] = await session.children(vhost!, none())
    const nodes = await session.children(queues!, none())
    expect(nodes.map((n) => [n.label, n.kind, n.detail])).toEqual([
      ['audit', 'queue', 'empty'],
      ['orders', 'queue', 'quorum · 12 ready'],
    ])
    expect(nodes[0]).toMatchObject({ scope: '/', hasChildren: true })
  })

  it('lists the exchanges you made first and the broker’s own after', async () => {
    const session = await open()
    const [vhost] = await session.children(null, none())
    const groups = await session.children(vhost!, none())
    const nodes = await session.children(groups[1]!, none())
    expect(nodes.map((n) => [n.label, n.detail])).toEqual([
      ['events', 'topic'],
      ['(default)', 'direct'],
      ['amq.direct', 'direct'],
      ['amq.fanout', 'fanout'],
      ['amq.headers', 'headers'],
      ['amq.topic', 'topic'],
    ])
    expect(nodes.find((n) => n.label === '(default)')?.hasChildren).toBe(false)
  })

  it('opens a queue to its bindings, and an exchange to where it sends', async () => {
    const session = await open()
    const [vhost] = await session.children(null, none())
    const [queues, exchanges] = await session.children(vhost!, none())
    const queue = (await session.children(queues!, none())).find((n) => n.label === 'orders')!
    // The binding every queue has to the default exchange is implied, so it is not listed.
    expect((await session.children(queue, none())).map((n) => [n.label, n.detail])).toEqual([
      ['events', 'order.*'],
    ])
    const exchange = (await session.children(exchanges!, none())).find((n) => n.label === 'events')!
    expect((await session.children(exchange, none())).map((n) => [n.label, n.detail])).toEqual([
      ['→ orders', 'order.*'],
    ])
  })

  it('says how many queues it left out of a very long list', async () => {
    for (let i = 0; i < 1105; i++) broker.addQueue('shop', `q${String(i).padStart(4, '0')}`)
    const session = await open()
    const roots = await session.children(null, none())
    const [queues] = await session.children(
      roots.find((n) => n.label === 'shop')!,
      none(),
    )
    const nodes = await session.children(queues!, none())
    expect(nodes).toHaveLength(1001)
    expect(nodes[1000]).toMatchObject({
      kind: 'info',
      label: '106 more queues',
      hasChildren: false,
    })
  })

  it('refuses a node it does not know', async () => {
    const session = await open()
    await expect(
      session.children({ id: 'not json', label: 'x', kind: 'queue', hasChildren: false }, none()),
    ).rejects.toThrow(/Unknown tree node/)
  })
})

describe('the broker', () => {
  const api = async () => (await open()).broker!

  beforeEach(() => {
    broker.addQueue('/', 'orders')
    broker.addMessages('/', 'orders', 5, (i) => ({
      payload: i === 3 ? '{"id":4}' : `message ${i + 1}`,
      properties: {
        content_type: i === 3 ? 'application/json' : 'text/plain',
        delivery_mode: 2,
        headers: { n: i },
      },
    }))
  })

  it('shows the broker: version, totals, nodes and listeners', async () => {
    const overview = await (await api()).overview(none())
    expect(overview).toMatchObject({
      version: '3.13.7',
      erlangVersion: '26.2',
      user: { name: 'guest', tags: ['administrator'] },
      totals: { queues: 1, messages: 5, ready: 5 },
      rates: { publish: 1.5 },
      nodes: [{ name: 'rabbit@fake', running: true }],
    })
    expect(overview.listeners.map((l) => l.protocol)).toEqual(['amqp', 'http'])
  })

  it('lists a vhost in pages, and on an old broker that answers with a bare array', async () => {
    for (let i = 0; i < 1200; i++) broker.addQueue('/', `bulk-${i}`)
    const listing = await (await api()).listing('/', none())
    expect(listing.queues).toHaveLength(1201)
    expect(listing.queuesTotal).toBe(1201)
    expect(broker.state.requests.filter((r) => r.startsWith('GET /api/queues/%2F')).length).toBe(3)

    await withBroker({ oldPaging: true })
    broker.addQueue('/', 'a')
    expect((await (await api()).listing('/', none())).queues.map((q) => q.name)).toEqual(['a'])
  })

  it('stops listing at the most it will hold, and says how many there are', async () => {
    for (let i = 0; i < MAX_LISTED_QUEUES + 600; i++) broker.addQueue('/', `q${i}`)
    const listing = await (await api()).listing('/', none())
    expect(listing.queues).toHaveLength(MAX_LISTED_QUEUES)
    expect(listing.queuesTotal).toBe(MAX_LISTED_QUEUES + 601)
  })

  it('reuses a listing for a moment, and forgets it after a change', async () => {
    const session = await open()
    const b = session.broker!
    await b.listing('/', none())
    await b.listing('/', none())
    expect(broker.state.requests.filter((r) => r.startsWith('GET /api/queues/%2F')).length).toBe(1)
    await b.declareQueue(
      '/',
      { name: 'fresh', type: 'classic', durable: true, autoDelete: false, arguments: {} },
      none(),
    )
    expect((await b.listing('/', none())).queues.map((q) => q.name)).toContain('fresh')
  })

  it('lets a caller stop waiting for a listing without spoiling it for the others', async () => {
    const b = await api()
    const controller = new AbortController()
    const cancelled = b.listing('/', controller.signal)
    const other = b.listing('/', none())
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect((await other).queues.map((q) => q.name)).toEqual(['orders'])
    // Cancelled before it started: it never waits at all.
    await expect(b.listing('/', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('describes a queue with its bindings, the implicit one to the default exchange included', async () => {
    broker.state.bindings.push({
      source: 'amq.direct',
      vhost: '/',
      destination: 'orders',
      destination_type: 'queue',
      routing_key: 'k',
      arguments: {},
    })
    const detail = await (await api()).queue('/', 'orders', none())
    expect(detail).toMatchObject({ name: 'orders', ready: 5, node: 'rabbit@fake' })
    expect(detail.bindings.map((b) => [b.source, b.routingKey])).toEqual([
      ['', 'orders'],
      ['amq.direct', 'k'],
    ])
    await expect((await api()).queue('/', 'ghost', none())).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'The queue “ghost” was not found.',
    })
  })

  it('describes an exchange, the default one included', async () => {
    broker.state.bindings.push({
      source: 'amq.fanout',
      vhost: '/',
      destination: 'orders',
      destination_type: 'queue',
      routing_key: '',
      arguments: {},
    })
    const detail = await (await api()).exchange('/', 'amq.fanout', none())
    expect(detail).toMatchObject({ name: 'amq.fanout', type: 'fanout' })
    expect(detail.bindingsFrom).toHaveLength(1)
    expect((await (await api()).exchange('/', '', none())).name).toBe('')
  })

  it('peeks at messages without taking them, and they come back marked as delivered', async () => {
    const b = await api()
    const first = await b.peek('/', 'orders', { count: 3, truncate: 100_000 }, none())
    expect(first.map((m) => [m.index, m.payload, m.redelivered, m.remaining])).toEqual([
      [1, 'message 1', false, 4],
      [2, 'message 2', false, 3],
      [3, 'message 3', false, 2],
    ])
    expect(first[0]).toMatchObject({
      routingKey: 'orders',
      properties: { contentType: 'text/plain', deliveryMode: 2, headers: { n: 0 } },
    })
    const again = await b.peek('/', 'orders', { count: 10, truncate: 100_000 }, none())
    expect(again).toHaveLength(5)
    // The three that were looked at before are marked; the two that were not are not.
    expect(again.map((m) => m.redelivered)).toEqual([true, true, true, false, false])
    expect((await b.queue('/', 'orders', none())).ready).toBe(5)
  })

  it('cuts a payload longer than it was told to read, and says so', async () => {
    broker.addMessages('/', 'orders', 1, () => ({ payload: 'x'.repeat(500) }))
    const messages = await (await api()).peek('/', 'orders', { count: 10, truncate: 100 }, none())
    const long = messages[messages.length - 1]!
    expect(long.payload).toHaveLength(100)
    expect(long).toMatchObject({ payloadBytes: 500, truncated: true })
  })

  it('publishes through an exchange, and says whether any queue took it', async () => {
    const b = await api()
    await b.declareQueue(
      '/',
      { name: 'tasks', type: 'classic', durable: true, autoDelete: false, arguments: {} },
      none(),
    )
    await b.declareExchange(
      '/',
      {
        name: 'work',
        type: 'topic',
        durable: true,
        autoDelete: false,
        internal: false,
        arguments: {},
      },
      none(),
    )
    await b.bind(
      '/',
      {
        source: 'work',
        destination: 'tasks',
        destinationType: 'queue',
        routingKey: 'job.#',
        arguments: {},
      },
      none(),
    )

    const request = {
      exchange: 'work',
      routingKey: 'job.email.send',
      payload: '{"to":"a@b.c"}',
      payloadEncoding: 'string' as const,
      properties: { contentType: 'application/json', headers: { attempt: 1 } },
    }
    expect(await b.publish('/', request, none())).toEqual({ routed: true })
    expect(await b.publish('/', { ...request, routingKey: 'other.thing' }, none())).toEqual({
      routed: false,
    })
    const [message] = await b.peek('/', 'tasks', { count: 1, truncate: 1000 }, none())
    expect(message).toMatchObject({
      exchange: 'work',
      routingKey: 'job.email.send',
      payload: '{"to":"a@b.c"}',
      properties: { contentType: 'application/json', headers: { attempt: 1 } },
    })

    // The default exchange sends to the queue named by the routing key.
    expect(await b.publish('/', { ...request, exchange: '', routingKey: 'tasks' }, none())).toEqual(
      { routed: true },
    )
    expect(
      await b.publish('/', { ...request, exchange: '', routingKey: 'nobody' }, none()),
    ).toEqual({ routed: false })
    expect((await b.queue('/', 'tasks', none())).ready).toBe(2)
  })

  it('purges a queue, and creates and deletes queues and exchanges', async () => {
    const b = await api()
    await b.purge('/', 'orders', none())
    expect((await b.queue('/', 'orders', none())).ready).toBe(0)

    await b.declareQueue(
      '/',
      {
        name: 'events',
        type: 'quorum',
        durable: true,
        autoDelete: false,
        arguments: { 'x-max-length': 100 },
      },
      none(),
    )
    expect(await b.queue('/', 'events', none())).toMatchObject({
      type: 'quorum',
      arguments: { 'x-queue-type': 'quorum', 'x-max-length': 100 },
    })
    await b.declareQueue(
      '/',
      { name: 'plain', type: 'classic', durable: false, autoDelete: true, arguments: {} },
      none(),
    )
    expect((await b.queue('/', 'plain', none())).arguments).toEqual({})
    await b.deleteQueue('/', 'events', none())
    await expect(b.queue('/', 'events', none())).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await b.declareExchange(
      '/',
      {
        name: 'fan',
        type: 'fanout',
        durable: true,
        autoDelete: false,
        internal: false,
        arguments: {},
      },
      none(),
    )
    expect((await b.exchange('/', 'fan', none())).type).toBe('fanout')
    await b.deleteExchange('/', 'fan', none())
    await expect(b.exchange('/', 'fan', none())).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('binds a queue and an exchange, and removes a binding by its key', async () => {
    const b = await api()
    await b.declareExchange(
      '/',
      {
        name: 'a',
        type: 'direct',
        durable: true,
        autoDelete: false,
        internal: false,
        arguments: {},
      },
      none(),
    )
    await b.declareExchange(
      '/',
      {
        name: 'b',
        type: 'fanout',
        durable: true,
        autoDelete: false,
        internal: false,
        arguments: {},
      },
      none(),
    )
    await b.bind(
      '/',
      {
        source: 'a',
        destination: 'orders',
        destinationType: 'queue',
        routingKey: 'x/y z',
        arguments: {},
      },
      none(),
    )
    await b.bind(
      '/',
      { source: 'a', destination: 'b', destinationType: 'exchange', routingKey: '', arguments: {} },
      none(),
    )
    const detail = await b.exchange('/', 'a', none())
    expect(
      detail.bindingsFrom.map((x) => [x.destination, x.destinationType, x.routingKey]),
    ).toEqual([
      ['orders', 'queue', 'x/y z'],
      ['b', 'exchange', ''],
    ])
    expect((await b.exchange('/', 'b', none())).bindingsTo).toHaveLength(1)

    for (const binding of detail.bindingsFrom) {
      await b.unbind(
        '/',
        {
          source: 'a',
          destination: binding.destination,
          destinationType: binding.destinationType,
          propertiesKey: binding.propertiesKey,
        },
        none(),
      )
    }
    expect((await b.exchange('/', 'a', none())).bindingsFrom).toEqual([])
  })

  it('keeps the broker’s own reason when it refuses', async () => {
    const b = await api()
    await expect(
      b.declareQueue(
        '/',
        { name: 'orders', type: 'classic', durable: false, autoDelete: false, arguments: {} },
        none(),
      ),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('PRECONDITION_FAILED'),
    })
    // A refused action is not a refused login, though the broker answers both with 401.
    await expect(b.deleteExchange('/', 'amq.direct', none())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Access refused. This user may not do that.',
    })
    await expect(b.listing('missing', none())).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('the management client', () => {
  const hang = async () => {
    const server = createServer(() => undefined)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return {
      port,
      close: () => {
        server.closeAllConnections()
        server.close()
      },
    }
  }

  it('stops when cancelled', async () => {
    const server = await hang()
    const client = new ManagementClient({ baseUrl: new URL(`http://127.0.0.1:${server.port}/`) })
    const controller = new AbortController()
    const call = client.get('overview', { signal: controller.signal })
    setTimeout(() => controller.abort(), 30)
    await expect(call).rejects.toMatchObject({ name: 'AbortError' })
    client.close()
    server.close()
  })

  it('gives up on a broker that does not answer', async () => {
    const server = await hang()
    const client = new ManagementClient({ baseUrl: new URL(`http://127.0.0.1:${server.port}/`) })
    await expect(client.get('overview', { signal: none(), timeoutMs: 60 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
    client.close()
    server.close()
  })

  it('refuses a call that was cancelled before it started, and one after it was closed', async () => {
    const client = new ManagementClient({
      baseUrl: new URL(`http://127.0.0.1:${broker.port}/`),
      username: 'guest',
      password: 'guest',
    })
    const controller = new AbortController()
    controller.abort()
    await expect(client.get('overview', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    client.close()
    await expect(client.get('overview', { signal: none() })).rejects.toBeInstanceOf(ManagementError)
  })

  it('says it is not the management API when the answer is not JSON', async () => {
    const server = createServer((_request, response) => response.end('<html>hello</html>'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const client = new ManagementClient({
      baseUrl: new URL(
        `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`,
      ),
    })
    await expect(client.get('overview', { signal: none() })).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    })
    client.close()
    server.closeAllConnections()
    server.close()
  })
})
