import {
  CORE_TYPES,
  ELEMENTS_PAGE,
  KEYS_PAGE,
  type NewKey,
  type RedisEdit,
  type RedisType,
} from '@shared/redis/types'
import { RpcError } from '@shared/rpc'

/**
 * What crosses the process boundary for Redis is untrusted, so every call is checked here before it
 * reaches the server. Keys and values are the binary-safe strings of `bstring.ts`, so they are only
 * checked for being text and for size.
 */

function invalid(message: string): never {
  throw new RpcError('INVALID_INPUT', message)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const MAX_KEY_CHARS = 1_000_000
const MAX_VALUE_CHARS = 16 * 1024 * 1024
const MAX_PATTERN_CHARS = 10_000
const MAX_LINE_CHARS = 16 * 1024 * 1024
const MAX_ITEMS = 1000
const MAX_MEMORY_KEYS = 500
const MAX_DB = 65_535

function text(
  value: unknown,
  field: string,
  options: { empty?: boolean; max?: number } = {},
): string {
  if (typeof value !== 'string') invalid(`${field} must be text`)
  if (!options.empty && value === '') invalid(`${field} is required`)
  if (value.length > (options.max ?? MAX_KEY_CHARS)) invalid(`${field} is too long`)
  return value
}

function whole(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    invalid(`${field} must be a whole number from ${min} to ${max}`)
  }
  return value
}

function finite(value: unknown, field: string, allowInfinity = false): number {
  if (
    typeof value !== 'number' ||
    Number.isNaN(value) ||
    (!allowInfinity && !Number.isFinite(value))
  ) {
    invalid(`${field} must be a number`)
  }
  return value
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(`${field} must be true or false`)
  return value
}

function type(value: unknown, field = 'type'): RedisType {
  const t = text(value, field, { max: 100 })
  return t
}

function optionalType(value: unknown): RedisType | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return type(value)
}

export interface RedisTarget {
  connectionId: string
  db: number
}

export function validateRedisTarget(input: unknown): RedisTarget {
  if (!isRecord(input)) invalid('Name a connection and a database')
  return {
    connectionId: text(input.connectionId, 'connectionId', { max: 200 }),
    db: whole(input.db, 'db', 0, MAX_DB),
  }
}

export function validateRedisKey(input: unknown): RedisTarget & { key: string } {
  const target = validateRedisTarget(input)
  return { ...target, key: text((input as Record<string, unknown>).key, 'key') }
}

export function validateScan(input: unknown) {
  const target = validateRedisTarget(input)
  const body = input as Record<string, unknown>
  const cursor = body.cursor
  if (cursor !== null && cursor !== undefined && typeof cursor !== 'string') {
    invalid('cursor must be text')
  }
  const filter = optionalType(body.type)
  return {
    ...target,
    pattern: text(body.pattern ?? '', 'pattern', { empty: true, max: MAX_PATTERN_CHARS }),
    ...(filter ? { type: filter } : {}),
    cursor: typeof cursor === 'string' ? cursor : null,
    limit: whole(body.limit ?? KEYS_PAGE, 'limit', 1, 5000),
  }
}

export function validateValueRequest(input: unknown) {
  const { connectionId, db, key } = validateRedisKey(input)
  const body = input as Record<string, unknown>
  const cursor = body.cursor
  if (cursor !== null && cursor !== undefined && typeof cursor !== 'string') {
    invalid('cursor must be text')
  }
  const match = body.match
  return {
    connectionId,
    request: {
      db,
      key,
      type: type(body.type),
      cursor: typeof cursor === 'string' ? cursor : null,
      count: whole(body.count ?? ELEMENTS_PAGE, 'count', 1, 1000),
      ...(typeof match === 'string' && match !== ''
        ? { match: text(match, 'match', { max: MAX_PATTERN_CHARS }) }
        : {}),
    },
  }
}

export function validateMemory(input: unknown): RedisTarget & { keys: string[] } {
  const target = validateRedisTarget(input)
  const keys = (input as Record<string, unknown>).keys
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_MEMORY_KEYS) {
    invalid(`Name between 1 and ${MAX_MEMORY_KEYS} keys`)
  }
  return { ...target, keys: keys.map((k) => text(k, 'key')) }
}

export function validateStreamGroup(input: unknown): RedisTarget & { key: string; group: string } {
  const base = validateRedisKey(input)
  return {
    ...base,
    group: text((input as Record<string, unknown>).group, 'group', { max: 10_000 }),
  }
}

export function validateTask(input: unknown) {
  const target = validateRedisTarget(input)
  const body = input as Record<string, unknown>
  const filter = optionalType(body.type)
  return {
    ...target,
    pattern: text(body.pattern ?? '', 'pattern', { empty: true, max: MAX_PATTERN_CHARS }),
    ...(filter ? { type: filter } : {}),
    taskId: text(body.taskId, 'taskId', { max: 200 }),
    writable: body.writable === undefined ? false : bool(body.writable, 'writable'),
  }
}

export function validateWritable(input: unknown): boolean {
  if (!isRecord(input)) invalid('Say whether writes are unlocked')
  return bool(input.writable, 'writable')
}

