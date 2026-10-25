/**
 * Redis commands as the console and the guard read them: how a line is split into arguments, what each
 * command does to the server, and a short syntax for each so the console can hint at it.
 */

/** Splits a line the way redis-cli does: spaces, "double quotes" with escapes, 'single quotes'. */
export type Tokenized = { ok: true; args: string[] } | { ok: false; error: string }

/**
 * Arguments come back as byte strings: every character is one byte (0 to 255), so `"\xff"` and text in
 * UTF-8 both survive. `argBytes` turns one into the bytes to send.
 */
export function tokenize(line: string): Tokenized {
  const args: string[] = []
  const encoder = new TextEncoder()
  const toByteString = (text: string): string =>
    Array.from(encoder.encode(text), (b) => String.fromCharCode(b)).join('')

  let i = 0
  const n = line.length
  while (i < n) {
    while (i < n && /\s/.test(line[i]!)) i++
    if (i >= n) break
    let token = ''
    const quote = line[i]
    if (quote === '"') {
      i++
      let closed = false
      while (i < n) {
        const c = line[i]!
        if (c === '\\' && i + 1 < n) {
          const next = line[i + 1]!
          if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))) {
            token += String.fromCharCode(parseInt(line.slice(i + 2, i + 4), 16))
            i += 4
            continue
          }
          const escapes: Record<string, string> = {
            n: '\n',
            r: '\r',
            t: '\t',
            b: '\b',
            a: '\u0007',
          }
          token += next in escapes ? escapes[next]! : toByteString(next)
          i += 2
          continue
        }
        if (c === '"') {
          closed = true
          i++
          break
        }
        token += toByteString(c)
        i++
      }
      if (!closed) return { ok: false, error: 'Unbalanced quotes in the command.' }
      if (i < n && !/\s/.test(line[i]!)) {
        return { ok: false, error: 'A closing quote must be followed by a space.' }
      }
    } else if (quote === "'") {
      i++
      let closed = false
      while (i < n) {
        const c = line[i]!
        if (c === '\\' && line[i + 1] === "'") {
          token += "'"
          i += 2
          continue
        }
        if (c === "'") {
          closed = true
          i++
          break
        }
        token += toByteString(c)
        i++
      }
      if (!closed) return { ok: false, error: 'Unbalanced quotes in the command.' }
      if (i < n && !/\s/.test(line[i]!)) {
        return { ok: false, error: 'A closing quote must be followed by a space.' }
      }
    } else {
      while (i < n && !/\s/.test(line[i]!)) {
        token += toByteString(line[i]!)
        i++
      }
    }
    args.push(token)
  }
  return { ok: true, args }
}

/** The bytes of a tokenized argument. */
export const argBytes = (arg: string): Uint8Array => Uint8Array.from(arg, (c) => c.charCodeAt(0))

/** An argument back as text, for showing: bytes that are not valid UTF-8 are kept as they are. */
export function argText(arg: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(argBytes(arg))
  } catch {
    return arg
  }
}

/**
 * What a command does to the server:
 * - `read`: reads data, or only looks at the server.
 * - `write`: changes data.
 * - `admin`: changes how the server behaves, or runs something the app can't see into.
 * - `destructive`: can lose data or take the server down.
 * - `session`: only changes this connection (SELECT, MULTI, ...).
 */
export type CommandKind = 'read' | 'write' | 'admin' | 'destructive' | 'session' | 'unknown'

interface Spec {
  kind: CommandKind
  /** The arguments, in the shape the docs write them. */
  syntax: string
  /** Why it is destructive, said to the person who is about to run it. */
  why?: string
}

const r = (syntax = ''): Spec => ({ kind: 'read', syntax })
const w = (syntax = ''): Spec => ({ kind: 'write', syntax })
const a = (syntax = ''): Spec => ({ kind: 'admin', syntax })
const s = (syntax = ''): Spec => ({ kind: 'session', syntax })
const d = (syntax: string, why: string): Spec => ({ kind: 'destructive', syntax, why })

