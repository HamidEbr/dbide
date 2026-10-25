/**
 * What DBIDE knows about a Redis server: its keys, what each key holds, and the server's own numbers.
 * Keys and values are the binary-safe strings of `bstring.ts`. Every call is cancellable.
 */

/** Keys the browser asks for at a time. */
export const KEYS_PAGE = 200
/** Hash fields, list items, members or stream entries per page of one key's value. */
export const ELEMENTS_PAGE = 100
/** The most bytes of a string value the window loads. A longer string can be read but not edited here. */
export const STRING_LIMIT = 1_048_576
/** The most keys the navigator reads under one node before it says there are more. */
export const TREE_KEY_LIMIT = 5000
/** What splits a key into a folder tree, unless the connection says otherwise. */
export const DEFAULT_SEPARATOR = ':'

/** `string`, `hash`, `list`, `set`, `zset` and `stream` are Redis's own. Modules add more, such as `ReJSON-RL`. */
export type RedisType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream' | (string & {})

export const CORE_TYPES = ['string', 'hash', 'list', 'set', 'zset', 'stream'] as const
export type CoreType = (typeof CORE_TYPES)[number]
export const isCoreType = (type: string): type is CoreType =>
  (CORE_TYPES as readonly string[]).includes(type)

export interface KeySummary {
  key: string
  type: RedisType
  /** Milliseconds until the key expires, or null when it never does. */
  ttlMs: number | null
}

export interface ScanRequest {
  db: number
  /** A glob pattern. Empty means every key. */
  pattern: string
  type?: RedisType
  /** Where the last page stopped. Null starts over. */
  cursor: string | null
  /** About how many keys to bring back. */
  limit: number
}

export interface ScanPage {
  keys: KeySummary[]
  /** Pass it back to continue. Null when the whole keyspace has been looked at. */
  cursor: string | null
  /** How many keys the server was asked to look at, roughly: SCAN does not say. */
  examined: number
  /** How many keys the database holds, when the server says. */
  total: number | null
}

export interface KeyDetail {
  key: string
  db: number
  /** `none` when the key does not exist. */
  type: RedisType | 'none'
  ttlMs: number | null
  /** How the server stores it: `listpack`, `hashtable`, `embstr`, ... Not every server says. */
  encoding: string | null
  /** Bytes of a string, or entries of anything else. */
  length: number | null
}

export interface HashEntry {
  field: string
  value: string
}
export interface ListEntry {
  index: number
  value: string
}
export interface ZsetEntry {
  member: string
  score: number
}
export interface StreamEntry {
  id: string
  fields: [string, string][]
}

export interface ValueRequest {
  db: number
  key: string
  type: RedisType
  /** Where the last page stopped, as the page said. Null is the first page. */
  cursor: string | null
  count: number
  /** Hash fields and set members: only those matching this glob. */
  match?: string
}

export type ValuePage =
  | { type: 'string'; value: string; bytes: number; truncated: boolean }
  | { type: 'hash'; items: HashEntry[]; next: string | null }
  | { type: 'list'; items: ListEntry[]; next: string | null }
  | { type: 'set'; items: string[]; next: string | null }
  | { type: 'zset'; items: ZsetEntry[]; next: string | null }
  | { type: 'stream'; items: StreamEntry[]; next: string | null }
  /** A value that is JSON text, from the RedisJSON module. Read only. */
  | { type: 'json'; value: string }
  /** A type the app has no editor for. */
  | { type: 'other'; name: string }

export interface StreamGroup {
  name: string
  consumers: number
  pending: number
  lastDeliveredId: string
  lag: number | null
}

export interface StreamInfo {
  length: number
  lastGeneratedId: string
  groups: StreamGroup[]
}

export interface StreamConsumer {
  name: string
  pending: number
  idleMs: number
}

export interface StreamPending {
  id: string
  consumer: string
  idleMs: number
  deliveries: number
}

export interface StreamGroupDetail {
  consumers: StreamConsumer[]
  /** The oldest pending entries. */
  pending: StreamPending[]
  /** How many are pending in all. */
  pendingTotal: number
}

export type NewKey =
  | { type: 'string'; value: string }
  | { type: 'hash'; field: string; value: string }
  | { type: 'list'; value: string }
  | { type: 'set'; member: string }
  | { type: 'zset'; member: string; score: number }
  | { type: 'stream'; fields: [string, string][] }

/** One change to a key. The window never builds a command; the core does, from this. */
export type RedisEdit =
  | { op: 'string.set'; value: string }
  | { op: 'hash.set'; field: string; value: string }
  | { op: 'hash.rename'; field: string; newField: string }
  | { op: 'hash.delete'; fields: string[] }
  | { op: 'list.set'; index: number; value: string }
  | { op: 'list.push'; side: 'head' | 'tail'; values: string[] }
  | { op: 'list.remove'; index: number }
  | { op: 'set.add'; members: string[] }
  | { op: 'set.remove'; members: string[] }
  | { op: 'zset.add'; member: string; score: number }
  | { op: 'zset.remove'; members: string[] }
  | { op: 'stream.add'; id: string | null; fields: [string, string][] }
  | { op: 'stream.delete'; ids: string[] }
  | { op: 'ttl.set'; ttlMs: number }
  | { op: 'ttl.clear' }
  | { op: 'key.create'; value: NewKey }
  | { op: 'key.rename'; newKey: string; overwrite: boolean }
  | { op: 'key.copy'; newKey: string; overwrite: boolean; toDb: number | null }
  | { op: 'key.delete' }

