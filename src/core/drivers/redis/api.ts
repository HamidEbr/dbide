import { argBytes, describeCommand, isStreamingCommand } from '@shared/redis/command'
import { RpcError } from '@shared/rpc'
import type {
  CountResult,
  DeleteResult,
  ExecResult,
  KeyDetail,
  RedisApi,
  RedisEdit,
  RedisInfo,
  RedisProgress,
  RedisType,
  ScanPage,
  ScanRequest,
  StreamGroupDetail,
  StreamInfo,
  ValuePage,
  ValueRequest,
} from '@shared/redis/types'
import { K, bin, list, num, pairs, pipeline, send, str } from './calls'
import type { RedisConnection } from './client'
import { applyEdit } from './edit'
import { SessionClosedError, describeRedisError, isUnsupported } from './errors'
import { parseInfo, toInfo } from './info'
import { answersWithStatus, toReply } from './reply'
import { Scanner } from './scan'
import { keyDetail, valuePage } from './values'

const abortError = (): Error => new DOMException('The request was cancelled', 'AbortError')

/** Everything the window asks of a Redis server, as typed operations. */
export class RedisClientApi implements RedisApi {
  readonly scanner: Scanner
  private databases: number | null | undefined
  /** The database the console is in. SELECT changes it. */
  private consoleDb: number
  /** Whether the console is between MULTI and EXEC, where every reply is the word QUEUED. */
  private inTransaction = false

  constructor(private readonly conn: RedisConnection) {
    this.scanner = new Scanner(conn)
    this.consoleDb = conn.setup.db
  }