/** Commands keyed by name in upper case. A command with sub-commands is keyed `NAME SUB`. */
const SPECS: Record<string, Spec> = {
  // Strings
  GET: r('key'),
  GETEX: w('key [EX seconds | PX ms | EXAT ts | PXAT ms-ts | PERSIST]'),
  GETDEL: w('key'),
  GETRANGE: r('key start end'),
  GETSET: w('key value'),
  MGET: r('key [key ...]'),
  STRLEN: r('key'),
  SUBSTR: r('key start end'),
  LCS: r('key1 key2 [LEN] [IDX] [MINMATCHLEN len] [WITHMATCHLEN]'),
  SET: w('key value [NX | XX] [GET] [EX seconds | PX ms | EXAT ts | PXAT ms-ts | KEEPTTL]'),
  SETEX: w('key seconds value'),
  PSETEX: w('key ms value'),
  SETNX: w('key value'),
  SETRANGE: w('key offset value'),
  MSET: w('key value [key value ...]'),
  MSETNX: w('key value [key value ...]'),
  APPEND: w('key value'),
  INCR: w('key'),
  INCRBY: w('key increment'),
  INCRBYFLOAT: w('key increment'),
  DECR: w('key'),
  DECRBY: w('key decrement'),
  // Bits and HyperLogLog
  BITCOUNT: r('key [start end [BYTE | BIT]]'),
  BITPOS: r('key bit [start [end [BYTE | BIT]]]'),
  BITOP: w('AND | OR | XOR | NOT destkey key [key ...]'),
  BITFIELD: w(
    'key [GET type offset] [SET type offset value] [INCRBY type offset increment] [OVERFLOW WRAP | SAT | FAIL]',
  ),
  BITFIELD_RO: r('key GET type offset [GET type offset ...]'),
  GETBIT: r('key offset'),
  SETBIT: w('key offset value'),
  PFADD: w('key [element ...]'),
  PFCOUNT: r('key [key ...]'),
  PFMERGE: w('destkey [sourcekey ...]'),
  // Keys
  DEL: d('key [key ...]', 'DEL removes the keys and what they hold.'),
  UNLINK: d('key [key ...]', 'UNLINK removes the keys and what they hold.'),
  COPY: w('source destination [DB db] [REPLACE]'),
  DUMP: r('key'),
  EXISTS: r('key [key ...]'),
  EXPIRE: w('key seconds [NX | XX | GT | LT]'),
  EXPIREAT: w('key unix-seconds [NX | XX | GT | LT]'),
  EXPIRETIME: r('key'),
  PEXPIRE: w('key ms [NX | XX | GT | LT]'),
  PEXPIREAT: w('key unix-ms [NX | XX | GT | LT]'),
  PEXPIRETIME: r('key'),
  PERSIST: w('key'),
  TTL: r('key'),
  PTTL: r('key'),
  KEYS: r('pattern'),
  SCAN: r('cursor [MATCH pattern] [COUNT count] [TYPE type]'),
  RANDOMKEY: r(),
  RENAME: w('key newkey'),
  RENAMENX: w('key newkey'),
  RESTORE: w('key ttl serialized-value [REPLACE] [ABSTTL] [IDLETIME seconds] [FREQ frequency]'),
  SORT: w(
    'key [BY pattern] [LIMIT offset count] [GET pattern ...] [ASC | DESC] [ALPHA] [STORE destination]',
  ),
  SORT_RO: r('key [BY pattern] [LIMIT offset count] [GET pattern ...] [ASC | DESC] [ALPHA]'),
  TOUCH: r('key [key ...]'),
  TYPE: r('key'),
  WAIT: r('numreplicas timeout'),
  WAITAOF: r('numlocal numreplicas timeout'),
  MOVE: w('key db'),
  MIGRATE: d(
    'host port key|"" destination-db timeout [COPY] [REPLACE] [AUTH password] [KEYS key ...]',
    'MIGRATE moves keys to another server and deletes them here.',
  ),
  'OBJECT ENCODING': r('key'),
  'OBJECT FREQ': r('key'),
  'OBJECT IDLETIME': r('key'),
  'OBJECT REFCOUNT': r('key'),
  'OBJECT HELP': r(),
  // Hashes
  HDEL: w('key field [field ...]'),
  HEXISTS: r('key field'),
  HGET: r('key field'),
  HGETALL: r('key'),
  HINCRBY: w('key field increment'),
  HINCRBYFLOAT: w('key field increment'),
  HKEYS: r('key'),
  HLEN: r('key'),
  HMGET: r('key field [field ...]'),
  HMSET: w('key field value [field value ...]'),
  HRANDFIELD: r('key [count [WITHVALUES]]'),
  HSCAN: r('key cursor [MATCH pattern] [COUNT count] [NOVALUES]'),
  HSET: w('key field value [field value ...]'),
  HSETNX: w('key field value'),
  HSTRLEN: r('key field'),
  HVALS: r('key'),
  HEXPIRE: w('key seconds [NX | XX | GT | LT] FIELDS numfields field [field ...]'),
  HPEXPIRE: w('key ms [NX | XX | GT | LT] FIELDS numfields field [field ...]'),
  HTTL: r('key FIELDS numfields field [field ...]'),
  HPTTL: r('key FIELDS numfields field [field ...]'),
  HPERSIST: w('key FIELDS numfields field [field ...]'),
  // Lists
  BLMOVE: w('source destination LEFT | RIGHT LEFT | RIGHT timeout'),
  BLMPOP: w('timeout numkeys key [key ...] LEFT | RIGHT [COUNT count]'),
  BLPOP: w('key [key ...] timeout'),
  BRPOP: w('key [key ...] timeout'),
  BRPOPLPUSH: w('source destination timeout'),
  LINDEX: r('key index'),
  LINSERT: w('key BEFORE | AFTER pivot element'),
  LLEN: r('key'),
  LMOVE: w('source destination LEFT | RIGHT LEFT | RIGHT'),
  LMPOP: w('numkeys key [key ...] LEFT | RIGHT [COUNT count]'),
  LPOP: w('key [count]'),
  LPOS: r('key element [RANK rank] [COUNT num] [MAXLEN len]'),
  LPUSH: w('key element [element ...]'),
  LPUSHX: w('key element [element ...]'),
  LRANGE: r('key start stop'),
  LREM: w('key count element'),
  LSET: w('key index element'),
  LTRIM: w('key start stop'),
  RPOP: w('key [count]'),
  RPOPLPUSH: w('source destination'),
  RPUSH: w('key element [element ...]'),
  RPUSHX: w('key element [element ...]'),
  // Sets
  SADD: w('key member [member ...]'),
  SCARD: r('key'),
  SDIFF: r('key [key ...]'),
  SDIFFSTORE: w('destination key [key ...]'),
  SINTER: r('key [key ...]'),
  SINTERCARD: r('numkeys key [key ...] [LIMIT limit]'),
  SINTERSTORE: w('destination key [key ...]'),
  SISMEMBER: r('key member'),
  SMEMBERS: r('key'),
  SMISMEMBER: r('key member [member ...]'),
  SMOVE: w('source destination member'),
  SPOP: w('key [count]'),
  SRANDMEMBER: r('key [count]'),
  SREM: w('key member [member ...]'),
  SSCAN: r('key cursor [MATCH pattern] [COUNT count]'),
  SUNION: r('key [key ...]'),
  SUNIONSTORE: w('destination key [key ...]'),
  // Sorted sets
  BZMPOP: w('timeout numkeys key [key ...] MIN | MAX [COUNT count]'),
  BZPOPMAX: w('key [key ...] timeout'),
  BZPOPMIN: w('key [key ...] timeout'),
  ZADD: w('key [NX | XX] [GT | LT] [CH] [INCR] score member [score member ...]'),
  ZCARD: r('key'),
  ZCOUNT: r('key min max'),
  ZDIFF: r('numkeys key [key ...] [WITHSCORES]'),
  ZDIFFSTORE: w('destination numkeys key [key ...]'),
  ZINCRBY: w('key increment member'),
  ZINTER: r('numkeys key [key ...] [WEIGHTS weight ...] [AGGREGATE SUM | MIN | MAX] [WITHSCORES]'),
  ZINTERCARD: r('numkeys key [key ...] [LIMIT limit]'),
  ZINTERSTORE: w(
    'destination numkeys key [key ...] [WEIGHTS weight ...] [AGGREGATE SUM | MIN | MAX]',
  ),
  ZLEXCOUNT: r('key min max'),
  ZMPOP: w('numkeys key [key ...] MIN | MAX [COUNT count]'),
  ZMSCORE: r('key member [member ...]'),
  ZPOPMAX: w('key [count]'),
  ZPOPMIN: w('key [count]'),
  ZRANDMEMBER: r('key [count [WITHSCORES]]'),
  ZRANGE: r('key start stop [BYSCORE | BYLEX] [REV] [LIMIT offset count] [WITHSCORES]'),
  ZRANGEBYLEX: r('key min max [LIMIT offset count]'),
  ZRANGEBYSCORE: r('key min max [WITHSCORES] [LIMIT offset count]'),
  ZRANGESTORE: w('dst src min max [BYSCORE | BYLEX] [REV] [LIMIT offset count]'),
  ZRANK: r('key member [WITHSCORE]'),
  ZREM: w('key member [member ...]'),
  ZREMRANGEBYLEX: w('key min max'),
  ZREMRANGEBYRANK: w('key start stop'),
  ZREMRANGEBYSCORE: w('key min max'),
  ZREVRANGE: r('key start stop [WITHSCORES]'),
  ZREVRANGEBYLEX: r('key max min [LIMIT offset count]'),
  ZREVRANGEBYSCORE: r('key max min [WITHSCORES] [LIMIT offset count]'),
  ZREVRANK: r('key member [WITHSCORE]'),
  ZSCAN: r('key cursor [MATCH pattern] [COUNT count]'),
  ZSCORE: r('key member'),
  ZUNION: r('numkeys key [key ...] [WEIGHTS weight ...] [AGGREGATE SUM | MIN | MAX] [WITHSCORES]'),
  ZUNIONSTORE: w(
    'destination numkeys key [key ...] [WEIGHTS weight ...] [AGGREGATE SUM | MIN | MAX]',
  ),
  // Geo
  GEOADD: w('key [NX | XX] [CH] longitude latitude member [longitude latitude member ...]'),
  GEODIST: r('key member1 member2 [M | KM | FT | MI]'),
  GEOHASH: r('key member [member ...]'),
  GEOPOS: r('key member [member ...]'),
  GEORADIUS: w(
    'key longitude latitude radius M | KM | FT | MI [WITHCOORD] [WITHDIST] [COUNT count] [STORE key]',
  ),
  GEORADIUS_RO: r(
    'key longitude latitude radius M | KM | FT | MI [WITHCOORD] [WITHDIST] [COUNT count]',
  ),
  GEORADIUSBYMEMBER: w(
    'key member radius M | KM | FT | MI [WITHCOORD] [WITHDIST] [COUNT count] [STORE key]',
  ),
  GEORADIUSBYMEMBER_RO: r(
    'key member radius M | KM | FT | MI [WITHCOORD] [WITHDIST] [COUNT count]',
  ),
  GEOSEARCH: r(
    'key FROMMEMBER member | FROMLONLAT lon lat BYRADIUS radius unit | BYBOX width height unit [ASC | DESC] [COUNT count] [WITHCOORD] [WITHDIST]',
  ),
  GEOSEARCHSTORE: w(
    'destination source FROMMEMBER member | FROMLONLAT lon lat BYRADIUS radius unit | BYBOX width height unit [COUNT count] [STOREDIST]',
  ),
  // Streams
  XACK: w('key group id [id ...]'),
  XADD: w(
    'key [NOMKSTREAM] [MAXLEN | MINID [= | ~] threshold] * | id field value [field value ...]',
  ),
  XAUTOCLAIM: w('key group consumer min-idle-time start [COUNT count] [JUSTID]'),
  XCLAIM: w('key group consumer min-idle-time id [id ...] [IDLE ms] [JUSTID]'),
  XDEL: w('key id [id ...]'),
  'XGROUP CREATE': w('key group id | $ [MKSTREAM] [ENTRIESREAD n]'),
  'XGROUP CREATECONSUMER': w('key group consumer'),
  'XGROUP DELCONSUMER': w('key group consumer'),
  'XGROUP DESTROY': d('key group', 'XGROUP DESTROY drops the group and everything pending in it.'),
  'XGROUP SETID': w('key group id | $ [ENTRIESREAD n]'),
  'XINFO CONSUMERS': r('key group'),
  'XINFO GROUPS': r('key'),
  'XINFO STREAM': r('key [FULL [COUNT count]]'),
  XLEN: r('key'),
  XPENDING: r('key group [[IDLE min-idle-time] start end count [consumer]]'),
  XRANGE: r('key start end [COUNT count]'),
  XREAD: r('[COUNT count] [BLOCK ms] STREAMS key [key ...] id [id ...]'),
  XREADGROUP: w(
    'GROUP group consumer [COUNT count] [BLOCK ms] [NOACK] STREAMS key [key ...] id [id ...]',
  ),
  XREVRANGE: r('key end start [COUNT count]'),
  XSETID: w('key last-id [ENTRIESADDED n] [MAXDELETEDID id]'),
  XTRIM: w('key MAXLEN | MINID [= | ~] threshold [LIMIT count]'),
  // Scripting and functions: what they do depends on the script, so they count as changes.
  EVAL: a('script numkeys [key ...] [arg ...]'),
  EVALSHA: a('sha1 numkeys [key ...] [arg ...]'),
  EVAL_RO: r('script numkeys [key ...] [arg ...]'),
  EVALSHA_RO: r('sha1 numkeys [key ...] [arg ...]'),
  FCALL: a('function numkeys [key ...] [arg ...]'),
  FCALL_RO: r('function numkeys [key ...] [arg ...]'),
  'SCRIPT EXISTS': r('sha1 [sha1 ...]'),
  'SCRIPT LOAD': a('script'),
  'SCRIPT FLUSH': a('[ASYNC | SYNC]'),
  'SCRIPT KILL': a(),
  'FUNCTION LIST': r('[LIBRARYNAME pattern] [WITHCODE]'),
  'FUNCTION STATS': r(),
  'FUNCTION DUMP': r(),
  'FUNCTION LOAD': a('[REPLACE] function-code'),
  'FUNCTION DELETE': d('library-name', 'FUNCTION DELETE removes the library and its functions.'),
  'FUNCTION FLUSH': d('[ASYNC | SYNC]', 'FUNCTION FLUSH removes every library.'),
  'FUNCTION KILL': a(),
  'FUNCTION RESTORE': a('serialized-value [FLUSH | APPEND | REPLACE]'),
  // Transactions
  MULTI: s(),
  EXEC: s(),
  DISCARD: s(),
  WATCH: s('key [key ...]'),
  UNWATCH: s(),
  // Connection
  AUTH: s('[username] password'),
  ECHO: s('message'),
  HELLO: s('[protover [AUTH username password] [SETNAME clientname]]'),
  PING: s('[message]'),
  QUIT: s(),
  RESET: s(),
  SELECT: s('index'),
  READONLY: s(),
  READWRITE: s(),
  'CLIENT ID': r(),
  'CLIENT INFO': r(),
  'CLIENT LIST': r('[TYPE normal | master | replica | pubsub] [ID id ...]'),
  'CLIENT GETNAME': r(),
  'CLIENT SETNAME': s('connection-name'),
  'CLIENT SETINFO': s('LIB-NAME | LIB-VER value'),
  'CLIENT GETREDIR': r(),
  'CLIENT TRACKINGINFO': r(),
  'CLIENT NO-EVICT': s('ON | OFF'),
  'CLIENT NO-TOUCH': s('ON | OFF'),
  'CLIENT REPLY': s('ON | OFF | SKIP'),
  'CLIENT KILL': a('ip:port | [ID id] [TYPE type] [ADDR ip:port] [SKIPME yes | no]'),
  'CLIENT PAUSE': a('timeout [WRITE | ALL]'),
  'CLIENT UNPAUSE': a(),
  'CLIENT UNBLOCK': a('client-id [TIMEOUT | ERROR]'),
  'CLIENT TRACKING': s(
    'ON | OFF [REDIRECT client-id] [PREFIX prefix ...] [BCAST] [OPTIN] [OPTOUT] [NOLOOP]',
  ),
  'CLIENT CACHING': s('YES | NO'),
  // Server
  DBSIZE: r(),
  FLUSHALL: d('[ASYNC | SYNC]', 'FLUSHALL deletes every key in every database.'),
  FLUSHDB: d('[ASYNC | SYNC]', 'FLUSHDB deletes every key in the current database.'),
  INFO: r('[section ...]'),
  LASTSAVE: r(),
  TIME: r(),
  ROLE: r(),
  LOLWUT: r('[VERSION version]'),
  BGREWRITEAOF: a(),
  BGSAVE: a('[SCHEDULE]'),
  SAVE: a(),
  SHUTDOWN: d('[NOSAVE | SAVE] [NOW] [FORCE]', 'SHUTDOWN stops the server.'),
  SWAPDB: d('index1 index2', 'SWAPDB makes each database hold the other’s keys.'),
  REPLICAOF: d(
    'host port | NO ONE',
    'REPLICAOF makes this server copy another one, and discards what it holds now.',
  ),
  SLAVEOF: d(
    'host port | NO ONE',
    'SLAVEOF makes this server copy another one, and discards what it holds now.',
  ),
  FAILOVER: a('[TO host port [FORCE]] [ABORT] [TIMEOUT ms]'),
  DEBUG: d('subcommand [argument ...]', 'DEBUG can crash the server or change how it works.'),
  MONITOR: a(),
  SYNC: a(),
  PSYNC: a('replicationid offset'),
  'CONFIG GET': r('parameter [parameter ...]'),
  'CONFIG SET': a('parameter value [parameter value ...]'),
  'CONFIG REWRITE': a(),
  'CONFIG RESETSTAT': a(),
  COMMAND: r(),
  'COMMAND COUNT': r(),
  'COMMAND DOCS': r('[command-name ...]'),
  'COMMAND GETKEYS': r('command [arg ...]'),
  'COMMAND INFO': r('[command-name ...]'),
  'COMMAND LIST': r('[FILTERBY MODULE name | ACLCAT category | PATTERN pattern]'),
  'LATENCY DOCTOR': r(),
  'LATENCY GRAPH': r('event'),
  'LATENCY HISTORY': r('event'),
  'LATENCY LATEST': r(),
  'LATENCY RESET': a('[event ...]'),
  'MEMORY DOCTOR': r(),
  'MEMORY MALLOC-STATS': r(),
  'MEMORY PURGE': a(),
  'MEMORY STATS': r(),
  'MEMORY USAGE': r('key [SAMPLES count]'),
  'MODULE LIST': r(),
  'MODULE LOAD': d('path [arg ...]', 'MODULE LOAD runs native code inside the server.'),
  'MODULE LOADEX': d(
    'path [CONFIG name value ...] [ARGS arg ...]',
    'MODULE LOADEX runs native code inside the server.',
  ),
  'MODULE UNLOAD': d('name', 'MODULE UNLOAD removes a module and what depends on it.'),
  'SLOWLOG GET': r('[count]'),
  'SLOWLOG LEN': r(),
  'SLOWLOG RESET': a(),
  'ACL CAT': r('[category]'),
  'ACL DRYRUN': r('username command [arg ...]'),
  'ACL GENPASS': r('[bits]'),
  'ACL GETUSER': r('username'),
  'ACL LIST': r(),
  'ACL LOG': r('[count | RESET]'),
  'ACL USERS': r(),
  'ACL WHOAMI': r(),
  'ACL LOAD': a(),
  'ACL SAVE': a(),
  'ACL SETUSER': a('username [rule ...]'),
  'ACL DELUSER': d(
    'username [username ...]',
    'ACL DELUSER removes users, and closes their connections.',
  ),
  // Pub/Sub
  PUBLISH: w('channel message'),
  SPUBLISH: w('shardchannel message'),
  SUBSCRIBE: r('channel [channel ...]'),
  PSUBSCRIBE: r('pattern [pattern ...]'),
  SSUBSCRIBE: r('shardchannel [shardchannel ...]'),
  UNSUBSCRIBE: r('[channel ...]'),
  PUNSUBSCRIBE: r('[pattern ...]'),
  SUNSUBSCRIBE: r('[shardchannel ...]'),
  'PUBSUB CHANNELS': r('[pattern]'),
  'PUBSUB NUMPAT': r(),
  'PUBSUB NUMSUB': r('[channel ...]'),
  'PUBSUB SHARDCHANNELS': r('[pattern]'),
  'PUBSUB SHARDNUMSUB': r('[shardchannel ...]'),
  // Cluster
  'CLUSTER INFO': r(),
  'CLUSTER NODES': r(),
  'CLUSTER MYID': r(),
  'CLUSTER SHARDS': r(),
  'CLUSTER SLOTS': r(),
  'CLUSTER KEYSLOT': r('key'),
  'CLUSTER COUNTKEYSINSLOT': r('slot'),
  'CLUSTER GETKEYSINSLOT': r('slot count'),
  'CLUSTER LINKS': r(),
  'CLUSTER REPLICAS': r('node-id'),
  'CLUSTER MYSHARDID': r(),
  'CLUSTER COUNT-FAILURE-REPORTS': r('node-id'),
  'CLUSTER FAILOVER': a('[FORCE | TAKEOVER]'),
  'CLUSTER MEET': a('ip port'),
  'CLUSTER FORGET': a('node-id'),
  'CLUSTER REPLICATE': a('node-id'),
  'CLUSTER RESET': d(
    '[HARD | SOFT]',
    'CLUSTER RESET empties the node and makes it forget the cluster.',
  ),
  'CLUSTER ADDSLOTS': a('slot [slot ...]'),
  'CLUSTER DELSLOTS': a('slot [slot ...]'),
  'CLUSTER SETSLOT': a('slot IMPORTING | MIGRATING | STABLE | NODE node-id'),
  'CLUSTER FLUSHSLOTS': d('', 'CLUSTER FLUSHSLOTS unassigns every slot of the node.'),
  ASKING: s(),
  // RedisJSON, the module most servers add
  'JSON.GET': r('key [path ...]'),
  'JSON.MGET': r('key [key ...] path'),
  'JSON.TYPE': r('key [path]'),
  'JSON.OBJKEYS': r('key [path]'),
  'JSON.OBJLEN': r('key [path]'),
  'JSON.ARRLEN': r('key [path]'),
  'JSON.STRLEN': r('key [path]'),
  'JSON.SET': w('key path value [NX | XX]'),
  'JSON.DEL': w('key [path]'),
  'JSON.MERGE': w('key path value'),
  'JSON.NUMINCRBY': w('key path value'),
  'JSON.ARRAPPEND': w('key path value [value ...]'),
  'JSON.TOGGLE': w('key path'),
}

