import type {
  BindingInfo,
  BrokerNode,
  BrokerOverview,
  BrokerUser,
  ConsumerInfo,
  ExchangeDetail,
  ExchangeSummary,
  MessageProperties,
  PeekedMessage,
  QueueDetail,
  QueueSummary,
  VhostSummary,
} from '@shared/rabbitmq'

/** A JSON object as the management API sends it. Every field is checked before it is read. */
export type Raw = Record<string, unknown>

const isRaw = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const raw = (value: unknown): Raw => (isRaw(value) ? value : {})

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const count = (value: unknown): number => num(value) ?? 0
const flag = (value: unknown): boolean => value === true

/** A value nested under keys, such as `message_stats.publish_details.rate`. */
function at(source: Raw, ...path: string[]): unknown {
  let current: unknown = source
  for (const key of path) {
    if (!isRaw(current)) return undefined
    current = current[key]
  }
  return current
}

const object = (value: unknown): Record<string, unknown> => (isRaw(value) ? value : {})

/** What the broker says a name of a policy is: a string, or nothing. */
const policy = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

export function toUser(value: unknown): BrokerUser {
  const body = raw(value)
  const tags = body.tags
  return {
    name: str(body.name) ?? '',
    // Older brokers send the tags as one comma-separated string.
    tags: Array.isArray(tags)
      ? tags.filter((t): t is string => typeof t === 'string')
      : typeof tags === 'string'
        ? tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
  }
}

export function toVhost(value: unknown): VhostSummary {
  const body = raw(value)
  return {
    name: str(body.name) ?? '',
    description: str(body.description) || null,
    messages: count(body.messages),
    ready: count(body.messages_ready),
    unacked: count(body.messages_unacknowledged),
  }
}

export function toQueue(value: unknown, fallbackVhost = ''): QueueSummary {
  const body = raw(value)
  return {
    name: str(body.name) ?? '',
    vhost: str(body.vhost) ?? fallbackVhost,
    type: str(body.type) ?? str(object(body.arguments)['x-queue-type']) ?? 'classic',
    durable: flag(body.durable),
    autoDelete: flag(body.auto_delete),
    exclusive: flag(body.exclusive),
    state: str(body.state) ?? 'running',
    messages: count(body.messages),
    ready: count(body.messages_ready),
    unacked: count(body.messages_unacknowledged),
    consumers: count(body.consumers),
    rateIn: num(at(body, 'message_stats', 'publish_details', 'rate')) ?? 0,
    rateOut: num(at(body, 'message_stats', 'deliver_get_details', 'rate')) ?? 0,
    policy: policy(body.policy),
  }
}

export function toBinding(value: unknown, fallbackVhost = ''): BindingInfo {
  const body = raw(value)
  return {
    source: str(body.source) ?? '',
    vhost: str(body.vhost) ?? fallbackVhost,
    destination: str(body.destination) ?? '',
    destinationType: body.destination_type === 'exchange' ? 'exchange' : 'queue',
    routingKey: str(body.routing_key) ?? '',
    arguments: object(body.arguments),
    propertiesKey: str(body.properties_key) ?? '~',
  }
}

function toConsumer(value: unknown): ConsumerInfo {
  const body = raw(value)
  return {
    tag: str(body.consumer_tag) ?? '',
    channel: str(at(body, 'channel_details', 'name')),
    ackRequired: flag(body.ack_required),
    exclusive: flag(body.exclusive),
    prefetch: num(body.prefetch_count),
    active: typeof body.active === 'boolean' ? body.active : null,
  }
}

export function toQueueDetail(
  value: unknown,
  bindings: unknown[],
  fallbackVhost = '',
): QueueDetail {
  const body = raw(value)
  const members = body.members ?? body.online
  return {
    ...toQueue(value, fallbackVhost),
    arguments: object(body.arguments),
    node: str(body.node) ?? str(body.leader),
    idleSince: str(body.idle_since),
    memory: num(body.memory),
    members: Array.isArray(members)
      ? members.filter((m): m is string => typeof m === 'string')
      : [],
    leader: str(body.leader),
    bindings: bindings.map((b) => toBinding(b, fallbackVhost)),
    consumerDetails: Array.isArray(body.consumer_details)
      ? body.consumer_details.map(toConsumer)
      : [],
  }
}

export function toExchange(value: unknown, fallbackVhost = ''): ExchangeSummary {
  const body = raw(value)
  return {
    name: str(body.name) ?? '',
    vhost: str(body.vhost) ?? fallbackVhost,
    type: str(body.type) ?? 'direct',
    durable: flag(body.durable),
    autoDelete: flag(body.auto_delete),
    internal: flag(body.internal),
    policy: policy(body.policy),
  }
}

