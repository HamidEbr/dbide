import net from 'node:net'
import {
  array,
  bulk,
  bulks,
  CommandParser,
  encode,
  err,
  globToRegExp,
  int,
  nil,
  ok,
  status,
  type Reply,
} from './fake-resp'

/**
 * A small Redis server that lives in memory and speaks the real protocol (RESP2), so the driver and the
 * window can be tested and smoke-tested without Docker. It implements the commands the app uses, with
 * Redis's own replies and errors, and nothing it doesn't: the live tests against a real server are what
 * prove the rest.
 */

interface StreamEntry {
  ms: bigint
  seq: bigint
  fields: Buffer[]
}
interface Pending {
  consumer: string
  deliveredAt: number
  count: number
}
interface Group {
  last: [bigint, bigint]
  consumers: Map<string, { seen: number }>
  pel: Map<string, Pending>
}
interface Stream {
  entries: StreamEntry[]
  last: [bigint, bigint]
  groups: Map<string, Group>
  added: number
}

type Value =
  | { type: 'string'; v: Buffer }
  | { type: 'hash'; v: Map<string, Buffer> }
  | { type: 'list'; v: Buffer[] }
  | { type: 'set'; v: Set<string> }
  | { type: 'zset'; v: Map<string, number> }
  | { type: 'stream'; v: Stream }
  | { type: 'ReJSON-RL'; v: Buffer }
type Entry = Value & { exp?: number; seq?: number }

/** Keys in the order they arrived, numbered, so a SCAN cursor survives keys being deleted while it runs. */
class Db extends Map<string, Entry> {
  private counter = 0

  override set(key: string, entry: Entry): this {
    if (entry.seq === undefined) entry.seq = ++this.counter
    return super.set(key, entry)
  }
}

class Fail extends Error {}
const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value'
const SYNTAX = 'ERR syntax error'
const NOT_INT = 'ERR value is not an integer or out of range'

const k = (b: Buffer): string => b.toString('latin1')
const bk = (s: string): Buffer => Buffer.from(s, 'latin1')
const up = (b: Buffer): string => b.toString('utf8').toUpperCase()
const text = (b: Buffer): string => b.toString('utf8')

function integer(b: Buffer): number {
  const s = text(b)
  if (!/^[+-]?\d+$/.test(s)) throw new Fail(NOT_INT)
  return Number(s)
}
function double(b: Buffer): number {
  const s = text(b).toLowerCase()
  if (s === 'inf' || s === '+inf') return Infinity
  if (s === '-inf') return -Infinity
  const n = Number(s)
  if (s === '' || Number.isNaN(n)) throw new Fail('ERR value is not a valid float')
  return n
}
const formatDouble = (n: number): string =>
  n === Infinity ? 'inf' : n === -Infinity ? '-inf' : String(n)