/** Words that open a command with sub-commands, so `CONFIG GET` is looked up as two words. */
const CONTAINERS = new Set(
  Object.keys(SPECS)
    .filter((name) => name.includes(' '))
    .map((name) => name.split(' ')[0]!),
)

export interface CommandInfo {
  /** The command, in upper case, with its sub-command when it has one: `CONFIG GET`. */
  name: string
  kind: CommandKind
  syntax: string
  why?: string
}

/** The command a tokenized line runs. A word the app doesn't know is `unknown`: it counts as a change. */
export function describeCommand(args: string[]): CommandInfo {
  const first = (args[0] ?? '').toUpperCase()
  if (CONTAINERS.has(first) && args.length > 1) {
    const full = `${first} ${args[1]!.toUpperCase()}`
    const spec = SPECS[full]
    if (spec) return { name: full, ...spec }
    // A sub-command the table doesn't have: the container's own entry, or nothing known.
    const container = SPECS[first]
    return container ? { name: first, ...container } : { name: full, kind: 'unknown', syntax: '' }
  }
  const spec = SPECS[first]
  return spec ? { name: first, ...spec } : { name: first, kind: 'unknown', syntax: '' }
}

/** Whether a command may run on a connection whose changes are locked. */
export const isReadSafe = (kind: CommandKind): boolean => kind === 'read' || kind === 'session'