export function toExchangeDetail(
  value: unknown,
  from: unknown[],
  to: unknown[],
  fallbackVhost = '',
): ExchangeDetail {
  const body = raw(value)
  return {
    ...toExchange(value, fallbackVhost),
    arguments: object(body.arguments),
    bindingsFrom: from.map((b) => toBinding(b, fallbackVhost)),
    bindingsTo: to.map((b) => toBinding(b, fallbackVhost)),
    rateIn: num(at(body, 'message_stats', 'publish_in_details', 'rate')) ?? 0,
    rateOut: num(at(body, 'message_stats', 'publish_out_details', 'rate')) ?? 0,
  }
}

export function toNode(value: unknown): BrokerNode {
  const body = raw(value)
  return {
    name: str(body.name) ?? '',
    running: body.running !== false,
    memoryUsed: num(body.mem_used),
    memoryLimit: num(body.mem_limit),
    diskFree: num(body.disk_free),
    fileDescriptorsUsed: num(body.fd_used),
    fileDescriptorsTotal: num(body.fd_total),
    uptime: num(body.uptime),
  }
}

export function toOverview(value: unknown, user: unknown, nodes: unknown): BrokerOverview {
  const body = raw(value)
  const totals = raw(body.object_totals)
  const queues = raw(body.queue_totals)
  const listeners = Array.isArray(body.listeners) ? body.listeners : []
  return {
    version: str(body.rabbitmq_version) ?? 'unknown',
    erlangVersion: str(body.erlang_version),
    clusterName: str(body.cluster_name),
    managementVersion: str(body.management_version),
    user: toUser(user),
    totals: {
      queues: count(totals.queues),
      exchanges: count(totals.exchanges),
      connections: count(totals.connections),
      channels: count(totals.channels),
      consumers: count(totals.consumers),
      messages: count(queues.messages),
      ready: count(queues.messages_ready),
      unacked: count(queues.messages_unacknowledged),
    },
    rates: {
      publish: num(at(body, 'message_stats', 'publish_details', 'rate')) ?? 0,
      deliver: num(at(body, 'message_stats', 'deliver_get_details', 'rate')) ?? 0,
      ack: num(at(body, 'message_stats', 'ack_details', 'rate')) ?? 0,
    },
    nodes: Array.isArray(nodes) ? nodes.map(toNode) : [],
    listeners: listeners.map((l) => {
      const listener = raw(l)
      return {
        protocol: str(listener.protocol) ?? '',
        port: count(listener.port),
        node: str(listener.node) ?? '',
      }
    }),
  }
}

const PROPERTY_KEYS: [keyof MessageProperties, string][] = [
  ['contentType', 'content_type'],
  ['contentEncoding', 'content_encoding'],
  ['deliveryMode', 'delivery_mode'],
  ['priority', 'priority'],
  ['correlationId', 'correlation_id'],
  ['replyTo', 'reply_to'],
  ['expiration', 'expiration'],
  ['messageId', 'message_id'],
  ['timestamp', 'timestamp'],
  ['type', 'type'],
  ['userId', 'user_id'],
  ['appId', 'app_id'],
]

export function toProperties(value: unknown): MessageProperties {
  const body = raw(value)
  const out: Record<string, unknown> = {}
  for (const [ours, theirs] of PROPERTY_KEYS) {
    const v = body[theirs]
    if (typeof v === 'string' || typeof v === 'number') out[ours] = v
  }
  const headers = object(body.headers)
  if (Object.keys(headers).length > 0) out.headers = headers
  return out as MessageProperties
}

/** The properties in the management API's own spelling, leaving out what is not set. */
export function fromProperties(properties: MessageProperties): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [ours, theirs] of PROPERTY_KEYS) {
    const v = properties[ours]
    if (v !== undefined && v !== '') out[theirs] = v
  }
  if (properties.headers && Object.keys(properties.headers).length > 0)
    out.headers = properties.headers
  return out
}

export function toPeeked(value: unknown, index: number, truncate: number): PeekedMessage {
  const body = raw(value)
  const bytes = count(body.payload_bytes)
  return {
    index,
    exchange: str(body.exchange) ?? '',
    routingKey: str(body.routing_key) ?? '',
    redelivered: flag(body.redelivered),
    payload: str(body.payload) ?? '',
    payloadEncoding: body.payload_encoding === 'base64' ? 'base64' : 'string',
    payloadBytes: bytes,
    truncated: bytes > truncate,
    properties: toProperties(body.properties),
    remaining: count(body.message_count),
  }
}
