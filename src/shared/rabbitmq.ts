/**
 * What DBIDE knows about a RabbitMQ broker: its vhosts, queues, exchanges and bindings, and the messages
 * in a queue. Everything is read and changed through the broker's management API, which is the only way
 * to list what exists; the AMQP port is not used.
 */

export const DEFAULT_VHOST = '/'

/** The most messages one peek asks for. */
export const MAX_PEEK_MESSAGES = 500
export const DEFAULT_PEEK_MESSAGES = 10
/** A payload longer than this many bytes is cut when peeking, so a huge message can't fill the window. */
export const PEEK_TRUNCATE_BYTES = 100_000

/** The most queues one vhost listing returns. A broker with more says so. */
export const MAX_LISTED_QUEUES = 5000

export interface BrokerUser {
  name: string
  tags: string[]
}

export interface BrokerNode {
  name: string
  running: boolean
  memoryUsed: number | null
  memoryLimit: number | null
  diskFree: number | null
  fileDescriptorsUsed: number | null
  fileDescriptorsTotal: number | null
  /** Milliseconds since the node started. */
  uptime: number | null
}

export interface BrokerTotals {
  queues: number
  exchanges: number
  connections: number
  channels: number
  consumers: number
  messages: number
  ready: number
  unacked: number
}

export interface BrokerOverview {
  version: string
  erlangVersion: string | null
  clusterName: string | null
  managementVersion: string | null
  user: BrokerUser
  totals: BrokerTotals
  /** Messages per second, as the broker measures them over its stats interval. */
  rates: { publish: number; deliver: number; ack: number }
  nodes: BrokerNode[]
  listeners: { protocol: string; port: number; node: string }[]
}

export interface VhostSummary {
  name: string
  description: string | null
  messages: number
  ready: number
  unacked: number
}

export type QueueKind = 'classic' | 'quorum' | 'stream' | string

export interface QueueSummary {
  name: string
  vhost: string
  type: QueueKind
  durable: boolean
  autoDelete: boolean
  exclusive: boolean
  /** `running`, `idle`, `flow`, `down`, ... as the broker reports it. */
  state: string
  messages: number
  ready: number
  unacked: number
  consumers: number
  /** Messages per second published to and delivered from the queue. */
  rateIn: number
  rateOut: number
  policy: string | null
}

export type BindingTarget = 'queue' | 'exchange'

export interface BindingInfo {
  source: string
  vhost: string
  destination: string
  destinationType: BindingTarget
  routingKey: string
  arguments: Record<string, unknown>
  /** What identifies the binding when it is removed. */
  propertiesKey: string
}

export interface ConsumerInfo {
  tag: string
  channel: string | null
  ackRequired: boolean
  exclusive: boolean
  prefetch: number | null
  active: boolean | null
}

export interface QueueDetail extends QueueSummary {
  arguments: Record<string, unknown>
  node: string | null
  /** When the queue last had no activity, as the broker writes it. */
  idleSince: string | null
  /** Memory the queue holds, in bytes. */
  memory: number | null
  /** Quorum queues and streams: the members, and which one leads. */
  members: string[]
  leader: string | null
  bindings: BindingInfo[]
  consumerDetails: ConsumerInfo[]
}

export interface ExchangeSummary {
  name: string
  vhost: string
  type: string
  durable: boolean
  autoDelete: boolean
  internal: boolean
  policy: string | null
}

export interface ExchangeDetail extends ExchangeSummary {
  arguments: Record<string, unknown>
  /** Where this exchange sends what it receives. */
  bindingsFrom: BindingInfo[]
  /** Exchanges can be bound to exchanges: these are the ones that send what they receive to this one. */
  bindingsTo: BindingInfo[]
  rateIn: number
  rateOut: number
}

export interface VhostListing {
  queues: QueueSummary[]
  exchanges: ExchangeSummary[]
  /** The broker has more queues than were listed. */
  queuesTotal: number
}

