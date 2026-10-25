import type {
  BindRequest,
  BrokerApi,
  BrokerOverview,
  DeclareExchangeRequest,
  DeclareQueueRequest,
  ExchangeDetail,
  PeekedMessage,
  PublishRequest,
  QueueDetail,
  UnbindRequest,
  VhostListing,
} from '@shared/rabbitmq'
import { MAX_LISTED_QUEUES } from '@shared/rabbitmq'
import type { ManagementClient } from './http'
import {
  fromProperties,
  raw,
  toExchange,
  toExchangeDetail,
  toOverview,
  toPeeked,
  toQueue,
  toQueueDetail,
} from './map'
import { exchangeSegment, segment } from './url'

const PAGE_SIZE = 500
const LISTING_TTL_MS = 3000
/** The fields a queue list needs. The broker leaves the rest out, which makes a big list much lighter. */
const QUEUE_COLUMNS = [
  'name',
  'vhost',
  'type',
  'durable',
  'auto_delete',
  'exclusive',
  'state',
  'messages',
  'messages_ready',
  'messages_unacknowledged',
  'consumers',
  'policy',
  'arguments',
  'message_stats.publish_details.rate',
  'message_stats.deliver_get_details.rate',
].join(',')

const abortError = (): Error => new DOMException('The request was cancelled', 'AbortError')

/** A promise that gives up when the signal aborts, without stopping the work behind it. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** A list from the API: a bare array on an old broker, or a page of one on a newer one. */
function itemsOf(body: unknown): { items: unknown[]; pages: number; total: number } {
  if (Array.isArray(body)) return { items: body, pages: 1, total: body.length }
  const page = raw(body)
  const items = Array.isArray(page.items) ? page.items : []
  const pages = typeof page.page_count === 'number' ? page.page_count : 1
  const total =
    typeof page.total_count === 'number'
      ? page.total_count
      : typeof page.filtered_count === 'number'
        ? page.filtered_count
        : items.length
  return { items, pages, total }
}

/** The broker's management API, as the operations the app needs. */
export class ManagementBroker implements BrokerApi {
  /** A listing is reused for a moment: the tree asks for the same one twice in a row. */
  private listings = new Map<string, { at: number; promise: Promise<VhostListing> }>()

  constructor(private readonly client: ManagementClient) {}

  /** Forgets the listings, so what is shown next is a fresh look. Done after every change. */
  forget(): void {
    this.listings.clear()
  }

  async overview(signal: AbortSignal): Promise<BrokerOverview> {
    const [overview, user, nodes] = await Promise.all([
      this.client.get<unknown>('overview', { signal, what: 'The overview' }),
      this.client.get<unknown>('whoami', { signal, what: 'The user' }),
      // Node statistics need the monitoring role; an overview is still worth showing without them.
      this.client.get<unknown>('nodes', { signal, what: 'The nodes' }).catch((error: unknown) => {
        if (signal.aborted) throw error
        return []
      }),
    ])
    return toOverview(overview, user, nodes)
  }

  listing(vhost: string, signal: AbortSignal): Promise<VhostListing> {
    const cached = this.listings.get(vhost)
    if (cached && Date.now() - cached.at < LISTING_TTL_MS) return abortable(cached.promise, signal)
    // The fetch is shared, so it belongs to no one caller: one that cancels stops waiting, and the rest still get it.
    const promise = this.fetchListing(vhost, new AbortController().signal)
    this.listings.set(vhost, { at: Date.now(), promise })
    // A listing that failed must not be handed to the next caller.
    promise.catch(() => {
      if (this.listings.get(vhost)?.promise === promise) this.listings.delete(vhost)
    })
    return abortable(promise, signal)
  }

  private async fetchListing(vhost: string, signal: AbortSignal): Promise<VhostListing> {
    const queues: ReturnType<typeof toQueue>[] = []
    let total: number | undefined
    for (let page = 1; ; page++) {
      const body = await this.client.get<unknown>(`queues/${segment(vhost)}`, {
        signal,
        what: `The vhost “${vhost}”`,
        query: { page, page_size: PAGE_SIZE, columns: QUEUE_COLUMNS },
      })
      const { items, pages, total: all } = itemsOf(body)
      total = all
      for (const item of items) queues.push(toQueue(item, vhost))
      if (page >= pages || queues.length >= MAX_LISTED_QUEUES || Array.isArray(body)) break
    }
    const exchanges = await this.client.get<unknown[]>(`exchanges/${segment(vhost)}`, {
      signal,
      what: `The vhost “${vhost}”`,
    })
    return {
      queues: queues.slice(0, MAX_LISTED_QUEUES),
      exchanges: exchanges.map((e) => toExchange(e, vhost)),
      queuesTotal: Math.max(total ?? 0, queues.length),
    }
  }

