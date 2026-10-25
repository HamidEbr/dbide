import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/**
 * A small stand-in for the RabbitMQ management API, in memory, for tests and for the smoke test of the app.
 * It answers the calls the driver makes in the shapes the real broker uses, and routes published messages
 * to queues. It says nothing about how a real broker behaves under load; the live tests do that.
 * Not imported by production code.
 */

export interface FakeMessage {
  exchange: string
  routing_key: string
  payload: string
  payload_encoding: 'string' | 'base64'
  properties: Record<string, unknown>
  redelivered: boolean
}

interface FakeQueue {
  name: string
  vhost: string
  type: string
  durable: boolean
  auto_delete: boolean
  exclusive: boolean
  arguments: Record<string, unknown>
  messages: FakeMessage[]
  unacked: number
  consumers: number
  policy: string | null
}

interface FakeExchange {
  name: string
  vhost: string
  type: string
  durable: boolean
  auto_delete: boolean
  internal: boolean
  arguments: Record<string, unknown>
}

interface FakeBinding {
  source: string
  vhost: string
  destination: string
  destination_type: 'queue' | 'exchange'
  routing_key: string
  arguments: Record<string, unknown>
}

export interface FakeBrokerOptions {
  username?: string
  password?: string
  /** Tags of the login. Defaults to administrator. */
  tags?: string[]
  /** Answer the queue list as a bare array, as brokers before 3.7 do. */
  oldPaging?: boolean
  /** Answer 403 to the vhost list, as a login without access to it does. */
  hideVhosts?: boolean
}

export interface FakeBroker {
  port: number
  url: string
  /** What the broker holds, for a test to look at or change. */
  state: {
    vhosts: string[]
    queues: FakeQueue[]
    exchanges: FakeExchange[]
    bindings: FakeBinding[]
    /** Every request received, as `METHOD /api/path`. */
    requests: string[]
  }
  addQueue(vhost: string, name: string, extra?: Partial<FakeQueue>): FakeQueue
  addMessages(
    vhost: string,
    queue: string,
    count: number,
    make?: (i: number) => Partial<FakeMessage>,
  ): void
  close(): Promise<void>
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  const text = body === undefined ? '' : JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  })
  response.end(text)
}

const notFound = (response: ServerResponse): void =>
  json(response, 404, { error: 'Object Not Found', reason: 'Not Found' })

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(text === '' ? {} : (JSON.parse(text) as Record<string, unknown>))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

/** AMQP topic matching: `*` is one word, `#` is zero or more. */
function topicMatches(pattern: string, key: string): boolean {
  const p = pattern === '' ? [] : pattern.split('.')
  const k = key === '' ? [] : key.split('.')
  const walk = (i: number, j: number): boolean => {
    if (i === p.length) return j === k.length
    if (p[i] === '#') return walk(i + 1, j) || (j < k.length && walk(i, j + 1))
    if (j === k.length) return false
    return (p[i] === '*' || p[i] === k[j]) && walk(i + 1, j + 1)
  }
  return walk(0, 0)
}

const propertiesKey = (binding: FakeBinding): string =>
  binding.routing_key === '' && Object.keys(binding.arguments).length === 0
    ? '~'
    : encodeURIComponent(binding.routing_key)

