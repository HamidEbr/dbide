/**
 * Runs the RabbitMQ driver against a real broker with the management plugin. Skipped unless
 * DBIDE_TEST_RABBITMQ_URL is set, e.g.
 *
 *   DBIDE_TEST_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672 DBIDE_TEST_RABBITMQ_MANAGEMENT_PORT=15672 pnpm test
 *
 * The login needs the management tag and permissions on the vhost `/`. Everything the tests make is named
 * `dbide-it-<random>…` and removed at the end. The broker's statistics are updated every few seconds, so
 * counts are waited for rather than read at once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newConnectionDraft, type ConnectionConfig } from '@shared/connection'
import type { DriverSession } from '@shared/driver'
import type { QueueDetail } from '@shared/rabbitmq'
import { parseConnectionUri } from '@shared/uri'
import { rabbitmqDriver } from './driver'

const url = process.env.DBIDE_TEST_RABBITMQ_URL
const parsed = url ? parseConnectionUri(url) : null
const managementPort = process.env.DBIDE_TEST_RABBITMQ_MANAGEMENT_PORT ?? '15672'

const none = (): AbortSignal => new AbortController().signal

async function connect(
  overrides: { password?: string; port?: string } = {},
): Promise<DriverSession> {
  const config: ConnectionConfig = {
    ...newConnectionDraft('rabbitmq', 'it'),
    name: 'integration',
    host: parsed!.host,
    port: parsed!.port,
    username: parsed!.username ?? 'guest',
    database: '/',
    options: { managementPort: overrides.port ?? managementPort },
  }
  return rabbitmqDriver.connect({
    config,
    secrets: { password: overrides.password ?? parsed!.password ?? 'guest' },
    endpoint: { host: config.host, port: config.port },
    signal: none(),
  })
}

/** Waits for the broker's statistics to catch up with what was just done. */
async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ms = 20_000,
): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() - started > ms)
      throw new Error(
        `The broker never showed what was expected: ${JSON.stringify(value).slice(0, 300)}`,
      )
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

