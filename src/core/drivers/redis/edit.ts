import { randomUUID } from 'node:crypto'
import type { NewKey, RedisEdit } from '@shared/redis/types'
import type { RedisConnection } from './client'
import { K, pipeline, send, str, transaction } from './calls'
import { RedisFailure, isUnsupported } from './errors'

const notFound = (): RedisFailure => new RedisFailure('That key no longer exists.', 'NOT_FOUND')
const exists = (): RedisFailure =>
  new RedisFailure('A key with that name already exists.', 'EXISTS')

/** A score as Redis writes it. */
const scoreText = (score: number): string =>
  score === Infinity ? 'inf' : score === -Infinity ? '-inf' : String(score)

async function delKey(client: ReturnType<RedisConnection['client']>, key: Buffer): Promise<number> {
  try {
    return Number(await send(client, 'UNLINK', key))
  } catch (error) {
    // Servers before 4.0 only have DEL.
    if (!isUnsupported(error)) throw error
    return Number(await send(client, 'DEL', key))
  }
}

/** Changes a key. The command is built here from a typed edit; the window never sends one. */
export async function applyEdit(
  conn: RedisConnection,
  db: number,
  key: string,
  edit: RedisEdit,
): Promise<void> {
  const client = conn.client(db)
  const k = K(key)

  switch (edit.op) {
    case 'string.set': {
      // SET replaces a key of any type, so a hash or list is never overwritten from here by mistake.
      const type = str(await send(client, 'TYPE', k))
      if (type !== 'string' && type !== 'none') {
        throw new RedisFailure(
          `That key holds a ${type}, not a string, so it can’t be set to a string value.`,
          'WRONG_TYPE',
        )
      }
      try {
        await send(client, 'SET', k, K(edit.value), 'KEEPTTL')
      } catch (error) {
        if (!isUnsupported(error)) throw error
        // Before 6.0 SET drops the TTL, so it is put back.
        const ttl = Number(await send(client, 'PTTL', k))
        await transaction(client, [
          ['SET', k, K(edit.value)],
          ...(ttl > 0 ? [['PEXPIRE', k, ttl]] : []),
        ])
      }
      return
    }

    case 'hash.set':
      try {
        await send(client, 'HSET', k, K(edit.field), K(edit.value))
      } catch (error) {
        if (!isUnsupported(error)) throw error
        await send(client, 'HMSET', k, K(edit.field), K(edit.value))
      }
      return

    case 'hash.rename': {
      const [current, taken] = await pipeline(client, [
        ['HGET', k, K(edit.field)],
        ['HEXISTS', k, K(edit.newField)],
      ])
      if (current?.[0]) throw current[0]
      if (current?.[1] == null) {
        throw new RedisFailure('That field no longer exists.', 'NOT_FOUND')
      }
      if (Number(taken?.[1]) === 1 && edit.field !== edit.newField) {
        throw new RedisFailure('A field with that name already exists.', 'EXISTS')
      }
      await transaction(client, [
        ['HSET', k, K(edit.newField), current[1] as Buffer],
        ...(edit.field !== edit.newField ? [['HDEL', k, K(edit.field)]] : []),
      ])
      return
    }

    case 'hash.delete':
      await send(client, 'HDEL', k, ...edit.fields.map(K))
      return

    case 'list.set':
      await send(client, 'LSET', k, edit.index, K(edit.value))
      return

    case 'list.push':
      await send(client, edit.side === 'head' ? 'LPUSH' : 'RPUSH', k, ...edit.values.map(K))
      return

    case 'list.remove': {
      // A list has no delete-at-index: the item is overwritten with a marker no one else uses, then that is removed.
      const marker = Buffer.from(`__dbide_remove_${randomUUID()}__`)
      await transaction(client, [
        ['LSET', k, edit.index, marker],
        ['LREM', k, 1, marker],
      ])
      return
    }

    case 'set.add':
      await send(client, 'SADD', k, ...edit.members.map(K))
      return

    case 'set.remove':
      await send(client, 'SREM', k, ...edit.members.map(K))
      return

    case 'zset.add':
      await send(client, 'ZADD', k, scoreText(edit.score), K(edit.member))
      return

    case 'zset.remove':
      await send(client, 'ZREM', k, ...edit.members.map(K))
      return

    case 'stream.add':
      await send(
        client,
        'XADD',
        k,
        edit.id ?? '*',
        ...edit.fields.flatMap(([field, value]) => [K(field), K(value)]),
      )
      return

    case 'stream.delete':
      await send(client, 'XDEL', k, ...edit.ids)
      return

    case 'ttl.set': {
      const changed = Number(await send(client, 'PEXPIRE', k, Math.max(1, Math.round(edit.ttlMs))))
      if (changed === 0) throw notFound()
      return
    }

    case 'ttl.clear': {
      const exists = Number(await send(client, 'EXISTS', k))
      if (exists === 0) throw notFound()
      await send(client, 'PERSIST', k)
      return
    }

    case 'key.create':
      await createKey(client, k, edit.value)
      return

    case 'key.rename': {
      const target = K(edit.newKey)
      if (edit.overwrite) {
        await send(client, 'RENAME', k, target)
        return
      }
      if (Number(await send(client, 'EXISTS', k)) === 0) throw notFound()
      if (Number(await send(client, 'RENAMENX', k, target)) === 0) throw exists()
      return
    }

    case 'key.copy':
      await copyKey(conn, db, key, edit)
      return

    case 'key.delete':
      await delKey(client, k)
      return
  }
}

