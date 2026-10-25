import { Cluster, Redis, type ClusterOptions, type RedisOptions } from 'ioredis'
import type { ConnectContext } from '@shared/driver'
import { describeRedisError } from './errors'
import { readTlsFiles, redisSetup, tlsOptions, type RedisSetup } from './options'

/** What commands are sent through: one server, or a whole cluster. */
export type Commander = Redis | Cluster

const CONNECT_TIMEOUT_MS = 10_000

/**
 * The client side of a Redis session. A database is a property of a connection, so every database the
 * window looks at gets a connection of its own, made when first asked for. A cluster has only database 0.
 */
export class RedisConnection {
  private readonly others = new Map<number, Redis>()
  private closed = false

  constructor(
    readonly setup: RedisSetup,
    readonly base: Commander,
    /** What the client says when asked where it is, for error messages. */
    readonly where: string,
  ) {}

  /** The client for a database. Others are opened on demand and share the first one's settings. */
  client(db: number): Commander {
    if (this.setup.mode === 'cluster' || db === this.setup.db) return this.base
    let client = this.others.get(db)
    if (!client) {
      client = (this.base as Redis).duplicate({ db, lazyConnect: false })
      client.on('error', () => undefined)
      this.others.set(db, client)
    }
    return client
  }

  /** The servers a scan has to visit: the one, or every primary of a cluster. */
  nodes(db: number): Redis[] {
    return this.setup.mode === 'cluster'
      ? (this.base as Cluster).nodes('master')
      : [this.client(db) as Redis]
  }

  get status(): string {
    return this.base.status
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const client of this.others.values()) client.disconnect()
    this.base.disconnect()
  }
}

/** Opens the connection a saved Redis connection describes, and returns once the server has accepted it. */
export async function openConnection(context: ConnectContext): Promise<RedisConnection> {
  const { config, secrets, endpoint, signal } = context
  const setup = redisSetup(config)
  const files = await readTlsFiles(config)
  const tls = tlsOptions(config, files, endpoint.host)
  const where = `${endpoint.host}:${endpoint.port}`

  const common: RedisOptions = {
    ...(config.username ? { username: config.username } : {}),
    ...(secrets.password ? { password: secrets.password } : {}),
    ...(tls ? { tls } : {}),
    connectTimeout: CONNECT_TIMEOUT_MS,
    // Every reply is read as RESP2, which every server speaks. The client's own default is RESP3, where a sorted
    // set's scores, XINFO and the like come back in other shapes.
    protocol: 2,
    // A lost connection is reported, not retried behind the window's back: the next use reconnects.
    retryStrategy: () => null,
    reconnectOnError: null,
    autoResendUnfulfilledCommands: false,
    // The server's reply to INFO is read by the session itself, which copes with a user that may not run it.
    enableReadyCheck: false,
    maxRetriesPerRequest: 0,
    lazyConnect: true,
    connectionName: 'DBIDE',
    clientInfoTag: 'DBIDE',
    showFriendlyErrorStack: false,
  }

  let client: Commander
  if (setup.mode === 'cluster') {
    const options: ClusterOptions = {
      redisOptions: common,
      clusterRetryStrategy: () => null,
      slotsRefreshTimeout: CONNECT_TIMEOUT_MS,
      lazyConnect: true,
      // Managed clusters hand out hostnames that a TLS client must not resolve behind their back.
      ...(tls
        ? { dnsLookup: (address: string, cb: (e: null, a: string) => void) => cb(null, address) }
        : {}),
    }
    client = new Cluster([{ host: endpoint.host, port: endpoint.port }], options)
  } else if (setup.mode === 'sentinel') {
    client = new Redis({
      ...common,
      sentinels: [{ host: endpoint.host, port: endpoint.port }, ...setup.sentinels],
      name: setup.master,
      db: setup.db,
      sentinelRetryStrategy: () => null,
      ...(tls ? { enableTLSForSentinelMode: true } : {}),
    })
  } else {
    client = new Redis({ ...common, host: endpoint.host, port: endpoint.port, db: setup.db })
  }

  // A client with no error listener reports errors to the console; the failure that matters comes back from `connect`.
  let lastError: unknown = null
  client.on('error', (error: unknown) => {
    lastError = error
  })

  const onAbort = (): void => client.disconnect()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    signal.throwIfAborted()
    await client.connect()
  } catch (error) {
    client.disconnect()
    if (signal.aborted) throw signal.reason ?? error
    // The server's own refusal (a wrong password) is the useful part; the client's `connect` says only that it closed.
    const reason = lastError ?? error
    throw describeRedisError(reason, where)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  return new RedisConnection(setup, client, where)
}
