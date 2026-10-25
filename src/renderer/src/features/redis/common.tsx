import { isCoreType } from '@shared/redis/types'

/** A key's type as a small coloured label, so a list of mixed keys reads at a glance. */
export function TypeBadge({ type }: { type: string }) {
  return (
    <span className={`redis-type redis-type-${isCoreType(type) ? type : 'other'}`}>{type}</span>
  )
}

/** The words for a key type in a sentence: `a hash`, `a sorted set`. */
export const TYPE_NAMES: Record<string, string> = {
  string: 'string',
  hash: 'hash',
  list: 'list',
  set: 'set',
  zset: 'sorted set',
  stream: 'stream',
}

/** What the length of a key counts, by type. */
export function lengthLabel(type: string, length: number | null): string {
  if (length === null) return ''
  if (type === 'string') return `${length.toLocaleString()} bytes`
  const unit =
    type === 'hash'
      ? 'fields'
      : type === 'list'
        ? 'items'
        : type === 'stream'
          ? 'entries'
          : 'members'
  return `${length.toLocaleString()} ${unit}`
}

/** A key type that is a collection with members the window can list. */
export const isCollection = (type: string): type is 'hash' | 'list' | 'set' | 'zset' =>
  type === 'hash' || type === 'list' || type === 'set' || type === 'zset'
