import type {
  DriverSession,
  ExecuteRequest,
  ResultBatch,
  SessionInfo,
  TreeNode,
} from '@shared/driver'
import { DEFAULT_VHOST, type BrokerApi, type VhostSummary } from '@shared/rabbitmq'
import { RpcError } from '@shared/rpc'
import { ManagementError, SessionClosedError } from './errors'
import type { ManagementClient } from './http'
import { toVhost } from './map'
import { treeChildren } from './tree'

/** The broker as a session: the tree, and what the broker panels ask of it. */
export class RabbitSession implements DriverSession {
  private state: SessionInfo
  private closed = false

  constructor(
    private readonly client: ManagementClient,
    readonly broker: BrokerApi,
    info: SessionInfo,
    private readonly defaultVhost: string,
  ) {
    this.state = info
  }

  get info(): SessionInfo {
    return this.state
  }

  private assertOpen(): void {
    if (this.closed) throw new SessionClosedError()
  }

  async ping(): Promise<void> {
    this.assertOpen()
    await this.client.get('whoami', { signal: new AbortController().signal, what: 'The user' })
  }

  /** The vhosts this login can see. A login that can't list them still has the one it was given. */
  private async vhosts(signal: AbortSignal): Promise<VhostSummary[]> {
    try {
      const body = await this.client.get<unknown[]>('vhosts', { signal, what: 'The vhost list' })
      return body.map(toVhost).filter((v) => v.name !== '')
    } catch (error) {
      if (
        error instanceof ManagementError &&
        (error.status === 403 || error.status === 401) &&
        this.defaultVhost
      ) {
        return [{ name: this.defaultVhost, description: null, messages: 0, ready: 0, unacked: 0 }]
      }
      throw error
    }
  }

  async children(parent: TreeNode | null, signal: AbortSignal): Promise<TreeNode[]> {
    this.assertOpen()
    signal.throwIfAborted()
    return treeChildren(
      {
        vhosts: (s) => this.vhosts(s),
        listing: (vhost, s) => this.broker.listing(vhost, s),
        broker: this.broker,
      },
      parent,
      signal,
    )
  }

  // eslint-disable-next-line require-yield
  async *execute(_request: ExecuteRequest, _signal: AbortSignal): AsyncGenerator<ResultBatch> {
    throw new RpcError(
      'NOT_SUPPORTED',
      'RabbitMQ has no query language. Open a queue or an exchange from the tree.',
    )
  }

  /** There is no read-only session to switch: the window guards every change before it asks. */
  async setReadOnly(readOnly: boolean): Promise<void> {
    this.state = { ...this.state, readOnly }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.client.close()
  }
}

/** The vhost a connection opens in. */
export const vhostOf = (database: string | undefined): string => database || DEFAULT_VHOST