export interface MessageProperties {
  contentType?: string
  contentEncoding?: string
  /** 1 is transient, 2 is persistent. */
  deliveryMode?: number
  priority?: number
  correlationId?: string
  replyTo?: string
  expiration?: string
  messageId?: string
  /** Seconds since 1970. */
  timestamp?: number
  type?: string
  userId?: string
  appId?: string
  headers?: Record<string, unknown>
}

export interface PeekedMessage {
  /** Position in this peek, from 1. */
  index: number
  exchange: string
  routingKey: string
  /** Set by the peek itself on a message that had not been delivered before. */
  redelivered: boolean
  /** Text, or base64 when the payload is not valid UTF-8. */
  payload: string
  payloadEncoding: 'string' | 'base64'
  /** The size of the whole payload, which may be more than `payload` holds. */
  payloadBytes: number
  truncated: boolean
  properties: MessageProperties
  /** How many messages the queue still held after this one was taken. */
  remaining: number
}

export interface PublishRequest {
  exchange: string
  routingKey: string
  payload: string
  payloadEncoding: 'string' | 'base64'
  properties: MessageProperties
}

export interface DeclareQueueRequest {
  name: string
  type: 'classic' | 'quorum' | 'stream'
  durable: boolean
  autoDelete: boolean
  arguments: Record<string, unknown>
}

export interface DeclareExchangeRequest {
  name: string
  type: string
  durable: boolean
  autoDelete: boolean
  internal: boolean
  arguments: Record<string, unknown>
}

export interface BindRequest {
  source: string
  destination: string
  destinationType: BindingTarget
  routingKey: string
  arguments: Record<string, unknown>
}

export interface UnbindRequest {
  source: string
  destination: string
  destinationType: BindingTarget
  propertiesKey: string
}

/** What a session that talks to a broker can do. Every call is cancellable. */
export interface BrokerApi {
  overview(signal: AbortSignal): Promise<BrokerOverview>
  listing(vhost: string, signal: AbortSignal): Promise<VhostListing>
  queue(vhost: string, name: string, signal: AbortSignal): Promise<QueueDetail>
  exchange(vhost: string, name: string, signal: AbortSignal): Promise<ExchangeDetail>
  /**
   * Looks at messages without taking them: they are fetched and put straight back. The broker marks them
   * redelivered, and on a quorum queue each look counts as a delivery attempt.
   */
  peek(
    vhost: string,
    queue: string,
    options: { count: number; truncate: number },
    signal: AbortSignal,
  ): Promise<PeekedMessage[]>
  /** Whether the broker routed the message to at least one queue. */
  publish(vhost: string, request: PublishRequest, signal: AbortSignal): Promise<{ routed: boolean }>
  purge(vhost: string, queue: string, signal: AbortSignal): Promise<void>
  declareQueue(vhost: string, request: DeclareQueueRequest, signal: AbortSignal): Promise<void>
  deleteQueue(vhost: string, name: string, signal: AbortSignal): Promise<void>
  declareExchange(
    vhost: string,
    request: DeclareExchangeRequest,
    signal: AbortSignal,
  ): Promise<void>
  deleteExchange(vhost: string, name: string, signal: AbortSignal): Promise<void>
  bind(vhost: string, request: BindRequest, signal: AbortSignal): Promise<void>
  unbind(vhost: string, request: UnbindRequest, signal: AbortSignal): Promise<void>
}

/** The default exchange has no name; the API and the person both need a word for it. */
export const DEFAULT_EXCHANGE_LABEL = '(default)'

export const isDefaultExchange = (name: string): boolean => name === ''
export const isBuiltInExchange = (name: string): boolean => name === '' || name.startsWith('amq.')

/** A queue's counts as one short line for a tree: `12 ready · 3 unacked`. */
export function describeQueueCounts(queue: Pick<QueueSummary, 'ready' | 'unacked'>): string {
  const parts: string[] = []
  if (queue.ready > 0) parts.push(`${compactCount(queue.ready)} ready`)
  if (queue.unacked > 0) parts.push(`${compactCount(queue.unacked)} unacked`)
  return parts.length > 0 ? parts.join(' · ') : 'empty'
}

export function compactCount(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}K`
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`
}