  async queue(vhost: string, name: string, signal: AbortSignal): Promise<QueueDetail> {
    const path = `queues/${segment(vhost)}/${segment(name)}`
    const what = `The queue “${name}”`
    const [detail, bindings] = await Promise.all([
      this.client.get<unknown>(path, { signal, what }),
      this.client.get<unknown[]>(`${path}/bindings`, { signal, what }),
    ])
    return toQueueDetail(detail, bindings, vhost)
  }

  async exchange(vhost: string, name: string, signal: AbortSignal): Promise<ExchangeDetail> {
    const path = `exchanges/${segment(vhost)}/${exchangeSegment(name)}`
    const what = `The exchange “${name}”`
    const [detail, from, to] = await Promise.all([
      this.client.get<unknown>(path, { signal, what }),
      this.client.get<unknown[]>(`${path}/bindings/source`, { signal, what }),
      this.client.get<unknown[]>(`${path}/bindings/destination`, { signal, what }),
    ])
    return toExchangeDetail(detail, from, to, vhost)
  }

  async peek(
    vhost: string,
    queue: string,
    options: { count: number; truncate: number },
    signal: AbortSignal,
  ): Promise<PeekedMessage[]> {
    const body = await this.client.post<unknown[]>(
      `queues/${segment(vhost)}/${segment(queue)}/get`,
      {
        signal,
        what: `The queue “${queue}”`,
        body: {
          count: options.count,
          // Taken, then put straight back where it was.
          ackmode: 'ack_requeue_true',
          encoding: 'auto',
          truncate: options.truncate,
        },
      },
    )
    return (Array.isArray(body) ? body : []).map((m, i) => toPeeked(m, i + 1, options.truncate))
  }

  async publish(
    vhost: string,
    request: PublishRequest,
    signal: AbortSignal,
  ): Promise<{ routed: boolean }> {
    const body = await this.client.post<unknown>(
      `exchanges/${segment(vhost)}/${exchangeSegment(request.exchange)}/publish`,
      {
        signal,
        what: `The exchange “${request.exchange || '(default)'}”`,
        body: {
          properties: fromProperties(request.properties),
          routing_key: request.routingKey,
          payload: request.payload,
          payload_encoding: request.payloadEncoding,
        },
      },
    )
    this.forget()
    return { routed: raw(body).routed === true }
  }

  async purge(vhost: string, queue: string, signal: AbortSignal): Promise<void> {
    await this.client.delete(`queues/${segment(vhost)}/${segment(queue)}/contents`, {
      signal,
      what: `The queue “${queue}”`,
    })
    this.forget()
  }

  async declareQueue(
    vhost: string,
    request: DeclareQueueRequest,
    signal: AbortSignal,
  ): Promise<void> {
    await this.client.put(`queues/${segment(vhost)}/${segment(request.name)}`, {
      signal,
      body: {
        durable: request.durable,
        auto_delete: request.autoDelete,
        arguments: {
          ...request.arguments,
          ...(request.type === 'classic' ? {} : { 'x-queue-type': request.type }),
        },
      },
    })
    this.forget()
  }

  async deleteQueue(vhost: string, name: string, signal: AbortSignal): Promise<void> {
    await this.client.delete(`queues/${segment(vhost)}/${segment(name)}`, {
      signal,
      what: `The queue “${name}”`,
    })
    this.forget()
  }

  async declareExchange(
    vhost: string,
    request: DeclareExchangeRequest,
    signal: AbortSignal,
  ): Promise<void> {
    await this.client.put(`exchanges/${segment(vhost)}/${segment(request.name)}`, {
      signal,
      body: {
        type: request.type,
        durable: request.durable,
        auto_delete: request.autoDelete,
        internal: request.internal,
        arguments: request.arguments,
      },
    })
    this.forget()
  }

  async deleteExchange(vhost: string, name: string, signal: AbortSignal): Promise<void> {
    await this.client.delete(`exchanges/${segment(vhost)}/${segment(name)}`, {
      signal,
      what: `The exchange “${name}”`,
    })
    this.forget()
  }

  async bind(vhost: string, request: BindRequest, signal: AbortSignal): Promise<void> {
    const target = request.destinationType === 'queue' ? 'q' : 'e'
    await this.client.post(
      `bindings/${segment(vhost)}/e/${exchangeSegment(request.source)}/${target}/${segment(request.destination)}`,
      { signal, body: { routing_key: request.routingKey, arguments: request.arguments } },
    )
    this.forget()
  }

  async unbind(vhost: string, request: UnbindRequest, signal: AbortSignal): Promise<void> {
    const target = request.destinationType === 'queue' ? 'q' : 'e'
    await this.client.delete(
      `bindings/${segment(vhost)}/e/${exchangeSegment(request.source)}/${target}/${segment(request.destination)}/${segment(request.propertiesKey)}`,
      { signal, what: 'That binding' },
    )
    this.forget()
  }
}