export interface KeyspaceEntry {
  db: number
  keys: number
  expires: number
}

export interface RedisInfo {
  /** `Redis`, `Valkey` or `Dragonfly`: what the server says it is. */
  flavor: string
  version: string
  /** `standalone`, `cluster` or `sentinel`. */
  mode: string
  role: string
  os: string | null
  uptimeSeconds: number
  connectedClients: number
  blockedClients: number
  usedMemory: number
  usedMemoryPeak: number
  /** 0 when the server has no limit. */
  maxMemory: number
  usedMemoryRss: number | null
  fragmentationRatio: number | null
  opsPerSec: number
  totalCommands: number
  keyspaceHits: number
  keyspaceMisses: number
  evictedKeys: number
  expiredKeys: number
  inputKbps: number
  outputKbps: number
  keyspace: KeyspaceEntry[]
  /** How many databases the server has, when it says. */
  databases: number | null
  /** Replication, as `INFO replication` says it. */
  replication: { role: string; connectedReplicas: number; masterHost: string | null }
  /** Every field of every section, for the table beneath the numbers. */
  sections: Record<string, Record<string, string>>
}

export interface CountResult {
  count: number
  /** The search looked at the whole keyspace. */
  complete: boolean
}

export interface DeleteResult {
  deleted: number
  complete: boolean
}

/** What a task such as a count or a bulk delete tells the window while it runs. */
export interface RedisProgress {
  taskId: string
  examined: number
  matched: number
  deleted: number
}

/** A reply to a command typed in the console, kept as the server sent it. */
export type RedisReply =
  | { t: 'status'; text: string }
  | { t: 'error'; text: string }
  | { t: 'int'; value: number }
  /** A string. `bytes` is the real length when `text` was cut short. */
  | { t: 'bulk'; text: string; bytes: number; binary: boolean; truncated: boolean }
  | { t: 'nil' }
  /** `omitted` counts the items left out of a very long list. */
  | { t: 'array'; items: RedisReply[]; omitted: number }

export interface ExecResult {
  reply: RedisReply
  /** The database the console is in after the command. */
  db: number
  ms: number
}

export interface RedisApi {
  info(signal: AbortSignal): Promise<RedisInfo>
  scan(request: ScanRequest, signal: AbortSignal): Promise<ScanPage>
  /** Counts the keys matching a pattern by looking at all of them, a batch at a time. */
  count(
    db: number,
    pattern: string,
    type: RedisType | undefined,
    signal: AbortSignal,
    onProgress: (progress: Omit<RedisProgress, 'taskId'>) => void,
  ): Promise<CountResult>
  key(db: number, key: string, signal: AbortSignal): Promise<KeyDetail>
  value(request: ValueRequest, signal: AbortSignal): Promise<ValuePage>
  /** Bytes each key takes, from MEMORY USAGE. Null for a key that is gone or when the server can't say. */
  memory(db: number, keys: string[], signal: AbortSignal): Promise<(number | null)[]>
  streamInfo(db: number, key: string, signal: AbortSignal): Promise<StreamInfo>
  streamGroup(
    db: number,
    key: string,
    group: string,
    signal: AbortSignal,
  ): Promise<StreamGroupDetail>
  edit(db: number, key: string, edit: RedisEdit, signal: AbortSignal): Promise<void>
  /** Deletes every key matching a pattern, a batch at a time, so the server is never stalled. */
  deleteMatching(
    db: number,
    pattern: string,
    type: RedisType | undefined,
    signal: AbortSignal,
    onProgress: (progress: Omit<RedisProgress, 'taskId'>) => void,
  ): Promise<DeleteResult>
  /** Runs one command, given as the arguments the console tokenized. Replies of every kind come back as data. */
  exec(args: string[], signal: AbortSignal): Promise<ExecResult>
}

/** A pattern as the person typed it, as the glob the server gets: plain text matches anywhere in a key. */
export function toGlob(typed: string): string {
  const text = typed.trim()
  if (text === '') return '*'
  return /[*?[\]]/.test(text) ? text : `*${text}*`
}

/** A glob that matches keys beginning with `prefix`. */
export function prefixGlob(prefix: string): string {
  return `${prefix.replace(/[\\*?[\]]/g, (c) => `\\${c}`)}*`
}

/** A TTL as a few words: `45s`, `3h 20m`, `2d 4h`. */
export function describeTtl(ttlMs: number | null): string {
  if (ttlMs === null) return 'no expiry'
  if (ttlMs < 1000) return `${Math.max(0, Math.round(ttlMs))} ms`
  const seconds = Math.round(ttlMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
}