function items(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) {
    invalid(`${field} must list between 1 and ${MAX_ITEMS} items`)
  }
  return value.map((v) => text(v, field, { empty: true, max: MAX_VALUE_CHARS }))
}

function fieldPairs(value: unknown): [string, string][] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) {
    invalid(`fields must list between 1 and ${MAX_ITEMS} pairs`)
  }
  return value.map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2) invalid('Each field is a name and a value')
    return [
      text(pair[0], 'field name'),
      text(pair[1], 'field value', { empty: true, max: MAX_VALUE_CHARS }),
    ] as [string, string]
  })
}

const STREAM_ID = /^\d+(-\d+)?$/

function validateNewKey(input: unknown): NewKey {
  if (!isRecord(input)) invalid('Say what the new key holds')
  const t = text(input.type, 'type', { max: 20 })
  const value = (field: string): string =>
    text(input[field], field, { empty: true, max: MAX_VALUE_CHARS })
  switch (t) {
    case 'string':
      return { type: 'string', value: value('value') }
    case 'hash':
      return { type: 'hash', field: text(input.field, 'field'), value: value('value') }
    case 'list':
      return { type: 'list', value: value('value') }
    case 'set':
      return { type: 'set', member: value('member') }
    case 'zset':
      return {
        type: 'zset',
        member: value('member'),
        score: finite(input.score, 'score', true),
      }
    case 'stream':
      return { type: 'stream', fields: fieldPairs(input.fields) }
    default:
      return invalid(`A new key can be a ${CORE_TYPES.join(', ')}`)
  }
}

export function validateEdit(input: unknown): RedisEdit {
  if (!isRecord(input)) invalid('Say what to change')
  const op = text(input.op, 'op', { max: 40 })
  const value = (field = 'value'): string =>
    text(input[field], field, { empty: true, max: MAX_VALUE_CHARS })
  switch (op) {
    case 'string.set':
      return { op, value: value() }
    case 'hash.set':
      return { op, field: text(input.field, 'field'), value: value() }
    case 'hash.rename':
      return { op, field: text(input.field, 'field'), newField: text(input.newField, 'newField') }
    case 'hash.delete':
      return { op, fields: items(input.fields, 'fields') }
    case 'list.set':
      return { op, index: whole(input.index, 'index', 0, 2 ** 31), value: value() }
    case 'list.push': {
      if (input.side !== 'head' && input.side !== 'tail') invalid('Push to the head or the tail')
      return { op, side: input.side, values: items(input.values, 'values') }
    }
    case 'list.remove':
      return { op, index: whole(input.index, 'index', 0, 2 ** 31) }
    case 'set.add':
      return { op, members: items(input.members, 'members') }
    case 'set.remove':
      return { op, members: items(input.members, 'members') }
    case 'zset.add':
      return { op, member: value('member'), score: finite(input.score, 'score', true) }
    case 'zset.remove':
      return { op, members: items(input.members, 'members') }
    case 'stream.add': {
      const id = input.id
      if (id !== null && id !== undefined) {
        const s = text(id, 'id', { max: 50 })
        if (!STREAM_ID.test(s) && !/^\d+-\*$/.test(s))
          invalid('A stream id looks like 1700000000000-0')
        return { op, id: s, fields: fieldPairs(input.fields) }
      }
      return { op, id: null, fields: fieldPairs(input.fields) }
    }
    case 'stream.delete': {
      const ids = items(input.ids, 'ids')
      if (!ids.every((id) => STREAM_ID.test(id))) invalid('A stream id looks like 1700000000000-0')
      return { op, ids }
    }
    case 'ttl.set':
      return { op, ttlMs: whole(input.ttlMs, 'ttlMs', 1, 2 ** 53 - 1) }
    case 'ttl.clear':
      return { op }
    case 'key.create':
      return { op, value: validateNewKey(input.value) }
    case 'key.rename':
      return {
        op,
        newKey: text(input.newKey, 'newKey'),
        overwrite: bool(input.overwrite, 'overwrite'),
      }
    case 'key.copy': {
      const toDb = input.toDb
      return {
        op,
        newKey: text(input.newKey, 'newKey'),
        overwrite: bool(input.overwrite, 'overwrite'),
        toDb: toDb === null || toDb === undefined ? null : whole(toDb, 'toDb', 0, MAX_DB),
      }
    }
    case 'key.delete':
      return { op }
    default:
      return invalid(`Unknown change “${op}”`)
  }
}

export function validateExec(input: unknown): {
  connectionId: string
  consoleId: string
  writable: boolean
  line: string
} {
  if (!isRecord(input)) invalid('Name a connection and a command')
  return {
    connectionId: text(input.connectionId, 'connectionId', { max: 200 }),
    consoleId: text(input.consoleId, 'consoleId', { max: 200 }),
    writable: bool(input.writable, 'writable'),
    line: text(input.line, 'line', { max: MAX_LINE_CHARS }),
  }
}

export function validateConsoleId(input: unknown): string {
  if (!isRecord(input)) invalid('Name a console')
  return text(input.consoleId, 'consoleId', { max: 200 })
}
