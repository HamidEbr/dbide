import { Cluster } from 'ioredis'
import { fromBytes, toBytes } from '@shared/redis/bstring'
import type { Commander } from './client'

/**
 * Plain strings are sent as UTF-8: command words, cursors, options. Anything the person owns, a key or a
 * value, goes through `K`, which turns the binary-safe form of `bstring.ts` back into bytes.
 */
export type Arg = string | number | Buffer

const bytesOf = (arg: Arg): Buffer =>
  typeof arg === 'number'
    ? Buffer.from(String(arg))
    : typeof arg === 'string'
      ? Buffer.from(arg)
      : arg

export const K = (value: string): Buffer => Buffer.from(toBytes(value))

/** Sends one command and returns the reply as the client parsed it: numbers, null, Buffers and arrays. */
export function send(client: Commander, command: string, ...args: Arg[]): Promise<unknown> {
  return client.callBuffer(command, ...args.map(bytesOf)) as Promise<unknown>
}

export type Settled = [Error | null, unknown]

/** Sends several commands in one round trip. Each one succeeds or fails on its own. */
export async function pipeline(client: Commander, commands: Arg[][]): Promise<Settled[]> {
  if (commands.length === 0) return []
  // A cluster's pipeline takes only keys that live together; keys of a whole page do not, so each command goes
  // out on its own, to its own node, all at once.
  if (client instanceof Cluster) {
    return Promise.all(
      commands.map(([command, ...args]) =>
        client.callBuffer(String(command), ...args.map(bytesOf)).then(
          (value): Settled => [null, value],
          (error: unknown): Settled => [error as Error, null],
        ),
      ),
    )
  }
  const batch = client.pipeline()
  for (const [command, ...args] of commands) batch.callBuffer(String(command), ...args.map(bytesOf))
  return ((await batch.exec()) ?? []) as Settled[]
}

/** Several commands as one transaction. The first failure inside it is thrown. */
export async function transaction(client: Commander, commands: Arg[][]): Promise<unknown[]> {
  const batch = client.multi()
  for (const [command, ...args] of commands) batch.callBuffer(String(command), ...args.map(bytesOf))
  const results = (await batch.exec()) ?? []
  const failed = (results as Settled[]).find(([error]) => error)
  if (failed?.[0]) throw failed[0]
  return (results as Settled[]).map(([, value]) => value)
}

export function num(value: unknown): number {
  if (typeof value === 'number') return value
  if (Buffer.isBuffer(value)) return Number(value.toString('utf8'))
  return Number.NaN
}

/** A reply as text, for the words servers use (types, encodings, ids). */
export const str = (value: unknown): string =>
  Buffer.isBuffer(value)
    ? value.toString('utf8')
    : typeof value === 'string'
      ? value
      : String(value ?? '')

/** A reply as a key or a value in the binary-safe form. */
export const bin = (value: unknown): string =>
  Buffer.isBuffer(value) ? fromBytes(value) : typeof value === 'string' ? value : ''

export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** A score the way Redis writes it: `inf` and `-inf` are numbers too. */
export function score(value: unknown): number {
  const text = str(value).toLowerCase()
  if (text === 'inf' || text === '+inf') return Infinity
  if (text === '-inf') return -Infinity
  return Number(text)
}

/** A reply that is a flat list of name, value, name, value as a map. Servers differ on what the values are. */
export function pairs(value: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>()
  const items = list(value)
  for (let i = 0; i + 1 < items.length; i += 2) out.set(str(items[i]), items[i + 1])
  return out
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
