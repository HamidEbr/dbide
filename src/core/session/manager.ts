import type { ConnectionConfig, ConnectionSecrets } from '@shared/connection'
import type { DriverSession } from '@shared/driver'
import { RpcError } from '@shared/rpc'
import type { DriverRegistry } from '../drivers/registry'

export interface OpenSession {
  config: ConnectionConfig
  session: DriverSession
  openedAt: number
}

/**
 * Owns the live driver sessions, one per saved connection. Drivers talk to the server; this
 * class decides when a session exists, so the UI can never leak or duplicate one.
 */
export class SessionManager {
  private readonly sessions = new Map<string, OpenSession>()
  private readonly opening = new Map<string, Promise<OpenSession>>()

  constructor(private readonly drivers: DriverRegistry) {}

  /**
   * Returns the live session under `key`, opening it first when needed. The key is usually the
   * connection id; scripts use their own keys so each gets a private connection.
   */
  open(
    key: string,
    config: ConnectionConfig,
    secrets: ConnectionSecrets,
    signal: AbortSignal,
    options: { readOnly?: boolean } = {},
  ): Promise<OpenSession> {
    const existing = this.sessions.get(key)
    if (existing) return Promise.resolve(existing)

    // Two callers racing to open the same session share one attempt.
    const inflight = this.opening.get(key)
    if (inflight) return inflight

    const attempt = this.drivers
      .get(config.engine)
      .connect({
        config,
        secrets,
        endpoint: { host: config.host, port: config.port },
        ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
        signal,
      })
      .then((session) => {
        const open: OpenSession = { config, session, openedAt: Date.now() }
        this.sessions.set(key, open)
        return open
      })
      .finally(() => this.opening.delete(key))

    this.opening.set(key, attempt)
    return attempt
  }

  get(id: string): OpenSession {
    const open = this.sessions.get(id)
    if (!open) throw new RpcError('NOT_CONNECTED', 'This connection is not open')
    return open
  }

  /** The live session under `key`, or undefined. Unlike `get`, a missing one is not an error. */
  peek(key: string): OpenSession | undefined {
    return this.sessions.get(key)
  }

  has(id: string): boolean {
    return this.sessions.has(id)
  }

  async close(id: string): Promise<void> {
    const open = this.sessions.get(id)
    if (!open) return
    this.sessions.delete(id)
    await open.session.close()
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.close(id)))
  }
}