function parseId(raw: string, missingSeq: bigint): [bigint, bigint] {
  const [ms, seq] = raw.split('-')
  if (!/^\d+$/.test(ms ?? '') || (seq !== undefined && !/^\d+$/.test(seq))) {
    throw new Fail('ERR Invalid stream ID specified as stream command argument')
  }
  return [BigInt(ms!), seq === undefined ? missingSeq : BigInt(seq)]
}
const idText = (ms: bigint, seq: bigint): string => `${ms}-${seq}`
const cmpId = (a: [bigint, bigint], b: [bigint, bigint]): number =>
  a[0] === b[0] ? (a[1] === b[1] ? 0 : a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1

export interface FakeRedisOptions {
  /** What INFO says. Behaviour that older servers lack (COPY, SET KEEPTTL, SCAN TYPE) follows it. */
  version?: string
  /** The password of the default user. */
  password?: string
  /** An extra user that logs in with `password`. */
  username?: string
  databases?: number
}

export interface FakeRedis {
  host: string
  port: number
  /** Puts a value straight into the keyspace, without a client. */
  seed(db: number, key: string, value: string | Buffer, ttlMs?: number): void
  /** The keys of a database, expired ones included. */
  keys(db: number): string[]
  /** How many connections are open. */
  clients(): number
  /** Moves the clock forward, so expiry can be tested without waiting. */
  advanceTime(ms: number): void
  /** Every command received, upper-cased name first, for asserting what the app sent. */
  log: string[][]
  close(): Promise<void>
}

interface Waiter {
  conn: Conn
  db: number
  keys: string[]
  tail: boolean
  resolve: (reply: Reply) => void
  timer?: NodeJS.Timeout
}

class Conn {
  db = 0
  user: string | null
  multi: Buffer[][] | null = null
  name = ''
  readonly id: number
  private queue: Buffer[][] = []
  private busy = false
  closed = false

  constructor(
    readonly socket: net.Socket,
    id: number,
    user: string | null,
  ) {
    this.id = id
    this.user = user
  }

  enqueue(commands: Buffer[][], run: (args: Buffer[]) => Promise<Reply>): void {
    this.queue.push(...commands)
    if (this.busy) return
    this.busy = true
    void (async () => {
      while (this.queue.length > 0 && !this.closed) {
        const reply = await run(this.queue.shift()!)
        if (!this.closed && reply.k !== 'none') this.socket.write(encode(reply))
      }
      this.busy = false
    })()
  }
}

export async function startFakeRedis(options: FakeRedisOptions = {}): Promise<FakeRedis> {
  const version = options.version ?? '7.2.4'
  const [major = 7, minor = 0] = version.split('.').map(Number)
  const atLeast = (maj: number, min = 0): boolean => major > maj || (major === maj && minor >= min)
  const databases = options.databases ?? 16
  const dbs = new Map<number, Db>()
  const startedAt = Date.now()
  let skew = 0
  const now = (): number => Date.now() + skew
  const log: string[][] = []
  const conns = new Set<Conn>()
  const waiters: Waiter[] = []
  let nextId = 1
  let commandsRun = 0
  const recent: number[] = []

  const requirePassword = options.password !== undefined && options.password !== ''
  const login = (user: string | null, pass: string | null): boolean => {
    if (!requirePassword) return true
    if (user === null || user === 'default') return pass === options.password
    return user === options.username && pass === options.password
  }

  const db = (index: number): Db => {
    let d = dbs.get(index)
    if (!d) dbs.set(index, (d = new Db()))
    return d
  }
  const live = (d: Db, key: string): Entry | undefined => {
    const entry = d.get(key)
    if (entry?.exp !== undefined && entry.exp <= now()) {
      d.delete(key)
      return undefined
    }
    return entry
  }
  const sweep = (d: Db): void => {
    for (const key of [...d.keys()]) live(d, key)
  }

  function wake(index: number): void {
    for (const waiter of [...waiters]) {
      if (waiter.db !== index) continue
      for (const key of waiter.keys) {
        const entry = live(db(index), key)
        if (entry?.type === 'list' && entry.v.length > 0) {
          const item = waiter.tail ? entry.v.pop()! : entry.v.shift()!
          if (entry.v.length === 0) db(index).delete(key)
          waiters.splice(waiters.indexOf(waiter), 1)
          clearTimeout(waiter.timer)
          waiter.resolve(bulks([bk(key), item]))
          break
        }
      }
    }
  }

  const need = (args: Buffer[], n: number, name: string): void => {
    if (args.length < n) {
      throw new Fail(`ERR wrong number of arguments for '${name.toLowerCase()}' command`)
    }
  }

  type Ctx = { conn: Conn; d: Db }
  type Handler = (c: Ctx, a: Buffer[]) => Reply | Promise<Reply>

  const get = <T extends Value['type']>(
    c: Ctx,
    key: Buffer,
    type: T,
  ): Extract<Value, { type: T }> | undefined => {
    const entry = live(c.d, k(key))
    if (!entry) return undefined
    if (entry.type !== type) throw new Fail(WRONGTYPE)
    return entry as Extract<Value, { type: T }>
  }
  const put = (c: Ctx, key: Buffer, value: Value, exp?: number): void => {
    c.d.set(k(key), { ...value, ...(exp !== undefined ? { exp } : {}) } as Entry)
  }
  const emptyCheck = (c: Ctx, key: Buffer): void => {
    const entry = c.d.get(k(key))
    if (!entry) return
    const empty =
      (entry.type === 'hash' && entry.v.size === 0) ||
      (entry.type === 'list' && entry.v.length === 0) ||
      (entry.type === 'set' && entry.v.size === 0) ||
      (entry.type === 'zset' && entry.v.size === 0)
    if (empty) c.d.delete(k(key))
  }

  const encodingOf = (e: Entry): string => {
    switch (e.type) {
      case 'string':
        return /^-?\d{1,18}$/.test(text(e.v)) ? 'int' : e.v.length <= 44 ? 'embstr' : 'raw'
      case 'hash':
        return e.v.size <= 128 ? 'listpack' : 'hashtable'
      case 'list':
        return e.v.length <= 128 ? 'listpack' : 'quicklist'
      case 'set':
        return [...e.v].every((m) => /^\d+$/.test(m)) && e.v.size <= 512
          ? 'intset'
          : e.v.size <= 128
            ? 'listpack'
            : 'hashtable'
      case 'zset':
        return e.v.size <= 128 ? 'listpack' : 'skiplist'
      case 'stream':
        return 'stream'
      default:
        return 'raw'
    }
  }

  const sizeOf = (e: Entry): number => {
    switch (e.type) {
      case 'string':
      case 'ReJSON-RL':
        return 56 + e.v.length
      case 'hash':
        return 64 + [...e.v].reduce((n, [f, v]) => n + 24 + f.length + v.length, 0)
      case 'list':
        return 64 + e.v.reduce((n, v) => n + 11 + v.length, 0)
      case 'set':
        return 64 + [...e.v].reduce((n, m) => n + 16 + m.length, 0)
      case 'zset':
        return 64 + [...e.v].reduce((n, [m]) => n + 32 + m.length, 0)
      case 'stream':
        return (
          128 + e.v.entries.reduce((n, x) => n + 24 + x.fields.reduce((s, f) => s + f.length, 0), 0)
        )
    }
  }

  const ttlMs = (e: Entry): number => (e.exp === undefined ? -1 : Math.max(0, e.exp - now()))

  function clone(e: Entry): Entry {
    switch (e.type) {
      case 'string':
      case 'ReJSON-RL':
        return { ...e, v: Buffer.from(e.v) }
      case 'hash':
        return { ...e, v: new Map(e.v) }
      case 'list':
        return { ...e, v: [...e.v] }
      case 'set':
        return { ...e, v: new Set(e.v) }
      case 'zset':
        return { ...e, v: new Map(e.v) }
      case 'stream':
        return {
          ...e,
          v: {
            ...e.v,
            entries: e.v.entries.map((x) => ({ ...x, fields: [...x.fields] })),
            groups: new Map(
              [...e.v.groups].map(([n, g]) => [
                n,
                { ...g, consumers: new Map(g.consumers), pel: new Map(g.pel) },
              ]),
            ),
          },
        }
    }
  }

  function scanReply(
    items: { key: string; type?: string; seq?: number }[],
    args: Buffer[],
    startAt: number,
    flat: (item: { key: string }) => Buffer[],
    allowType: boolean,
  ): Reply {
    let count = 10
    let match: RegExp | null = null
    let type: string | null = null
    for (let i = startAt; i < args.length; i += 2) {
      const opt = up(args[i]!)
      const val = args[i + 1]
      if (val === undefined) throw new Fail(SYNTAX)
      if (opt === 'COUNT') count = Math.max(1, integer(val))
      else if (opt === 'MATCH') match = globToRegExp(k(val))
      else if (opt === 'TYPE' && allowType) {
        if (!atLeast(6)) throw new Fail(SYNTAX)
        type = text(val)
      } else throw new Fail(SYNTAX)
    }
    const cursor = Number(text(args[startAt - 1]!))
    if (!Number.isInteger(cursor) || cursor < 0) throw new Fail('ERR invalid cursor')
    // Items carrying a sequence number are walked in that order, from just after the cursor; the rest by position.
    const numbered = items.every((x) => x.seq !== undefined)
    const rest = numbered
      ? items.filter((x) => x.seq! > cursor).sort((a, b) => a.seq! - b.seq!)
      : items.slice(cursor)
    const slice = rest.slice(0, count)
    const done = rest.length <= count
    const next = done ? 0 : numbered ? slice[slice.length - 1]!.seq! : cursor + count
    const picked = slice.filter((x) => (!match || match.test(x.key)) && (!type || x.type === type))
    return array([bulk(String(next)), array(picked.flatMap(flat).map((b) => bulk(b)))])
  }

  const handlers: Record<string, Handler> = {
    PING: (_c, a) => (a[0] ? bulk(a[0]) : status('PONG')),
    ECHO: (_c, a) => bulk(a[0] ?? ''),
    QUIT: () => ok(),
    RESET: (c) => {
      c.conn.multi = null
      c.conn.db = 0
      return status('RESET')
    },
    SELECT: (c, a) => {
      need(a, 1, 'select')
      const n = integer(a[0]!)
      if (n < 0 || n >= databases) throw new Fail('ERR DB index is out of range')
      c.conn.db = n
      return ok()
    },
    AUTH: (c, a) => {
      need(a, 1, 'auth')
      if (!requirePassword && a.length === 1) {
        throw new Fail(
          'ERR AUTH <password> called without any password configured for the default user. Are you sure your configuration is correct?',
        )
      }
      if (a.length === 2 && !atLeast(6))
        throw new Fail("ERR wrong number of arguments for 'auth' command")
      const user = a.length === 2 ? text(a[0]!) : null
      const pass = text(a[a.length - 1]!)
      if (!login(user, pass)) {
        throw new Fail('WRONGPASS invalid username-password pair or user is disabled.')
      }
      c.conn.user = user ?? 'default'
      return ok()
    },
    HELLO: (c, a) => {
      if (a[0] && text(a[0]) !== '2') throw new Fail('NOPROTO unsupported protocol version')
      void c
      return array([
        bulk('server'),
        bulk('redis'),
        bulk('version'),
        bulk(version),
        bulk('proto'),
        int(2),
      ])
    },
    CLIENT: (c, a) => {
      const sub = up(a[0] ?? Buffer.alloc(0))
      if (sub === 'SETNAME') {
        c.conn.name = text(a[1] ?? Buffer.alloc(0))
        return ok()
      }
      if (sub === 'GETNAME') return c.conn.name ? bulk(c.conn.name) : nil()
      if (sub === 'SETINFO') {
        if (!atLeast(7, 2))
          throw new Fail("ERR Unknown subcommand or wrong number of arguments for 'SETINFO'")
        return ok()
      }
      if (sub === 'ID') return int(c.conn.id)
      if (sub === 'LIST' || sub === 'INFO') {
        return bulk(`id=${c.conn.id} addr=127.0.0.1:0 name=${c.conn.name} db=${c.conn.db}\n`)
      }
      throw new Fail(`ERR unknown subcommand '${text(a[0] ?? Buffer.alloc(0))}'`)
    },
    COMMAND: () => array([]),
    TIME: () => bulks([String(Math.floor(now() / 1000)), String((now() % 1000) * 1000)]),
    ROLE: () => array([bulk('master'), int(0), array([])]),
    DBSIZE: (c) => {
      sweep(c.d)
      return int(c.d.size)
    },
    FLUSHDB: (c) => {
      c.d.clear()
      return ok()
    },
    FLUSHALL: () => {
      dbs.clear()
      return ok()
    },
    CONFIG: (_c, a) => {
      const sub = up(a[0] ?? Buffer.alloc(0))
      if (sub === 'GET') {
        const values: Record<string, string> = {
          databases: String(databases),
          maxmemory: '0',
          save: '',
        }
        const wanted = text(a[1] ?? Buffer.alloc(0))
        return bulks(
          Object.entries(values)
            .filter(([n]) => n === wanted)
            .flat(),
        )
      }
      if (sub === 'SET') return ok()
      throw new Fail('ERR unknown subcommand')
    },
    INFO: (c) => {
      for (const d of dbs.values()) sweep(d)
      const cutoff = now() - 1000
      while (recent.length > 0 && recent[0]! < cutoff) recent.shift()
      const lines = [
        '# Server',
        `redis_version:${version}`,
        'redis_mode:standalone',
        'os:Fake 1.0 x86_64',
        `uptime_in_seconds:${Math.floor((now() - startedAt) / 1000)}`,
        '',
        '# Clients',
        `connected_clients:${conns.size}`,
        `blocked_clients:${waiters.length}`,
        '',
        '# Memory',
        `used_memory:${1_000_000 + [...dbs.values()].reduce((n, d) => n + d.size * 100, 0)}`,
        'used_memory_peak:2000000',
        'used_memory_rss:3000000',
        'mem_fragmentation_ratio:1.5',
        'maxmemory:0',
        '',
        '# Stats',
        `total_commands_processed:${commandsRun}`,
        `instantaneous_ops_per_sec:${recent.length}`,
        'instantaneous_input_kbps:0.10',
        'instantaneous_output_kbps:0.20',
        'keyspace_hits:10',
        'keyspace_misses:5',
        'expired_keys:0',
        'evicted_keys:0',
        '',
        '# Replication',
        'role:master',
        'connected_slaves:0',
        '',
        '# Cluster',
        'cluster_enabled:0',
        '',
        '# Keyspace',
        ...[...dbs.entries()]
          .filter(([, d]) => d.size > 0)
          .sort(([x], [y]) => x - y)
          .map(([n, d]) => {
            const expires = [...d.values()].filter((e) => e.exp !== undefined).length
            return `db${n}:keys=${d.size},expires=${expires},avg_ttl=0`
          }),
      ]
      void c
      return bulk(`${lines.join('\r\n')}\r\n`)
    },
    MEMORY: (c, a) => {
      if (up(a[0] ?? Buffer.alloc(0)) !== 'USAGE') throw new Fail('ERR unknown subcommand')
      const entry = live(c.d, k(a[1] ?? Buffer.alloc(0)))
      return entry ? int(sizeOf(entry)) : nil()
    },
    OBJECT: (c, a) => {
      const sub = up(a[0] ?? Buffer.alloc(0))
      const entry = live(c.d, k(a[1] ?? Buffer.alloc(0)))
      if (!entry) return nil()
      if (sub === 'ENCODING') return bulk(encodingOf(entry))
      if (sub === 'IDLETIME') return int(0)
      if (sub === 'REFCOUNT') return int(1)
      if (sub === 'FREQ')
        throw new Fail('ERR An LFU maxmemory policy is not selected, access frequency not tracked.')
      throw new Fail('ERR unknown subcommand')
    },

    // Keys
    DEL: (c, a) => int(a.filter((key) => live(c.d, k(key)) && c.d.delete(k(key))).length),
    UNLINK: (c, a) => {
      if (!atLeast(4)) throw new Fail("ERR unknown command 'UNLINK'")
      return int(a.filter((key) => live(c.d, k(key)) && c.d.delete(k(key))).length)
    },
    EXISTS: (c, a) => int(a.filter((key) => live(c.d, k(key))).length),
    TOUCH: (c, a) => int(a.filter((key) => live(c.d, k(key))).length),
    TYPE: (c, a) => status(live(c.d, k(a[0] ?? Buffer.alloc(0)))?.type ?? 'none'),
    TTL: (c, a) => {
      const e = live(c.d, k(a[0] ?? Buffer.alloc(0)))
      return int(!e ? -2 : e.exp === undefined ? -1 : Math.ceil(ttlMs(e) / 1000))
    },
    PTTL: (c, a) => {
      const e = live(c.d, k(a[0] ?? Buffer.alloc(0)))
      return int(!e ? -2 : ttlMs(e))
    },
    EXPIRETIME: (c, a) => {
      const e = live(c.d, k(a[0] ?? Buffer.alloc(0)))
      return int(!e ? -2 : e.exp === undefined ? -1 : Math.floor(e.exp / 1000))
    },
    EXPIRE: (c, a) => setExpiry(c, a, (n) => now() + n * 1000),
    PEXPIRE: (c, a) => setExpiry(c, a, (n) => now() + n),
    EXPIREAT: (c, a) => setExpiry(c, a, (n) => n * 1000),
    PEXPIREAT: (c, a) => setExpiry(c, a, (n) => n),
    PERSIST: (c, a) => {
      const e = live(c.d, k(a[0] ?? Buffer.alloc(0)))
      if (!e || e.exp === undefined) return int(0)
      delete e.exp
      return int(1)
    },
    KEYS: (c, a) => {
      sweep(c.d)
      const re = globToRegExp(k(a[0] ?? Buffer.from('*')))
      return bulks([...c.d.keys()].filter((key) => re.test(key)).map(bk))
    },
    SCAN: (c, a) => {
      need(a, 1, 'scan')
      sweep(c.d)
      return scanReply(
        [...c.d.entries()].map(([key, e]) => ({ key, type: e.type, seq: e.seq })),
        a,
        1,
        (x) => [bk(x.key)],
        true,
      )
    },
    RANDOMKEY: (c) => {
      sweep(c.d)
      const keys = [...c.d.keys()]
      return keys.length === 0 ? nil() : bulk(bk(keys[Math.floor(Math.random() * keys.length)]!))
    },
    RENAME: (c, a) => rename(c, a, false),
    RENAMENX: (c, a) => rename(c, a, true),
    COPY: (c, a) => {
      if (!atLeast(6, 2)) throw new Fail("ERR unknown command 'COPY'")
      need(a, 2, 'copy')
      let target = c.d
      let replace = false
      for (let i = 2; i < a.length; i++) {
        const opt = up(a[i]!)
        if (opt === 'REPLACE') replace = true
        else if (opt === 'DB') target = db(integer(a[++i] ?? Buffer.alloc(0)))
        else throw new Fail(SYNTAX)
      }
      const src = live(c.d, k(a[0]!))
      if (!src) return int(0)
      if (live(target, k(a[1]!)) && !replace) return int(0)
      target.set(k(a[1]!), clone(src))
      return int(1)
    },
    DUMP: (c, a) => {
      const e = live(c.d, k(a[0] ?? Buffer.alloc(0)))
      if (!e) return nil()
      return bulk(
        Buffer.concat([Buffer.from('FAKEDUMP'), Buffer.from(JSON.stringify(serialize(e)))]),
      )
    },
    RESTORE: (c, a) => {
      need(a, 3, 'restore')
      const replace = a.slice(3).some((x) => up(x) === 'REPLACE')
      if (live(c.d, k(a[0]!)) && !replace) throw new Fail('BUSYKEY Target key name already exists.')
      const payload = a[2]!
      if (!payload.subarray(0, 8).equals(Buffer.from('FAKEDUMP'))) {
        throw new Fail('ERR DUMP payload version or checksum are wrong')
      }
      const entry = deserialize(JSON.parse(payload.subarray(8).toString()))
      const ttl = integer(a[1]!)
      c.d.set(k(a[0]!), ttl > 0 ? { ...entry, exp: now() + ttl } : entry)
      return ok()
    },
    MOVE: (c, a) => {
      const to = db(integer(a[1] ?? Buffer.alloc(0)))
      const e = live(c.d, k(a[0] ?? Buffer.alloc(0)))
      if (!e || live(to, k(a[0]!))) return int(0)
      to.set(k(a[0]!), e)
      c.d.delete(k(a[0]!))
      return int(1)
    },

    // Strings
    GET: (c, a) => {
      const e = get(c, a[0] ?? Buffer.alloc(0), 'string')
      return e ? bulk(e.v) : nil()
    },
    GETDEL: (c, a) => {
      const e = get(c, a[0] ?? Buffer.alloc(0), 'string')
      if (!e) return nil()
      c.d.delete(k(a[0]!))
      return bulk(e.v)
    },
    SET: (c, a) => {
      need(a, 2, 'set')
      let nx = false
      let xx = false
      let wantOld = false
      let exp: number | undefined
      let keep = false
      for (let i = 2; i < a.length; i++) {
        const opt = up(a[i]!)
        if (opt === 'NX') nx = true
        else if (opt === 'XX') xx = true
        else if (opt === 'GET') wantOld = true
        else if (opt === 'KEEPTTL') {
          if (!atLeast(6)) throw new Fail(SYNTAX)
          keep = true
        } else if (opt === 'EX') exp = now() + integer(a[++i] ?? Buffer.alloc(0)) * 1000
        else if (opt === 'PX') exp = now() + integer(a[++i] ?? Buffer.alloc(0))
        else if (opt === 'EXAT') exp = integer(a[++i] ?? Buffer.alloc(0)) * 1000
        else if (opt === 'PXAT') exp = integer(a[++i] ?? Buffer.alloc(0))
        else throw new Fail(SYNTAX)
      }
      const existing = live(c.d, k(a[0]!))
      if (wantOld && existing && existing.type !== 'string') throw new Fail(WRONGTYPE)
      const old = existing?.type === 'string' ? existing.v : null
      if ((nx && existing) || (xx && !existing)) return wantOld && old ? bulk(old) : nil()
      put(c, a[0]!, { type: 'string', v: Buffer.from(a[1]!) }, keep ? existing?.exp : exp)
      return wantOld ? (old ? bulk(old) : nil()) : ok()
    },
    SETEX: (c, a) => {
      need(a, 3, 'setex')
      put(c, a[0]!, { type: 'string', v: Buffer.from(a[2]!) }, now() + integer(a[1]!) * 1000)
      return ok()
    },
    PSETEX: (c, a) => {
      need(a, 3, 'psetex')
      put(c, a[0]!, { type: 'string', v: Buffer.from(a[2]!) }, now() + integer(a[1]!))
      return ok()
    },
    SETNX: (c, a) => {
      need(a, 2, 'setnx')
      if (live(c.d, k(a[0]!))) return int(0)
      put(c, a[0]!, { type: 'string', v: Buffer.from(a[1]!) })
      return int(1)
    },
    MSET: (c, a) => {
      if (a.length === 0 || a.length % 2 !== 0) {
        throw new Fail("ERR wrong number of arguments for 'mset' command")
      }
      for (let i = 0; i < a.length; i += 2)
        put(c, a[i]!, { type: 'string', v: Buffer.from(a[i + 1]!) })
      return ok()
    },
    MGET: (c, a) =>
      array(
        a.map((key) => {
          const e = live(c.d, k(key))
          return e?.type === 'string' ? bulk(e.v) : nil()
        }),
      ),
    APPEND: (c, a) => {
      need(a, 2, 'append')
      const e = get(c, a[0]!, 'string')
      const v = Buffer.concat([e?.v ?? Buffer.alloc(0), a[1]!])
      put(c, a[0]!, { type: 'string', v }, e ? live(c.d, k(a[0]!))?.exp : undefined)
      return int(v.length)
    },
    STRLEN: (c, a) => int(get(c, a[0] ?? Buffer.alloc(0), 'string')?.v.length ?? 0),
    GETRANGE: (c, a) => {
      need(a, 3, 'getrange')
      const v = get(c, a[0]!, 'string')?.v ?? Buffer.alloc(0)
      let start = integer(a[1]!)
      let end = integer(a[2]!)
      if (start < 0) start = Math.max(0, v.length + start)
      if (end < 0) end = v.length + end
      return bulk(start > end ? Buffer.alloc(0) : v.subarray(start, end + 1))
    },
    SETRANGE: (c, a) => {
      need(a, 3, 'setrange')
      const e = get(c, a[0]!, 'string')
      const offset = integer(a[1]!)
      const old = e?.v ?? Buffer.alloc(0)
      const v = Buffer.alloc(Math.max(old.length, offset + a[2]!.length))
      old.copy(v)
      a[2]!.copy(v, offset)
      put(c, a[0]!, { type: 'string', v })
      return int(v.length)
    },
    INCR: (c, a) => incr(c, a[0]!, 1),
    DECR: (c, a) => incr(c, a[0]!, -1),
    INCRBY: (c, a) => incr(c, a[0]!, integer(a[1] ?? Buffer.alloc(0))),
    DECRBY: (c, a) => incr(c, a[0]!, -integer(a[1] ?? Buffer.alloc(0))),

    // Hashes
    HSET: (c, a) => {
      if (a.length < 3 || a.length % 2 === 0)
        throw new Fail("ERR wrong number of arguments for 'hset' command")
      let e = get(c, a[0]!, 'hash')
      if (!e) put(c, a[0]!, (e = { type: 'hash', v: new Map() }))
      let added = 0
      for (let i = 1; i < a.length; i += 2) {
        if (!e.v.has(k(a[i]!))) added++
        e.v.set(k(a[i]!), Buffer.from(a[i + 1]!))
      }
      return int(added)
    },
    HMSET: (c, a) => {
      void handlers.HSET!(c, a)
      return ok()
    },
    HSETNX: (c, a) => {
      let e = get(c, a[0]!, 'hash')
      if (!e) put(c, a[0]!, (e = { type: 'hash', v: new Map() }))
      if (e.v.has(k(a[1]!))) return int(0)
      e.v.set(k(a[1]!), Buffer.from(a[2]!))
      return int(1)
    },
    HGET: (c, a) => {
      const v = get(c, a[0] ?? Buffer.alloc(0), 'hash')?.v.get(k(a[1] ?? Buffer.alloc(0)))
      return v ? bulk(v) : nil()
    },
    HMGET: (c, a) => {
      const e = get(c, a[0] ?? Buffer.alloc(0), 'hash')
      return array(a.slice(1).map((f) => (e?.v.has(k(f)) ? bulk(e.v.get(k(f))!) : nil())))
    },
    HGETALL: (c, a) =>
      bulks(
        [...(get(c, a[0] ?? Buffer.alloc(0), 'hash')?.v ?? [])].flatMap(([f, v]) => [bk(f), v]),
      ),
    HKEYS: (c, a) => bulks([...(get(c, a[0] ?? Buffer.alloc(0), 'hash')?.v.keys() ?? [])].map(bk)),
    HVALS: (c, a) => bulks([...(get(c, a[0] ?? Buffer.alloc(0), 'hash')?.v.values() ?? [])]),
    HLEN: (c, a) => int(get(c, a[0] ?? Buffer.alloc(0), 'hash')?.v.size ?? 0),
    HEXISTS: (c, a) =>
      int(get(c, a[0] ?? Buffer.alloc(0), 'hash')?.v.has(k(a[1] ?? Buffer.alloc(0))) ? 1 : 0),
    HSTRLEN: (c, a) =>
      int(get(c, a[0] ?? Buffer.alloc(0), 'hash')?.v.get(k(a[1] ?? Buffer.alloc(0)))?.length ?? 0),
    HDEL: (c, a) => {
      const e = get(c, a[0] ?? Buffer.alloc(0), 'hash')
      if (!e) return int(0)
      const n = a.slice(1).filter((f) => e.v.delete(k(f))).length
      emptyCheck(c, a[0]!)
      return int(n)
    },
    HINCRBY: (c, a) => {
      let e = get(c, a[0]!, 'hash')
      if (!e) put(c, a[0]!, (e = { type: 'hash', v: new Map() }))
      const old = e.v.get(k(a[1]!))
      const next = (old ? integer(old) : 0) + integer(a[2]!)
      e.v.set(k(a[1]!), Buffer.from(String(next)))
      return int(next)
    },
    HSCAN: (c, a) => {
      need(a, 2, 'hscan')
      const e = get(c, a[0]!, 'hash')
      return scanReply(
        [...(e?.v ?? [])].map(([key]) => ({ key })),
        a,
        2,
        (x) => [bk(x.key), e!.v.get(x.key)!],
        false,
      )
    },

    // Lists
    LPUSH: (c, a) => push(c, a, false, false),
    RPUSH: (c, a) => push(c, a, true, false),
    LPUSHX: (c, a) => push(c, a, false, true),
    RPUSHX: (c, a) => push(c, a, true, true),
    LPOP: (c, a) => pop(c, a, false),
    RPOP: (c, a) => pop(c, a, true),
    LLEN: (c, a) => int(get(c, a[0] ?? Buffer.alloc(0), 'list')?.v.length ?? 0),
    LRANGE: (c, a) => {
      need(a, 3, 'lrange')
      const v = get(c, a[0]!, 'list')?.v ?? []
      let start = integer(a[1]!)
      let end = integer(a[2]!)
      if (start < 0) start = Math.max(0, v.length + start)
      if (end < 0) end = v.length + end
      return bulks(v.slice(start, end + 1))
    },
    LINDEX: (c, a) => {
      const v = get(c, a[0] ?? Buffer.alloc(0), 'list')?.v ?? []
      let i = integer(a[1] ?? Buffer.alloc(0))
      if (i < 0) i += v.length
      return v[i] ? bulk(v[i]!) : nil()
    },
    LSET: (c, a) => {
      need(a, 3, 'lset')
      const e = get(c, a[0]!, 'list')
      if (!e) throw new Fail('ERR no such key')
      let i = integer(a[1]!)
      if (i < 0) i += e.v.length
      if (i < 0 || i >= e.v.length) throw new Fail('ERR index out of range')
      e.v[i] = Buffer.from(a[2]!)
      return ok()
    },
    LREM: (c, a) => {
      need(a, 3, 'lrem')
      const e = get(c, a[0]!, 'list')
      if (!e) return int(0)
      const count = integer(a[1]!)
      let limit = count === 0 ? Infinity : Math.abs(count)
      let removed = 0
      const order = count < 0 ? [...e.v.keys()].reverse() : [...e.v.keys()]
      const drop = new Set<number>()
      for (const i of order) {
        if (limit > 0 && e.v[i]!.equals(a[2]!)) {
          drop.add(i)
          removed++
          limit--
        }
      }
      e.v = e.v.filter((_, i) => !drop.has(i))
      emptyCheck(c, a[0]!)
      return int(removed)
    },
    LTRIM: (c, a) => {
      const e = get(c, a[0] ?? Buffer.alloc(0), 'list')
      if (!e) return ok()
      let start = integer(a[1] ?? Buffer.alloc(0))
      let end = integer(a[2] ?? Buffer.alloc(0))
      if (start < 0) start = Math.max(0, e.v.length + start)
      if (end < 0) end = e.v.length + end
      e.v = e.v.slice(start, end + 1)
      emptyCheck(c, a[0]!)
      return ok()
    },
    BLPOP: (c, a) => block(c, a, false),
    BRPOP: (c, a) => block(c, a, true),

    // Sets
    SADD: (c, a) => {
      need(a, 2, 'sadd')
      let e = get(c, a[0]!, 'set')
      if (!e) put(c, a[0]!, (e = { type: 'set', v: new Set() }))
      let added = 0
      for (const m of a.slice(1)) {
        if (!e.v.has(k(m))) {
          e.v.add(k(m))
          added++
        }
      }
      return int(added)
    },
    SREM: (c, a) => {
      const e = get(c, a[0] ?? Buffer.alloc(0), 'set')
      if (!e) return int(0)
      const n = a.slice(1).filter((m) => e.v.delete(k(m))).length
      emptyCheck(c, a[0]!)
      return int(n)
    },
    SMEMBERS: (c, a) => bulks([...(get(c, a[0] ?? Buffer.alloc(0), 'set')?.v ?? [])].map(bk)),
    SCARD: (c, a) => int(get(c, a[0] ?? Buffer.alloc(0), 'set')?.v.size ?? 0),
    SISMEMBER: (c, a) =>
      int(get(c, a[0] ?? Buffer.alloc(0), 'set')?.v.has(k(a[1] ?? Buffer.alloc(0))) ? 1 : 0),
    SPOP: (c, a) => {
      const e = get(c, a[0] ?? Buffer.alloc(0), 'set')
      if (!e) return nil()
      const first = e.v.values().next().value as string
      e.v.delete(first)
      emptyCheck(c, a[0]!)
      return bulk(bk(first))
    },
    SSCAN: (c, a) => {
      need(a, 2, 'sscan')
      const e = get(c, a[0]!, 'set')
      return scanReply(
        [...(e?.v ?? [])].map((key) => ({ key })),
        a,
        2,
        (x) => [bk(x.key)],
        false,
      )
    },

    // Sorted sets
    ZADD: (c, a) => {
      need(a, 3, 'zadd')
      let i = 1
      let nx = false
      let xx = false
      let gt = false
      let lt = false
      let ch = false
      let incr = false
      for (; i < a.length; i++) {
        const o = up(a[i]!)
        if (o === 'NX') nx = true
        else if (o === 'XX') xx = true
        else if (o === 'GT') gt = true
        else if (o === 'LT') lt = true
        else if (o === 'CH') ch = true
        else if (o === 'INCR') incr = true
        else break
      }
      if ((a.length - i) % 2 !== 0 || a.length - i === 0) throw new Fail(SYNTAX)
      let e = get(c, a[0]!, 'zset')
      let added = 0
      let changed = 0
      let last: number | null = null
      for (; i < a.length; i += 2) {
        const score = double(a[i]!)
        const member = k(a[i + 1]!)
        if (!e) put(c, a[0]!, (e = { type: 'zset', v: new Map() }))
        const old = e.v.get(member)
        if (old === undefined) {
          if (xx) continue
          e.v.set(member, score)
          added++
          changed++
          last = score
        } else {
          if (nx) continue
          const next = incr ? old + score : score
          if ((gt && next <= old) || (lt && next >= old)) continue
          if (next !== old) changed++
          e.v.set(member, next)
          last = next
        }
      }
      emptyCheck(c, a[0]!)
      if (incr) return last === null ? nil() : bulk(formatDouble(last))
      return int(ch ? changed : added)
    },
    ZINCRBY: (c, a) => {
      need(a, 3, 'zincrby')
      let e = get(c, a[0]!, 'zset')
      if (!e) put(c, a[0]!, (e = { type: 'zset', v: new Map() }))
      const next = (e.v.get(k(a[2]!)) ?? 0) + double(a[1]!)
      e.v.set(k(a[2]!), next)
      return bulk(formatDouble(next))
    },
    ZREM: (c, a) => {
      const e = get(c, a[0] ?? Buffer.alloc(0), 'zset')
      if (!e) return int(0)
      const n = a.slice(1).filter((m) => e.v.delete(k(m))).length
      emptyCheck(c, a[0]!)
      return int(n)
    },
    ZCARD: (c, a) => int(get(c, a[0] ?? Buffer.alloc(0), 'zset')?.v.size ?? 0),
    ZSCORE: (c, a) => {
      const s = get(c, a[0] ?? Buffer.alloc(0), 'zset')?.v.get(k(a[1] ?? Buffer.alloc(0)))
      return s === undefined ? nil() : bulk(formatDouble(s))
    },
    ZRANK: (c, a) => {
      const sorted = sortedZset(get(c, a[0] ?? Buffer.alloc(0), 'zset'))
      const i = sorted.findIndex(([m]) => m === k(a[1] ?? Buffer.alloc(0)))
      return i < 0 ? nil() : int(i)
    },
    ZRANGE: (c, a) => zrange(c, a, false),
    ZREVRANGE: (c, a) => zrange(c, a, true),
    ZCOUNT: (c, a) => {
      const lo = bound(a[1] ?? Buffer.alloc(0))
      const hi = bound(a[2] ?? Buffer.alloc(0))
      return int(
        sortedZset(get(c, a[0] ?? Buffer.alloc(0), 'zset')).filter(([, s]) => within(s, lo, hi))
          .length,
      )
    },
    ZRANGEBYSCORE: (c, a) => {
      const lo = bound(a[1] ?? Buffer.alloc(0))
      const hi = bound(a[2] ?? Buffer.alloc(0))
      const withScores = a.slice(3).some((x) => up(x) === 'WITHSCORES')
      return bulks(
        sortedZset(get(c, a[0] ?? Buffer.alloc(0), 'zset'))
          .filter(([, s]) => within(s, lo, hi))
          .flatMap(([m, s]) => (withScores ? [bk(m), formatDouble(s)] : [bk(m)])),
      )
    },
    ZSCAN: (c, a) => {
      need(a, 2, 'zscan')
      const e = get(c, a[0]!, 'zset')
      return scanReply(
        sortedZset(e).map(([key]) => ({ key })),
        a,
        2,
        (x) => [bk(x.key), bk(formatDouble(e!.v.get(x.key)!))],
        false,
      )
    },

    // Streams
    XADD: (c, a) => {
      need(a, 4, 'xadd')
      let i = 1
      let noMk = false
      let maxlen: number | null = null
      for (; i < a.length; i++) {
        const o = up(a[i]!)
        if (o === 'NOMKSTREAM') noMk = true
        else if (o === 'MAXLEN') {
          i++
          if (['=', '~'].includes(text(a[i]!))) i++
          maxlen = integer(a[i]!)
        } else break
      }
      const idArg = text(a[i++]!)
      if ((a.length - i) % 2 !== 0 || a.length - i === 0) {
        throw new Fail("ERR wrong number of arguments for 'xadd' command")
      }
      let e = get(c, a[0]!, 'stream')
      if (!e) {
        if (noMk) return nil()
        put(
          c,
          a[0]!,
          (e = { type: 'stream', v: { entries: [], last: [0n, 0n], groups: new Map(), added: 0 } }),
        )
      }
      const s = e.v
      let id: [bigint, bigint]
      if (idArg === '*') {
        const ms = BigInt(now())
        id = ms > s.last[0] ? [ms, 0n] : [s.last[0], s.last[1] + 1n]
      } else if (idArg.endsWith('-*')) {
        const ms = BigInt(idArg.slice(0, -2))
        id = ms === s.last[0] ? [ms, s.last[1] + 1n] : [ms, 0n]
      } else {
        id = parseId(idArg, 0n)
      }
      if (id[0] === 0n && id[1] === 0n)
        throw new Fail('ERR The ID specified in XADD must be greater than 0-0')
      if (cmpId(id, s.last) <= 0) {
        throw new Fail(
          'ERR The ID specified in XADD is equal or smaller than the target stream top item',
        )
      }
      s.entries.push({ ms: id[0], seq: id[1], fields: a.slice(i).map((f) => Buffer.from(f)) })
      s.last = id
      s.added++
      if (maxlen !== null && s.entries.length > maxlen)
        s.entries.splice(0, s.entries.length - maxlen)
      return bulk(idText(id[0], id[1]))
    },
    XLEN: (c, a) => int(get(c, a[0] ?? Buffer.alloc(0), 'stream')?.v.entries.length ?? 0),
    XRANGE: (c, a) => xrange(c, a, false),
    XREVRANGE: (c, a) => xrange(c, a, true),
    XDEL: (c, a) => {
      const e = get(c, a[0] ?? Buffer.alloc(0), 'stream')
      if (!e) return int(0)
      let n = 0
      for (const raw of a.slice(1)) {
        const id = parseId(text(raw), 0n)
        const i = e.v.entries.findIndex((x) => x.ms === id[0] && x.seq === id[1])
        if (i >= 0) {
          e.v.entries.splice(i, 1)
          n++
        }
      }
      return int(n)
    },
    XGROUP: (c, a) => {
      const sub = up(a[0] ?? Buffer.alloc(0))
      if (sub === 'CREATE') {
        need(a, 4, 'xgroup')
        let e = get(c, a[1]!, 'stream')
        if (!e) {
          if (!a.slice(4).some((x) => up(x) === 'MKSTREAM')) {
            throw new Fail(
              'ERR The XGROUP subcommand requires the key to exist. Note that for CREATE you may want to use the MKSTREAM option to create an empty stream automatically.',
            )
          }
          put(
            c,
            a[1]!,
            (e = {
              type: 'stream',
              v: { entries: [], last: [0n, 0n], groups: new Map(), added: 0 },
            }),
          )
        }
        if (e.v.groups.has(text(a[2]!)))
          throw new Fail('BUSYGROUP Consumer Group name already exists')
        const at = text(a[3]!)
        e.v.groups.set(text(a[2]!), {
          last: at === '$' ? e.v.last : parseId(at, 0n),
          consumers: new Map(),
          pel: new Map(),
        })
        return ok()
      }
      if (sub === 'DESTROY') {
        const e = get(c, a[1] ?? Buffer.alloc(0), 'stream')
        return int(e?.v.groups.delete(text(a[2] ?? Buffer.alloc(0))) ? 1 : 0)
      }
      if (sub === 'CREATECONSUMER') {
        const g = group(c, a[1], a[2])
        const had = g.consumers.has(text(a[3] ?? Buffer.alloc(0)))
        g.consumers.set(text(a[3] ?? Buffer.alloc(0)), { seen: now() })
        return int(had ? 0 : 1)
      }
      throw new Fail('ERR unknown subcommand')
    },
    XREADGROUP: (c, a) => {
      // XREADGROUP GROUP g c [COUNT n] STREAMS key >
      if (up(a[0] ?? Buffer.alloc(0)) !== 'GROUP') throw new Fail(SYNTAX)
      const gname = text(a[1]!)
      const consumer = text(a[2]!)
      let count = Infinity
      let i = 3
      if (up(a[i]!) === 'COUNT') {
        count = integer(a[i + 1]!)
        i += 2
      }
      if (up(a[i]!) !== 'STREAMS') throw new Fail(SYNTAX)
      const key = a[i + 1]!
      const g = group(c, key, Buffer.from(gname))
      const s = get(c, key, 'stream')!.v
      g.consumers.set(consumer, { seen: now() })
      const fresh = s.entries.filter((x) => cmpId([x.ms, x.seq], g.last) > 0).slice(0, count)
      for (const x of fresh) {
        g.pel.set(idText(x.ms, x.seq), { consumer, deliveredAt: now(), count: 1 })
        g.last = [x.ms, x.seq]
      }
      if (fresh.length === 0) return array(null)
      return array([array([bulk(key), array(fresh.map(entryReply))])])
    },
    XACK: (c, a) => {
      const g = group(c, a[0], a[1])
      return int(a.slice(2).filter((id) => g.pel.delete(text(id))).length)
    },
    XPENDING: (c, a) => {
      const g = group(c, a[0], a[1])
      if (a.length === 2) {
        if (g.pel.size === 0) return array([int(0), nil(), nil(), nil()])
        const ids = [...g.pel.keys()].sort((x, y) => cmpId(parseId(x, 0n), parseId(y, 0n)))
        const per = new Map<string, number>()
        for (const p of g.pel.values()) per.set(p.consumer, (per.get(p.consumer) ?? 0) + 1)
        return array([
          int(g.pel.size),
          bulk(ids[0]!),
          bulk(ids[ids.length - 1]!),
          array([...per].map(([n, v]) => bulks([n, String(v)]))),
        ])
      }
      const count = integer(a[4] ?? Buffer.alloc(0))
      const only = a[5] ? text(a[5]) : null
      return array(
        [...g.pel]
          .filter(([, p]) => only === null || p.consumer === only)
          .sort(([x], [y]) => cmpId(parseId(x, 0n), parseId(y, 0n)))
          .slice(0, count)
          .map(([id, p]) =>
            array([
              bulk(id),
              bulk(p.consumer),
              int(Math.max(0, now() - p.deliveredAt)),
              int(p.count),
            ]),
          ),
      )
    },
    XINFO: (c, a) => {
      const sub = up(a[0] ?? Buffer.alloc(0))
      const e = get(c, a[1] ?? Buffer.alloc(0), 'stream')
      if (!e) throw new Fail('ERR no such key')
      const s = e.v
      if (sub === 'STREAM') {
        const first = s.entries[0]
        const last = s.entries[s.entries.length - 1]
        return array([
          bulk('length'),
          int(s.entries.length),
          bulk('radix-tree-keys'),
          int(1),
          bulk('radix-tree-nodes'),
          int(2),
          bulk('last-generated-id'),
          bulk(idText(s.last[0], s.last[1])),
          bulk('entries-added'),
          int(s.added),
          bulk('groups'),
          int(s.groups.size),
          bulk('first-entry'),
          first ? entryReply(first) : nil(),
          bulk('last-entry'),
          last ? entryReply(last) : nil(),
        ])
      }
      if (sub === 'GROUPS') {
        return array(
          [...s.groups].map(([name, g]) =>
            array([
              bulk('name'),
              bulk(name),
              bulk('consumers'),
              int(g.consumers.size),
              bulk('pending'),
              int(g.pel.size),
              bulk('last-delivered-id'),
              bulk(idText(g.last[0], g.last[1])),
              bulk('entries-read'),
              nil(),
              bulk('lag'),
              int(s.entries.filter((x) => cmpId([x.ms, x.seq], g.last) > 0).length),
            ]),
          ),
        )
      }
      if (sub === 'CONSUMERS') {
        const g = s.groups.get(text(a[2] ?? Buffer.alloc(0)))
        if (!g) throw new Fail('NOGROUP No such consumer group for key name')
        return array(
          [...g.consumers].map(([name, info]) =>
            array([
              bulk('name'),
              bulk(name),
              bulk('pending'),
              int([...g.pel.values()].filter((p) => p.consumer === name).length),
              bulk('idle'),
              int(Math.max(0, now() - info.seen)),
            ]),
          ),
        )
      }
      throw new Fail('ERR unknown subcommand')
    },

    // Transactions
    MULTI: (c) => {
      if (c.conn.multi) throw new Fail('ERR MULTI calls can not be nested')
      c.conn.multi = []
      return ok()
    },
    DISCARD: (c) => {
      if (!c.conn.multi) throw new Fail('ERR DISCARD without MULTI')
      c.conn.multi = null
      return ok()
    },
    WATCH: () => ok(),
    UNWATCH: () => ok(),

    // RedisJSON, enough to show and read one document.
    'JSON.SET': (c, a) => {
      need(a, 3, 'json.set')
      put(c, a[0]!, { type: 'ReJSON-RL', v: Buffer.from(a[2]!) })
      return ok()
    },
    'JSON.GET': (c, a) => {
      const e = live(c.d, k(a[0] ?? Buffer.alloc(0)))
      if (!e) return nil()
      if (e.type !== 'ReJSON-RL') throw new Fail(WRONGTYPE)
      return bulk(e.v)
    },
  }

  function setExpiry(c: Ctx, a: Buffer[], at: (n: number) => number): Reply {
    need(a, 2, 'expire')
    const e = live(c.d, k(a[0]!))
    if (!e) return int(0)
    const when = at(integer(a[1]!))
    if (when <= now()) {
      c.d.delete(k(a[0]!))
      return int(1)
    }
    e.exp = when
    return int(1)
  }

  function rename(c: Ctx, a: Buffer[], onlyIfNew: boolean): Reply {
    need(a, 2, 'rename')
    const e = live(c.d, k(a[0]!))
    if (!e) throw new Fail('ERR no such key')
    if (onlyIfNew && live(c.d, k(a[1]!))) return int(0)
    c.d.delete(k(a[0]!))
    c.d.set(k(a[1]!), e)
    return onlyIfNew ? int(1) : ok()
  }

  function incr(c: Ctx, key: Buffer, by: number): Reply {
    const e = get(c, key, 'string')
    const next = (e ? integer(e.v) : 0) + by
    put(
      c,
      key,
      { type: 'string', v: Buffer.from(String(next)) },
      e ? live(c.d, k(key))?.exp : undefined,
    )
    return int(next)
  }

  function push(c: Ctx, a: Buffer[], tail: boolean, onlyIfExists: boolean): Reply {
    need(a, 2, 'push')
    let e = get(c, a[0]!, 'list')
    if (!e) {
      if (onlyIfExists) return int(0)
      put(c, a[0]!, (e = { type: 'list', v: [] }))
    }
    for (const v of a.slice(1)) {
      if (tail) e.v.push(Buffer.from(v))
      else e.v.unshift(Buffer.from(v))
    }
    const length = e.v.length
    wake(c.conn.db)
    return int(length)
  }

  function pop(c: Ctx, a: Buffer[], tail: boolean): Reply {
    const e = get(c, a[0] ?? Buffer.alloc(0), 'list')
    if (!e) return a[1] ? array(null) : nil()
    if (a[1]) {
      const n = integer(a[1])
      const out: Buffer[] = []
      while (out.length < n && e.v.length > 0) out.push(tail ? e.v.pop()! : e.v.shift()!)
      emptyCheck(c, a[0]!)
      return bulks(out)
    }
    const v = tail ? e.v.pop()! : e.v.shift()!
    emptyCheck(c, a[0]!)
    return bulk(v)
  }

  function block(c: Ctx, a: Buffer[], tail: boolean): Promise<Reply> {
    need(a, 2, 'blpop')
    const keys = a.slice(0, -1).map(k)
    const timeout = double(a[a.length - 1]!)
    for (const key of keys) {
      const e = live(c.d, key)
      if (e?.type === 'list' && e.v.length > 0) {
        const item = tail ? e.v.pop()! : e.v.shift()!
        emptyCheck(c, bk(key))
        return Promise.resolve(bulks([bk(key), item]))
      }
    }
    return new Promise<Reply>((resolve) => {
      const waiter: Waiter = { conn: c.conn, db: c.conn.db, keys, tail, resolve }
      if (timeout > 0) {
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1)
          resolve(array(null))
        }, timeout * 1000)
      }
      waiters.push(waiter)
    })
  }

  function sortedZset(e: { v: Map<string, number> } | undefined): [string, number][] {
    return [...(e?.v ?? [])].sort(([am, as], [bm, bs]) =>
      as === bs ? (am < bm ? -1 : am > bm ? 1 : 0) : as - bs,
    )
  }

  function zrange(c: Ctx, a: Buffer[], rev: boolean): Reply {
    need(a, 3, 'zrange')
    const sorted = sortedZset(get(c, a[0]!, 'zset'))
    if (rev) sorted.reverse()
    let start = integer(a[1]!)
    let end = integer(a[2]!)
    if (start < 0) start = Math.max(0, sorted.length + start)
    if (end < 0) end = sorted.length + end
    const withScores = a.slice(3).some((x) => up(x) === 'WITHSCORES')
    return bulks(
      sorted
        .slice(start, end + 1)
        .flatMap(([m, s]) => (withScores ? [bk(m), formatDouble(s)] : [bk(m)])),
    )
  }

  function bound(b: Buffer): { v: number; open: boolean } {
    const s = text(b)
    return s.startsWith('(')
      ? { v: double(Buffer.from(s.slice(1))), open: true }
      : { v: double(b), open: false }
  }
  const within = (
    s: number,
    lo: { v: number; open: boolean },
    hi: { v: number; open: boolean },
  ): boolean => (lo.open ? s > lo.v : s >= lo.v) && (hi.open ? s < hi.v : s <= hi.v)

  const entryReply = (x: StreamEntry): Reply => array([bulk(idText(x.ms, x.seq)), bulks(x.fields)])

  function xrange(c: Ctx, a: Buffer[], rev: boolean): Reply {
    need(a, 3, 'xrange')
    const s = get(c, a[0]!, 'stream')?.v
    const edge = (raw: string, isStart: boolean): [bigint, bigint, boolean] => {
      if (raw === '-') return [0n, 0n, false]
      if (raw === '+') return [(1n << 64n) - 1n, (1n << 64n) - 1n, false]
      const exclusive = raw.startsWith('(')
      const [ms, seq] = parseId(exclusive ? raw.slice(1) : raw, isStart ? 0n : (1n << 64n) - 1n)
      return [ms, seq, exclusive]
    }
    const [loRaw, hiRaw] = rev ? [a[2]!, a[1]!] : [a[1]!, a[2]!]
    const lo = edge(text(loRaw), true)
    const hi = edge(text(hiRaw), false)
    let count = Infinity
    if (a[3] && up(a[3]) === 'COUNT') count = integer(a[4] ?? Buffer.alloc(0))
    let list = (s?.entries ?? []).filter((x) => {
      const id: [bigint, bigint] = [x.ms, x.seq]
      const cl = cmpId(id, [lo[0], lo[1]])
      const ch = cmpId(id, [hi[0], hi[1]])
      return (lo[2] ? cl > 0 : cl >= 0) && (hi[2] ? ch < 0 : ch <= 0)
    })
    if (rev) list = [...list].reverse()
    return array(list.slice(0, count).map(entryReply))
  }

  function group(c: Ctx, key: Buffer | undefined, name: Buffer | undefined): Group {
    const s = get(c, key ?? Buffer.alloc(0), 'stream')
    const g = s?.v.groups.get(text(name ?? Buffer.alloc(0)))
    if (!g) {
      throw new Fail(
        `NOGROUP No such key '${text(key ?? Buffer.alloc(0))}' or consumer group '${text(name ?? Buffer.alloc(0))}'`,
      )
    }
    return g
  }

  function serialize(e: Entry): unknown {
    const b = (x: Buffer): string => x.toString('base64')
    switch (e.type) {
      case 'string':
      case 'ReJSON-RL':
        return { type: e.type, v: b(e.v) }
      case 'hash':
        return { type: e.type, v: [...e.v].map(([f, v]) => [bk(f).toString('base64'), b(v)]) }
      case 'list':
        return { type: e.type, v: e.v.map(b) }
      case 'set':
        return { type: e.type, v: [...e.v].map((m) => bk(m).toString('base64')) }
      case 'zset':
        return { type: e.type, v: [...e.v].map(([m, s]) => [bk(m).toString('base64'), s]) }
      case 'stream':
        return {
          type: e.type,
          v: {
            last: [String(e.v.last[0]), String(e.v.last[1])],
            added: e.v.added,
            entries: e.v.entries.map((x) => [String(x.ms), String(x.seq), x.fields.map(b)]),
          },
        }
    }
  }

  // The dump is this file's own format, read back by this file.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function deserialize(raw: any): Entry {
    const bf = (x: string): Buffer => Buffer.from(x, 'base64')
    switch (raw.type) {
      case 'string':
      case 'ReJSON-RL':
        return { type: raw.type, v: bf(raw.v) }
      case 'hash':
        return {
          type: 'hash',
          v: new Map(raw.v.map(([f, v]: [string, string]) => [k(bf(f)), bf(v)])),
        }
      case 'list':
        return { type: 'list', v: raw.v.map(bf) }
      case 'set':
        return { type: 'set', v: new Set(raw.v.map((m: string) => k(bf(m)))) }
      case 'zset':
        return { type: 'zset', v: new Map(raw.v.map(([m, s]: [string, number]) => [k(bf(m)), s])) }
      default:
        return {
          type: 'stream',
          v: {
            entries: raw.v.entries.map(([ms, seq, f]: [string, string, string[]]) => ({
              ms: BigInt(ms),
              seq: BigInt(seq),
              fields: f.map(bf),
            })),
            last: [BigInt(raw.v.last[0]), BigInt(raw.v.last[1])],
            groups: new Map(),
            added: raw.v.added,
          },
        }
    }
  }

  async function run(conn: Conn, args: Buffer[]): Promise<Reply> {
    const name = up(args[0]!)
    const rest = args.slice(1)
    log.push([name, ...rest.map((x) => x.toString('latin1'))])
    commandsRun++
    recent.push(now())
    try {
      const authed = !requirePassword || conn.user !== null
      if (!authed && !['AUTH', 'HELLO', 'QUIT'].includes(name)) {
        return err('NOAUTH Authentication required.')
      }
      if (conn.multi && !['EXEC', 'DISCARD', 'MULTI'].includes(name)) {
        if (!handlers[name]) {
          conn.multi = null
          return err(`ERR unknown command '${name}'`)
        }
        conn.multi.push(args)
        return status('QUEUED')
      }
      if (name === 'EXEC') {
        const queued = conn.multi
        if (!queued) return err('ERR EXEC without MULTI')
        conn.multi = null
        const results: Reply[] = []
        for (const cmd of queued) {
          const h = handlers[up(cmd[0]!)]!
          try {
            results.push(await h({ conn, d: db(conn.db) }, cmd.slice(1)))
          } catch (error) {
            results.push(err(error instanceof Fail ? error.message : String(error)))
          }
        }
        return array(results)
      }
      const handler = handlers[name]
      if (!handler) {
        return err(
          `ERR unknown command '${args[0]!.toString('utf8')}', with args beginning with: ${rest
            .slice(0, 3)
            .map((x) => `'${x.toString('utf8')}'`)
            .join(' ')}`,
        )
      }
      return await handler({ conn, d: db(conn.db) }, rest)
    } catch (error) {
      if (error instanceof Fail) return err(error.message)
      return err(`ERR ${(error as Error).message}`)
    }
  }

  const server = net.createServer((socket) => {
    const conn = new Conn(socket, nextId++, requirePassword ? null : 'default')
    conns.add(conn)
    const parser = new CommandParser()
    socket.on('data', (chunk) => {
      const commands = parser.push(chunk)
      if (commands.length > 0) conn.enqueue(commands, (args) => run(conn, args))
    })
    const gone = (): void => {
      conn.closed = true
      conns.delete(conn)
      for (const waiter of [...waiters]) {
        if (waiter.conn === conn) {
          clearTimeout(waiter.timer)
          waiters.splice(waiters.indexOf(waiter), 1)
        }
      }
    }
    socket.on('close', gone)
    socket.on('error', gone)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as net.AddressInfo

  return {
    host: '127.0.0.1',
    port: address.port,
    seed(index, key, value, ttl) {
      db(index).set(key, {
        type: 'string',
        v: typeof value === 'string' ? Buffer.from(value) : value,
        ...(ttl !== undefined ? { exp: now() + ttl } : {}),
      })
    },
    keys: (index) => [...db(index).keys()],
    clients: () => conns.size,
    advanceTime(ms) {
      skew += ms
    },
    log,
    close: () =>
      new Promise<void>((resolve) => {
        for (const conn of conns) conn.socket.destroy()
        for (const waiter of waiters) clearTimeout(waiter.timer)
        server.close(() => resolve())
      }),
  }
}