export async function startFakeBroker(options: FakeBrokerOptions = {}): Promise<FakeBroker> {
  const username = options.username ?? 'guest'
  const password = options.password ?? 'guest'
  const tags = options.tags ?? ['administrator']

  const state: FakeBroker['state'] = {
    vhosts: ['/'],
    queues: [],
    exchanges: [],
    bindings: [],
    requests: [],
  }
  const builtIns = (vhost: string): FakeExchange[] =>
    ['', 'amq.direct', 'amq.fanout', 'amq.topic', 'amq.headers'].map((name) => ({
      name,
      vhost,
      type: name === '' || name === 'amq.direct' ? 'direct' : name.slice(4),
      durable: true,
      auto_delete: false,
      internal: false,
      arguments: {},
    }))
  state.exchanges.push(...builtIns('/'))

  const queueView = (q: FakeQueue): Record<string, unknown> => ({
    name: q.name,
    vhost: q.vhost,
    type: q.type,
    durable: q.durable,
    auto_delete: q.auto_delete,
    exclusive: q.exclusive,
    state: 'running',
    messages: q.messages.length + q.unacked,
    messages_ready: q.messages.length,
    messages_unacknowledged: q.unacked,
    consumers: q.consumers,
    policy: q.policy ?? undefined,
    arguments: q.arguments,
    node: 'rabbit@fake',
    message_stats: { publish_details: { rate: 0 }, deliver_get_details: { rate: 0 } },
  })

  const route = (
    vhost: string,
    exchange: string,
    key: string,
    seen = new Set<string>(),
  ): FakeQueue[] => {
    if (exchange === '') {
      const queue = state.queues.find((q) => q.vhost === vhost && q.name === key)
      return queue ? [queue] : []
    }
    if (seen.has(exchange)) return []
    seen.add(exchange)
    const found = state.exchanges.find((e) => e.vhost === vhost && e.name === exchange)
    if (!found) return []
    const out: FakeQueue[] = []
    for (const binding of state.bindings.filter(
      (b) => b.vhost === vhost && b.source === exchange,
    )) {
      const matches =
        found.type === 'fanout' ||
        (found.type === 'direct' && binding.routing_key === key) ||
        (found.type === 'topic' && topicMatches(binding.routing_key, key)) ||
        found.type === 'headers'
      if (!matches) continue
      if (binding.destination_type === 'queue') {
        const queue = state.queues.find((q) => q.vhost === vhost && q.name === binding.destination)
        if (queue && !out.includes(queue)) out.push(queue)
      } else {
        for (const queue of route(vhost, binding.destination, key, seen))
          if (!out.includes(queue)) out.push(queue)
      }
    }
    return out
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) =>
      json(response, 500, { error: 'server_error', reason: String(error) }),
    )
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://fake')
    const method = request.method ?? 'GET'
    state.requests.push(`${method} ${url.pathname}`)

    const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    if (request.headers.authorization !== expected) {
      return json(response, 401, { error: 'not_authorized', reason: 'Not_Authorized' })
    }
    if (!url.pathname.startsWith('/api/')) return notFound(response)

    const parts = url.pathname.slice('/api/'.length).split('/').map(decodeURIComponent)
    const [kind, vhost, name, ...rest] = parts
    const query = url.searchParams

    if (method === 'GET' && kind === 'whoami') return json(response, 200, { name: username, tags })
    if (method === 'GET' && kind === 'nodes') {
      return json(response, 200, [
        {
          name: 'rabbit@fake',
          running: true,
          mem_used: 120_000_000,
          mem_limit: 3_000_000_000,
          disk_free: 50_000_000_000,
          fd_used: 40,
          fd_total: 1024,
          uptime: 3_600_000,
        },
      ])
    }
    if (method === 'GET' && kind === 'overview') {
      const messages = state.queues.reduce((n, q) => n + q.messages.length, 0)
      return json(response, 200, {
        rabbitmq_version: '3.13.7',
        management_version: '3.13.7',
        erlang_version: '26.2',
        cluster_name: 'rabbit@fake',
        object_totals: {
          queues: state.queues.length,
          exchanges: state.exchanges.length,
          connections: 2,
          channels: 3,
          consumers: state.queues.reduce((n, q) => n + q.consumers, 0),
        },
        queue_totals: { messages, messages_ready: messages, messages_unacknowledged: 0 },
        message_stats: {
          publish_details: { rate: 1.5 },
          deliver_get_details: { rate: 0.5 },
          ack_details: { rate: 0.5 },
        },
        listeners: [
          { node: 'rabbit@fake', protocol: 'amqp', port: 5672 },
          { node: 'rabbit@fake', protocol: 'http', port: 15672 },
        ],
      })
    }
    if (method === 'GET' && kind === 'vhosts') {
      if (options.hideVhosts)
        return json(response, 403, {
          error: 'not_authorised',
          reason: 'User can only log in via localhost',
        })
      return json(
        response,
        200,
        state.vhosts.map((v) => {
          const queues = state.queues.filter((q) => q.vhost === v)
          const ready = queues.reduce((n, q) => n + q.messages.length, 0)
          return {
            name: v,
            description: v === '/' ? 'Default virtual host' : '',
            messages: ready,
            messages_ready: ready,
            messages_unacknowledged: 0,
          }
        }),
      )
    }

    if (vhost !== undefined && !state.vhosts.includes(vhost)) return notFound(response)

    if (kind === 'queues' && method === 'GET' && name === undefined) {
      const all = state.queues.filter((q) => q.vhost === vhost).map(queueView)
      if (options.oldPaging || !query.has('page')) return json(response, 200, all)
      const size = Number(query.get('page_size') ?? 100)
      const page = Number(query.get('page') ?? 1)
      const items = all.slice((page - 1) * size, page * size)
      return json(response, 200, {
        items,
        filtered_count: all.length,
        item_count: items.length,
        page,
        page_count: Math.max(1, Math.ceil(all.length / size)),
        page_size: size,
        total_count: all.length,
      })
    }
    if (kind === 'exchanges' && method === 'GET' && name === undefined) {
      return json(
        response,
        200,
        state.exchanges.filter((e) => e.vhost === vhost),
      )
    }

    if (kind === 'queues' && name !== undefined) {
      const queue = state.queues.find((q) => q.vhost === vhost && q.name === name)
      const action = rest[0]

      if (method === 'PUT' && action === undefined) {
        const body = await readBody(request)
        if (queue) {
          if (queue.durable !== (body.durable === true)) {
            return json(response, 400, {
              error: 'bad_request',
              reason: `PRECONDITION_FAILED - inequivalent arg 'durable' for queue '${name}' in vhost '${vhost}'`,
            })
          }
          return json(response, 204, undefined)
        }
        const args = (body.arguments ?? {}) as Record<string, unknown>
        state.queues.push({
          name,
          vhost: vhost!,
          type:
            typeof args['x-queue-type'] === 'string' ? (args['x-queue-type'] as string) : 'classic',
          durable: body.durable === true,
          auto_delete: body.auto_delete === true,
          exclusive: false,
          arguments: args,
          messages: [],
          unacked: 0,
          consumers: 0,
          policy: null,
        })
        return json(response, 201, undefined)
      }
      if (!queue) return notFound(response)

      if (method === 'GET' && action === undefined) {
        return json(response, 200, {
          ...queueView(queue),
          idle_since: '2026-10-25 10:00:00',
          memory: 18_000,
          consumer_details:
            queue.consumers > 0
              ? [
                  {
                    consumer_tag: 'ctag-1',
                    channel_details: { name: '127.0.0.1:50000 -> 127.0.0.1:5672 (1)' },
                    ack_required: true,
                    exclusive: false,
                    prefetch_count: 10,
                    active: true,
                  },
                ]
              : [],
        })
      }
      if (method === 'GET' && action === 'bindings') {
        // Every queue is bound to the default exchange by its own name, and the real broker lists that too.
        const implicit = {
          source: '',
          vhost: vhost!,
          destination: name,
          destination_type: 'queue',
          routing_key: name,
          arguments: {},
          properties_key: encodeURIComponent(name),
        }
        return json(response, 200, [
          implicit,
          ...state.bindings
            .filter(
              (b) => b.vhost === vhost && b.destination === name && b.destination_type === 'queue',
            )
            .map((b) => ({ ...b, properties_key: propertiesKey(b) })),
        ])
      }
      if (method === 'POST' && action === 'get') {
        const body = await readBody(request)
        const count = Math.min(Number(body.count ?? 1), queue.messages.length)
        const truncate = Number(body.truncate ?? Infinity)
        const taken = queue.messages.slice(0, count)
        const out = taken.map((m, i) => ({
          payload_bytes: Buffer.byteLength(m.payload),
          redelivered: m.redelivered,
          exchange: m.exchange,
          routing_key: m.routing_key,
          message_count: queue.messages.length - i - 1,
          properties: m.properties,
          payload: m.payload.length > truncate ? m.payload.slice(0, truncate) : m.payload,
          payload_encoding: m.payload_encoding,
        }))
        // Taken, then put back, and now it has been delivered once.
        for (const m of taken) m.redelivered = true
        return json(response, 200, out)
      }
      if (method === 'DELETE' && action === 'contents') {
        // The real broker has no JSON to offer for this call, and answers 406 to a client that wants only JSON.
        if (request.headers.accept === 'application/json') return json(response, 406, undefined)
        queue.messages = []
        return json(response, 204, undefined)
      }
      if (method === 'DELETE' && action === undefined) {
        state.queues.splice(state.queues.indexOf(queue), 1)
        state.bindings = state.bindings.filter(
          (b) => !(b.vhost === vhost && b.destination === name && b.destination_type === 'queue'),
        )
        return json(response, 204, undefined)
      }
    }

    if (kind === 'exchanges' && name !== undefined) {
      const exchangeName = name === 'amq.default' ? '' : name
      const exchange = state.exchanges.find((e) => e.vhost === vhost && e.name === exchangeName)
      const action = rest[0]

      if (method === 'PUT' && action === undefined) {
        const body = await readBody(request)
        if (!exchange) {
          state.exchanges.push({
            name,
            vhost: vhost!,
            type: String(body.type ?? 'direct'),
            durable: body.durable === true,
            auto_delete: body.auto_delete === true,
            internal: body.internal === true,
            arguments: (body.arguments ?? {}) as Record<string, unknown>,
          })
          return json(response, 201, undefined)
        }
        return json(response, 204, undefined)
      }
      if (!exchange) return notFound(response)

      if (method === 'GET' && action === undefined) {
        return json(response, 200, {
          ...exchange,
          message_stats: { publish_in_details: { rate: 0 }, publish_out_details: { rate: 0 } },
        })
      }
      if (method === 'GET' && action === 'bindings') {
        const side = rest[1]
        const list = state.bindings.filter((b) =>
          side === 'source'
            ? b.vhost === vhost && b.source === exchangeName
            : b.vhost === vhost &&
              b.destination === exchangeName &&
              b.destination_type === 'exchange',
        )
        return json(
          response,
          200,
          list.map((b) => ({ ...b, properties_key: propertiesKey(b) })),
        )
      }
      if (method === 'POST' && action === 'publish') {
        const body = await readBody(request)
        const queues = route(vhost!, exchangeName, String(body.routing_key ?? ''))
        for (const queue of queues) {
          queue.messages.push({
            exchange: exchangeName,
            routing_key: String(body.routing_key ?? ''),
            payload: String(body.payload ?? ''),
            payload_encoding: body.payload_encoding === 'base64' ? 'base64' : 'string',
            properties: (body.properties ?? {}) as Record<string, unknown>,
            redelivered: false,
          })
        }
        return json(response, 200, { routed: queues.length > 0 })
      }
      if (method === 'DELETE' && action === undefined) {
        if (exchangeName === '' || exchangeName.startsWith('amq.')) {
          // As the real broker does, it answers 401, the same status as for a login it refused.
          return json(response, 401, { error: 'not_authorised', reason: 'Access refused.' })
        }
        state.exchanges.splice(state.exchanges.indexOf(exchange), 1)
        state.bindings = state.bindings.filter(
          (b) =>
            !(
              b.vhost === vhost &&
              (b.source === name || (b.destination === name && b.destination_type === 'exchange'))
            ),
        )
        return json(response, 204, undefined)
      }
    }

    if (kind === 'bindings' && name === 'e') {
      // bindings/{vhost}/e/{source}/{q|e}/{destination}[/{propertiesKey}]
      const [source, targetKind, destination, key] = rest
      const destinationType = targetKind === 'q' ? 'queue' : 'exchange'
      const sourceName = source === 'amq.default' ? '' : source!
      if (method === 'POST' && key === undefined) {
        const body = await readBody(request)
        state.bindings.push({
          source: sourceName,
          vhost: vhost!,
          destination: destination!,
          destination_type: destinationType,
          routing_key: String(body.routing_key ?? ''),
          arguments: (body.arguments ?? {}) as Record<string, unknown>,
        })
        return json(response, 201, undefined)
      }
      if (method === 'DELETE' && key !== undefined) {
        const index = state.bindings.findIndex(
          (b) =>
            b.vhost === vhost &&
            b.source === sourceName &&
            b.destination === destination &&
            b.destination_type === destinationType &&
            propertiesKey(b) === key,
        )
        if (index === -1) return notFound(response)
        state.bindings.splice(index, 1)
        return json(response, 204, undefined)
      }
    }

    // `PUT /api/vhosts/{name}` is how a test makes a vhost.
    return json(response, 405, { error: 'method_not_allowed', reason: `${method} ${url.pathname}` })
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    state,
    addQueue(vhost, name, extra = {}) {
      if (!state.vhosts.includes(vhost)) {
        state.vhosts.push(vhost)
        state.exchanges.push(...builtIns(vhost))
      }
      const queue: FakeQueue = {
        name,
        vhost,
        type: 'classic',
        durable: true,
        auto_delete: false,
        exclusive: false,
        arguments: {},
        messages: [],
        unacked: 0,
        consumers: 0,
        policy: null,
        ...extra,
      }
      state.queues.push(queue)
      return queue
    },
    addMessages(vhost, queue, count, make = () => ({})) {
      const target = state.queues.find((q) => q.vhost === vhost && q.name === queue)
      if (!target) throw new Error(`No queue ${queue}`)
      for (let i = 0; i < count; i++) {
        target.messages.push({
          exchange: '',
          routing_key: queue,
          payload: `message ${i + 1}`,
          payload_encoding: 'string',
          properties: { content_type: 'text/plain', delivery_mode: 2 },
          redelivered: false,
          ...make(i),
        })
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