/** Commands the console does not run: they turn the connection into a stream. */
const STREAMING = new Set(['SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'MONITOR', 'SYNC', 'PSYNC'])

export const isStreamingCommand = (name: string): boolean => STREAMING.has(name.split(' ')[0]!)

/** Command names for the console to complete, with the syntax to show beside each. */
export function commandCatalog(): { name: string; syntax: string; kind: CommandKind }[] {
  return Object.entries(SPECS)
    .filter(([name]) => !STREAMING.has(name) && !/^[PS]?UNSUBSCRIBE$/.test(name))
    .map(([name, spec]) => ({ name, syntax: spec.syntax, kind: spec.kind }))
    .sort((x, y) => x.name.localeCompare(y.name))
}

export interface RedisGuardInfo {
  kind: CommandKind
  destructive: boolean
  reason?: string
  name: string
}

/** What the guard needs to know about one line of the console. */
export function classifyRedis(line: string): RedisGuardInfo {
  const parsed = tokenize(line)
  if (!parsed.ok || parsed.args.length === 0) {
    return { kind: 'unknown', destructive: false, name: '' }
  }
  const info = describeCommand(parsed.args)
  return {
    kind: info.kind,
    destructive: info.kind === 'destructive',
    ...(info.why ? { reason: info.why } : {}),
    name: info.name,
  }
}
