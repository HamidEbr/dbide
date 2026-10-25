import type {
  DriverSession,
  ExecuteRequest,
  ResultBatch,
  SessionInfo,
  TreeNode,
} from '@shared/driver'
import type { RedisApi } from '@shared/redis/types'
import { RpcError } from '@shared/rpc'
import type { RedisClientApi } from './api'
import { send } from './calls'
import type { RedisConnection } from './client'
import { SessionClosedError, describeRedisError } from './errors'
import { treeChildren } from './tree'

/** A Redis server as a session: the key tree, and what the key and console panels ask of it. */
export class RedisSession implements DriverSession {
  private state: SessionInfo
  private closed = false

  constructor(
    private readonly conn: RedisConnection,
    readonly redis: RedisApi,
    private readonly api: RedisClientApi,
    info: SessionInfo,
  ) {
    this.state = info
  }

  get info(): SessionInfo {
    return this.state
  }

  private assertOpen(): void {
    if (this.closed || this.conn.status === 'end') throw new SessionClosedError()
  }

  async ping(): Promise<void> {
    this.assertOpen()
    try {
      await send(this.conn.base, 'PING')
    } catch (error) {
      throw describeRedisError(error, this.conn.where)
    }
  }

  async children(parent: TreeNode | null, signal: AbortSignal): Promise<TreeNode[]> {
    this.assertOpen()
    signal.throwIfAborted()
    try {
      return await treeChildren(
        {
          conn: this.conn,
          scanner: this.api.scanner,
          info: (s) => this.redis.info(s),
        },
        parent,
        signal,
      )
    } catch (error) {
      if (signal.aborted) throw error
      throw describeRedisError(error, this.conn.where)
    }
  }

  // eslint-disable-next-line require-yield
  async *execute(_request: ExecuteRequest, _signal: AbortSignal): AsyncGenerator<ResultBatch> {
    throw new RpcError(
      'NOT_SUPPORTED',
      'Redis has no scripts to run here. Open the console from the connection’s menu.',
    )
  }

  /** There is no read-only session to switch: the window and the core guard every change before it is sent. */
  async setReadOnly(readOnly: boolean): Promise<void> {
    this.state = { ...this.state, readOnly }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.conn.close()
  }
}