  /** Runs a call, and turns what the client throws into an error that says what to do. */
  private async run<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    if (this.conn.status === 'end') throw new SessionClosedError()
    try {
      return await call()
    } catch (error) {
      if (signal.aborted) throw error
      throw describeRedisError(error, this.conn.where)
    }
  }

  info(signal: AbortSignal): Promise<RedisInfo> {
    return this.run(signal, async () => {
      const text = str(await send(this.conn.base, 'INFO'))
      return toInfo(parseInfo(text), await this.databaseCount())
    })
  }

  /** How many databases the server has. Managed servers often forbid CONFIG, so this may stay unknown. */
  private async databaseCount(): Promise<number | null> {
    if (this.databases !== undefined) return this.databases
    if (this.conn.setup.mode === 'cluster') return (this.databases = 1)
    try {
      const reply = list(await send(this.conn.base, 'CONFIG', 'GET', 'databases'))
      const n = Number(str(reply[1]))
      this.databases = Number.isInteger(n) && n > 0 ? n : null
    } catch {
      this.databases = null
    }
    return this.databases
  }

  scan(request: ScanRequest, signal: AbortSignal): Promise<ScanPage> {
    return this.run(signal, () => this.scanner.page(request, signal))
  }

  async count(
    db: number,
    pattern: string,
    type: RedisType | undefined,
    signal: AbortSignal,
    onProgress: (progress: Omit<RedisProgress, 'taskId'>) => void,
  ): Promise<CountResult> {
    return this.run(signal, async () => {
      let matched = 0
      await this.scanner.sweep(db, pattern, type, signal, async (keys, examined) => {
        matched += keys.length
        onProgress({ examined, matched, deleted: 0 })
      })
      return { count: matched, complete: true }
    })
  }

  key(db: number, key: string, signal: AbortSignal): Promise<KeyDetail> {
    return this.run(signal, () => keyDetail(this.conn, db, key))
  }

  value(request: ValueRequest, signal: AbortSignal): Promise<ValuePage> {
    return this.run(signal, () => valuePage(this.conn, request))
  }

  memory(db: number, keys: string[], signal: AbortSignal): Promise<(number | null)[]> {
    return this.run(signal, async () => {
      const settled = await pipeline(
        this.conn.client(db),
        keys.map((key) => ['MEMORY', 'USAGE', K(key)]),
      )
      return settled.map(([error, value]) => {
        if (error) {
          // A server without MEMORY, or a user who may not run it, can't say.
          return null
        }
        return value === null ? null : num(value)
      })
    })
  }

  streamInfo(db: number, key: string, signal: AbortSignal): Promise<StreamInfo> {
    return this.run(signal, async () => {
      const client = this.conn.client(db)
      const k = K(key)
      const [stream, groups] = await pipeline(client, [
        ['XINFO', 'STREAM', k],
        ['XINFO', 'GROUPS', k],
      ])
      if (stream?.[0]) throw stream[0]
      const info = pairs(stream?.[1])
      return {
        length: num(info.get('length')),
        lastGeneratedId: str(info.get('last-generated-id')),
        groups: groups?.[0]
          ? []
          : list(groups?.[1]).map((group) => {
              const g = pairs(group)
              const lag = g.get('lag')
              return {
                name: str(g.get('name')),
                consumers: num(g.get('consumers')),
                pending: num(g.get('pending')),
                lastDeliveredId: str(g.get('last-delivered-id')),
                lag: lag === null || lag === undefined ? null : num(lag),
              }
            }),
      }
    })
  }

  streamGroup(
    db: number,
    key: string,
    group: string,
    signal: AbortSignal,
  ): Promise<StreamGroupDetail> {
    return this.run(signal, async () => {
      const client = this.conn.client(db)
      const k = K(key)
      const g = K(group)
      const [consumers, summary, pending] = await pipeline(client, [
        ['XINFO', 'CONSUMERS', k, g],
        ['XPENDING', k, g],
        ['XPENDING', k, g, '-', '+', 100],
      ])
      if (consumers?.[0]) throw consumers[0]
      return {
        consumers: list(consumers?.[1]).map((c) => {
          const f = pairs(c)
          return {
            name: bin(f.get('name')),
            pending: num(f.get('pending')),
            idleMs: num(f.get('idle')),
          }
        }),
        pendingTotal: num(list(summary?.[1])[0]),
        pending: pending?.[0]
          ? []
          : list(pending?.[1]).map((entry) => {
              const [id, consumer, idle, deliveries] = list(entry)
              return {
                id: str(id),
                consumer: bin(consumer),
                idleMs: num(idle),
                deliveries: num(deliveries),
              }
            }),
      }
    })
  }

  edit(db: number, key: string, edit: RedisEdit, signal: AbortSignal): Promise<void> {
    return this.run(signal, () => applyEdit(this.conn, db, key, edit))
  }

  async deleteMatching(
    db: number,
    pattern: string,
    type: RedisType | undefined,
    signal: AbortSignal,
    onProgress: (progress: Omit<RedisProgress, 'taskId'>) => void,
  ): Promise<DeleteResult> {
    return this.run(signal, async () => {
      const client = this.conn.client(db)
      let deleted = 0
      let matched = 0
      let unlink = true
      try {
        await this.scanner.sweep(db, pattern, type, signal, async (keys, examined) => {
          matched += keys.length
          // One command per key: the keys of a batch live in different cluster slots.
          const settled = await pipeline(
            client,
            keys.map((key) => [unlink ? 'UNLINK' : 'DEL', key]),
          )
          if (unlink && settled.some(([error]) => error && isUnsupported(error))) {
            unlink = false
            const again = await pipeline(
              client,
              keys.map((key) => ['DEL', key]),
            )
            deleted += again.reduce((n, [, v]) => n + num(v), 0)
          } else {
            const failed = settled.find(([error]) => error)
            if (failed?.[0]) throw failed[0]
            deleted += settled.reduce((n, [, v]) => n + num(v), 0)
          }
          onProgress({ examined, matched, deleted })
        })
      } catch (error) {
        // A cancelled sweep has still deleted what it deleted.
        if (signal.aborted) return { deleted, complete: false }
        throw error
      }
      return { deleted, complete: true }
    })
  }

  async exec(args: string[], signal: AbortSignal): Promise<ExecResult> {
    signal.throwIfAborted()
    if (this.conn.status === 'end') throw new SessionClosedError()
    const started = performance.now()
    const info = describeCommand(args)
    if (isStreamingCommand(info.name)) {
      throw new RpcError(
        'NOT_SUPPORTED',
        `${info.name} turns the connection into a stream, which the console can’t show yet. Run it in redis-cli.`,
      )
    }
    if (info.name === 'QUIT') {
      throw new RpcError('NOT_SUPPORTED', 'Close the console tab to leave.')
    }
    if (info.name === 'HELLO' && args[1] && args[1] !== '2') {
      throw new RpcError(
        'NOT_SUPPORTED',
        'The console speaks RESP2. HELLO 3 would switch the connection to a protocol it can’t read.',
      )
    }

    const [name, ...rest] = args
    const client = this.conn.base
    const call = client.callBuffer(name!, ...rest.map((a) => Buffer.from(argBytes(a))))
    let value: unknown
    try {
      value = await new Promise<unknown>((resolve, reject) => {
        const onAbort = (): void => {
          // A command that is waiting (BLPOP, XREAD BLOCK) can't be taken back; the connection is dropped instead.
          this.conn.close()
          reject(abortError())
        }
        signal.addEventListener('abort', onAbort, { once: true })
        call.then(
          (v) => {
            signal.removeEventListener('abort', onAbort)
            resolve(v)
          },
          (e: unknown) => {
            signal.removeEventListener('abort', onAbort)
            reject(e)
          },
        )
      })
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof Error && error.name === 'ReplyError') {
        return {
          reply: { t: 'error', text: error.message },
          db: this.consoleDb,
          ms: performance.now() - started,
        }
      }
      throw describeRedisError(error, this.conn.where)
    }

    if (info.name === 'SELECT' && rest[0]) this.consoleDb = Number(rest[0])
    if (info.name === 'RESET') this.consoleDb = 0
    const queued = this.inTransaction && Buffer.isBuffer(value) && value.toString() === 'QUEUED'
    if (info.name === 'MULTI') this.inTransaction = true
    if (['EXEC', 'DISCARD', 'RESET'].includes(info.name)) this.inTransaction = false
    let reply = toReply(value, queued || answersWithStatus(info.name, args.slice(1)))
    // The answers inside EXEC arrive as strings too; the one a write gives, `OK`, is shown as redis-cli shows it.
    if (info.name === 'EXEC' && reply.t === 'array') {
      reply = {
        ...reply,
        items: reply.items.map((item) =>
          item.t === 'bulk' && !item.binary && item.text === 'OK'
            ? { t: 'status', text: 'OK' }
            : item,
        ),
      }
    }
    return {
      reply,
      db: this.consoleDb,
      ms: performance.now() - started,
    }
  }
}
