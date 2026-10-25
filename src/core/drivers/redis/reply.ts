import { fromBytes, printable } from '@shared/redis/bstring'
import type { RedisReply } from '@shared/redis/types'

/** The longest string the console keeps whole. A longer one comes back cut, with its real length. */
export const REPLY_TEXT_LIMIT = 65_536
const REPLY_ITEMS_LIMIT = 2000
const REPLY_DEPTH_LIMIT = 16

/**
 * Reads what a client returned for a command into data the console can draw. A client that hands back
 * bytes can't say a status reply from a string, so `isStatus` says whether the command's own reply is
 * one (SET answers `OK`), as redis-cli would print it without quotes.
 */
export function toReply(value: unknown, isStatus = false, depth = 0): RedisReply {
  if (value === null || value === undefined) return { t: 'nil' }
  if (typeof value === 'number') return { t: 'int', value }
  if (typeof value === 'bigint') return { t: 'int', value: Number(value) }
  if (value instanceof Error) return { t: 'error', text: value.message }
  if (Buffer.isBuffer(value) || typeof value === 'string') {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
    if (isStatus && depth === 0) return { t: 'status', text: bytes.toString('utf8') }
    const truncated = bytes.length > REPLY_TEXT_LIMIT
    const shown = truncated ? bytes.subarray(0, REPLY_TEXT_LIMIT) : bytes
    const binary = fromBytes(shown)
    const isBin = binary.startsWith('\u0000')
    return {
      t: 'bulk',
      text: isBin ? printable(binary) : binary,
      bytes: bytes.length,
      binary: isBin,
      truncated,
    }
  }
  if (Array.isArray(value)) {
    if (depth >= REPLY_DEPTH_LIMIT) return { t: 'status', text: '…' }
    const items = value.slice(0, REPLY_ITEMS_LIMIT).map((item) => toReply(item, false, depth + 1))
    return { t: 'array', items, omitted: Math.max(0, value.length - REPLY_ITEMS_LIMIT) }
  }
  return { t: 'status', text: String(value) }
}

/** Commands whose own answer is a status line such as `OK`, as opposed to a string. */
const STATUS_COMMANDS = new Set([
  'SET',
  'SETEX',
  'PSETEX',
  'MSET',
  'SELECT',
  'FLUSHALL',
  'FLUSHDB',
  'RENAME',
  'LSET',
  'LTRIM',
  'HMSET',
  'PING',
  'AUTH',
  'MULTI',
  'DISCARD',
  'WATCH',
  'UNWATCH',
  'RESET',
  'TYPE',
  'QUIT',
  'RESTORE',
  'BGSAVE',
  'BGREWRITEAOF',
  'SAVE',
  'READONLY',
  'READWRITE',
  'ASKING',
  'REPLICAOF',
  'SLAVEOF',
  'CLIENT SETNAME',
  'CLIENT SETINFO',
  'CLIENT REPLY',
  'CLIENT PAUSE',
  'CLIENT UNPAUSE',
  'CLIENT TRACKING',
  'CLIENT NO-EVICT',
  'CLIENT NO-TOUCH',
  'XGROUP CREATE',
  'XGROUP SETID',
  'CONFIG SET',
  'CONFIG REWRITE',
  'CONFIG RESETSTAT',
  'SCRIPT FLUSH',
  'SCRIPT KILL',
  'FUNCTION FLUSH',
  'FUNCTION DELETE',
  'FUNCTION RESTORE',
  'FUNCTION KILL',
  'ACL SETUSER',
  'ACL LOAD',
  'ACL SAVE',
  'MEMORY PURGE',
  'JSON.SET',
])

/** Whether a command (`SET`, or `CLIENT SETNAME`) answers with a status line. */
export const answersWithStatus = (name: string, args: string[]): boolean => {
  // SET with GET answers with the old value, not a status.
  if (name === 'SET' && args.some((a) => a.toUpperCase() === 'GET')) return false
  return STATUS_COMMANDS.has(name)
}