describe.skipIf(!parsed)('RabbitMQ driver (live broker)', { timeout: 60_000 }, () => {
  const run = Math.random().toString(16).slice(2, 8)
  const name = (what: string): string => `dbide-it-${run}.${what}`
  const orders = name('orders')
  const audit = name('audit')
  const events = name('events')
  const odd = `dbide-it-${run} odd/name #1 %41 é`
  let session: DriverSession
  const broker = () => session.broker!
  const queue = (which: string): Promise<QueueDetail> => broker().queue('/', which, none())

  beforeAll(async () => {
    session = await connect()
    await broker().declareExchange(
      '/',
      {
        name: events,
        type: 'topic',
        durable: true,
        autoDelete: false,
        internal: false,
        arguments: {},
      },
      none(),
    )
    for (const q of [orders, audit]) {
      await broker().declareQueue(
        '/',
        { name: q, type: 'classic', durable: true, autoDelete: false, arguments: {} },
        none(),
      )
    }
    await broker().bind(
      '/',
      {
        source: events,
        destination: orders,
        destinationType: 'queue',
        routingKey: 'order.*',
        arguments: {},
      },
      none(),
    )
    await broker().bind(
      '/',
      {
        source: events,
        destination: audit,
        destinationType: 'queue',
        routingKey: '#',
        arguments: {},
      },
      none(),
    )
  })

  afterAll(async () => {
    const api = session.broker!
    for (const q of [orders, audit, name('quorum'), name('stream'), name('args'), odd]) {
      await api.deleteQueue('/', q, none()).catch(() => undefined)
    }
    for (const e of [events, name('fan')])
      await api.deleteExchange('/', e, none()).catch(() => undefined)
    await session.close()
  })

  it('logs in, and says which broker it is', () => {
    expect(session.info.serverVersion).toMatch(/^\d+\.\d+/)
    expect(session.info.currentDatabase).toBe('/')
  })

  it('turns away a wrong password and a port with nothing behind it, in words', async () => {
    await expect(connect({ password: `nope-${run}` })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: expect.stringContaining('refused the login'),
    })
    await expect(connect({ port: '1' })).rejects.toMatchObject({
      code: 'UNREACHABLE',
      message: expect.stringContaining('management plugin'),
    })
  })

  it('shows the broker: version, totals, nodes, listeners and who is signed in', async () => {
    const overview = await broker().overview(none())
    expect(overview.version).toBe(session.info.serverVersion)
    expect(overview.user.name).toBe(parsed!.username ?? 'guest')
    expect(overview.user.tags.length).toBeGreaterThan(0)
    expect(overview.listeners.some((l) => l.protocol === 'amqp')).toBe(true)
    expect(overview.totals.queues).toBeGreaterThanOrEqual(2)
    expect(overview.nodes.length).toBeGreaterThan(0)
  })

  it('lists the vhosts, and a vhost’s queues and exchanges', async () => {
    const roots = await session.children(null, none())
    expect(roots.some((n) => n.label === '/' && n.kind === 'vhost')).toBe(true)
    const listing = await broker().listing('/', none())
    expect(listing.queues.map((q) => q.name)).toEqual(expect.arrayContaining([orders, audit]))
    expect(listing.exchanges.map((e) => e.name)).toEqual(
      expect.arrayContaining(['', 'amq.direct', 'amq.topic', events]),
    )
    expect(listing.exchanges.find((e) => e.name === events)?.type).toBe('topic')
  })

  it('routes a published message to the queues bound for its key, and says when nothing took it', async () => {
    const message = {
      exchange: events,
      routingKey: 'order.created',
      payload: '{"id":1}',
      payloadEncoding: 'string' as const,
      properties: {
        contentType: 'application/json',
        messageId: 'm-1',
        deliveryMode: 2,
        headers: { attempt: 3, source: 'it' },
      },
    }
    expect(await broker().publish('/', message, none())).toEqual({ routed: true })
    expect(await broker().publish('/', { ...message, routingKey: 'audit.only' }, none())).toEqual({
      routed: true,
    })
    // No queue is bound for this exchange and key, and nothing is bound to a fresh exchange.
    await broker().declareExchange(
      '/',
      {
        name: name('fan'),
        type: 'direct',
        durable: true,
        autoDelete: false,
        internal: false,
        arguments: {},
      },
      none(),
    )
    expect(
      await broker().publish(
        '/',
        { ...message, exchange: name('fan'), routingKey: 'nobody' },
        none(),
      ),
    ).toEqual({ routed: false })
    // The default exchange sends to the queue named by the key.
    expect(
      await broker().publish(
        '/',
        { ...message, exchange: '', routingKey: orders, payload: 'direct' },
        none(),
      ),
    ).toEqual({ routed: true })

    const detail = await eventually(
      () => queue(orders),
      (q) => q.ready >= 2,
    )
    expect(detail.ready).toBe(2)
    expect(
      (
        await eventually(
          () => queue(audit),
          (q) => q.ready >= 2,
        )
      ).ready,
    ).toBe(2)
  })

  it('peeks without taking: the messages stay, and come back marked redelivered', async () => {
    const first = await broker().peek('/', orders, { count: 10, truncate: 100_000 }, none())
    expect(first.map((m) => m.payload)).toEqual(['{"id":1}', 'direct'])
    expect(first[0]).toMatchObject({
      exchange: events,
      routingKey: 'order.created',
      redelivered: false,
      payloadEncoding: 'string',
      payloadBytes: 8,
      truncated: false,
      properties: {
        contentType: 'application/json',
        messageId: 'm-1',
        deliveryMode: 2,
        headers: { attempt: 3, source: 'it' },
      },
    })
    const again = await broker().peek('/', orders, { count: 10, truncate: 100_000 }, none())
    expect(again).toHaveLength(2)
    expect(again.every((m) => m.redelivered)).toBe(true)
    expect((await queue(orders)).ready).toBe(2)
  })

  it('carries binary and long payloads as they are', async () => {
    const binary = Buffer.from([0, 1, 2, 250, 251, 252]).toString('base64')
    await broker().publish(
      '/',
      {
        exchange: '',
        routingKey: audit,
        payload: binary,
        payloadEncoding: 'base64',
        properties: {},
      },
      none(),
    )
    await broker().publish(
      '/',
      {
        exchange: '',
        routingKey: audit,
        payload: 'é'.repeat(300),
        payloadEncoding: 'string',
        properties: {},
      },
      none(),
    )
    await eventually(
      () => queue(audit),
      (q) => q.ready >= 4,
    )
    const messages = await broker().peek('/', audit, { count: 10, truncate: 100 }, none())
    const bin = messages.find((m) => m.payloadEncoding === 'base64')
    expect(Buffer.from(bin!.payload, 'base64')).toEqual(Buffer.from([0, 1, 2, 250, 251, 252]))
    const long = messages.find((m) => m.payloadBytes === 600)
    expect(long).toMatchObject({ truncated: true })
    expect(long!.payload.length).toBeLessThan(600)
  })

  it('creates queues of each type, with the arguments given', async () => {
    await broker().declareQueue(
      '/',
      { name: name('quorum'), type: 'quorum', durable: true, autoDelete: false, arguments: {} },
      none(),
    )
    expect(await queue(name('quorum'))).toMatchObject({ type: 'quorum', durable: true })
    await broker().declareQueue(
      '/',
      { name: name('stream'), type: 'stream', durable: true, autoDelete: false, arguments: {} },
      none(),
    )
    expect((await queue(name('stream'))).type).toBe('stream')
    await broker().declareQueue(
      '/',
      {
        name: name('args'),
        type: 'classic',
        durable: true,
        autoDelete: false,
        arguments: { 'x-max-length': 100, 'x-message-ttl': 60000 },
      },
      none(),
    )
    expect((await queue(name('args'))).arguments).toMatchObject({
      'x-max-length': 100,
      'x-message-ttl': 60000,
    })
  })

  it('refuses to redeclare a queue differently, and keeps the broker’s reason', async () => {
    await expect(
      broker().declareQueue(
        '/',
        { name: orders, type: 'classic', durable: false, autoDelete: false, arguments: {} },
        none(),
      ),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/PRECONDITION_FAILED|inequivalent/i),
    })
  })

  it('handles names with slashes, spaces, percent signs and accents', async () => {
    await broker().declareQueue(
      '/',
      { name: odd, type: 'classic', durable: true, autoDelete: false, arguments: {} },
      none(),
    )
    await broker().bind(
      '/',
      {
        source: events,
        destination: odd,
        destinationType: 'queue',
        routingKey: 'a/b c%20d é',
        arguments: {},
      },
      none(),
    )
    await broker().publish(
      '/',
      {
        exchange: events,
        routingKey: 'a/b c%20d é',
        payload: 'odd',
        payloadEncoding: 'string',
        properties: {},
      },
      none(),
    )
    const detail = await eventually(
      () => queue(odd),
      (q) => q.ready >= 1,
    )
    expect(detail.name).toBe(odd)
    // The broker lists the binding every queue has to the default exchange, by its own name, too.
    expect(detail.bindings.filter((b) => b.source !== '').map((b) => b.routingKey)).toEqual([
      'a/b c%20d é',
    ])
    expect(detail.bindings.find((b) => b.source === '')).toMatchObject({ routingKey: odd })
    expect((await broker().peek('/', odd, { count: 1, truncate: 1000 }, none()))[0]!.payload).toBe(
      'odd',
    )
    const binding = detail.bindings.find((b) => b.source !== '')!
    await broker().unbind(
      '/',
      {
        source: events,
        destination: odd,
        destinationType: 'queue',
        propertiesKey: binding.propertiesKey,
      },
      none(),
    )
    expect((await queue(odd)).bindings.filter((b) => b.source !== '')).toEqual([])
    await broker().deleteQueue('/', odd, none())
    await expect(queue(odd)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('describes an exchange with where it sends, and binds exchanges to exchanges', async () => {
    const detail = await broker().exchange('/', events, none())
    expect(detail.bindingsFrom.map((b) => [b.destination, b.routingKey]).sort()).toEqual(
      [
        [audit, '#'],
        [orders, 'order.*'],
      ].sort(),
    )
    await broker().bind(
      '/',
      {
        source: events,
        destination: name('fan'),
        destinationType: 'exchange',
        routingKey: 'x.#',
        arguments: {},
      },
      none(),
    )
    expect(
      (await broker().exchange('/', name('fan'), none())).bindingsTo.map((b) => b.source),
    ).toEqual([events])
    const defaultExchange = await broker().exchange('/', '', none())
    expect(defaultExchange).toMatchObject({ name: '', type: 'direct' })
  })

  it('reads a queue’s consumers and members, and tolerates a stream it cannot peek', async () => {
    const detail = await queue(name('quorum'))
    expect(detail.members.length).toBeGreaterThan(0)
    await expect(
      broker().peek('/', name('stream'), { count: 1, truncate: 1000 }, none()),
    ).rejects.toBeDefined()
  })

  it('purges a queue and deletes queues and exchanges', async () => {
    await broker().purge('/', orders, none())
    expect(
      (
        await eventually(
          () => queue(orders),
          (q) => q.ready === 0,
        )
      ).ready,
    ).toBe(0)
    await broker().deleteQueue('/', name('quorum'), none())
    await expect(queue(name('quorum'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await broker().deleteExchange('/', name('fan'), none())
    await expect(broker().exchange('/', name('fan'), none())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(broker().deleteExchange('/', 'amq.direct', none())).rejects.toBeDefined()
  })

  it('opens the tree to queues, exchanges and bindings', async () => {
    const [vhost] = (await session.children(null, none())).filter((n) => n.label === '/')
    const [queues, exchanges] = await session.children(vhost!, none())
    const orderNode = (await session.children(queues!, none())).find((n) => n.label === orders)!
    expect((await session.children(orderNode, none())).map((n) => [n.label, n.detail])).toEqual([
      [events, 'order.*'],
    ])
    const eventNode = (await session.children(exchanges!, none())).find((n) => n.label === events)!
    expect((await session.children(eventNode, none())).map((n) => n.label).sort()).toEqual(
      [`→ ${audit}`, `→ ${orders}`].sort(),
    )
  })

  it('stops a call that is cancelled', async () => {
    const controller = new AbortController()
    const call = broker().listing('/', controller.signal)
    controller.abort()
    await expect(call).rejects.toMatchObject({ name: 'AbortError' })
  })
})