async function createKey(
  client: ReturnType<RedisConnection['client']>,
  k: Buffer,
  value: NewKey,
): Promise<void> {
  if (value.type === 'string') {
    const reply = await send(client, 'SET', k, K(value.value), 'NX')
    if (reply === null) throw exists()
    return
  }
  if (Number(await send(client, 'EXISTS', k)) === 1) throw exists()
  switch (value.type) {
    case 'hash':
      await send(client, 'HSET', k, K(value.field), K(value.value))
      return
    case 'list':
      await send(client, 'RPUSH', k, K(value.value))
      return
    case 'set':
      await send(client, 'SADD', k, K(value.member))
      return
    case 'zset':
      await send(client, 'ZADD', k, scoreText(value.score), K(value.member))
      return
    case 'stream':
      await send(client, 'XADD', k, '*', ...value.fields.flatMap(([f, v]) => [K(f), K(v)]))
      return
  }
}

async function copyKey(
  conn: RedisConnection,
  db: number,
  key: string,
  edit: Extract<RedisEdit, { op: 'key.copy' }>,
): Promise<void> {
  const client = conn.client(db)
  const k = K(key)
  const target = K(edit.newKey)
  const toDb = edit.toDb ?? db
  if (Number(await send(client, 'EXISTS', k)) === 0) throw notFound()
  try {
    const args: (string | number | Buffer)[] = [k, target]
    if (toDb !== db) args.push('DB', toDb)
    if (edit.overwrite) args.push('REPLACE')
    if (Number(await send(client, 'COPY', ...args)) === 0) throw exists()
  } catch (error) {
    if (!isUnsupported(error)) throw error
    // Before 6.2 there is no COPY: the key is serialised, and restored under its new name with its TTL.
    const [dump, ttl] = await pipeline(client, [
      ['DUMP', k],
      ['PTTL', k],
    ])
    if (dump?.[0]) throw dump[0]
    if (!Buffer.isBuffer(dump?.[1])) throw notFound()
    const pttl = Number(ttl?.[1])
    await send(
      conn.client(toDb),
      'RESTORE',
      target,
      pttl > 0 ? pttl : 0,
      dump[1],
      ...(edit.overwrite ? ['REPLACE'] : []),
    )
  }
}
