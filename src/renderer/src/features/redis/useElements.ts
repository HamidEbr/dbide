import { useCallback, useEffect, useRef, useState } from 'react'
import { ELEMENTS_PAGE, type RedisType, type ValuePage } from '@shared/redis/types'
import { coreLink } from '@/ipc/link'
import { messageOf } from '@/lib/format'

export interface Elements {
  /** The latest page, for the string and JSON values that come in one piece. */
  page: ValuePage | null
  /** The items of every page loaded so far, for collections. */
  items: unknown[]
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  error: string | null
  loadMore: () => void
  reload: () => void
}

interface Settled {
  key: string
  page: ValuePage | null
  items: unknown[]
  next: string | null
  error: string | null
}

const itemsOf = (page: ValuePage): unknown[] => ('items' in page ? (page.items as unknown[]) : [])
const nextOf = (page: ValuePage): string | null => ('next' in page ? page.next : null)

/**
 * What a key holds, a page at a time. It starts over when the key, its type or the filter changes, or on
 * `reload`, which is what a change calls to show itself.
 */
export function useElements(
  connectionId: string,
  db: number,
  keyName: string,
  type: RedisType | null,
  match: string,
): Elements {
  const key = `${connectionId}|${db}|${keyName}|${type ?? ''}|${match}`
  const [settled, setSettled] = useState<Settled | null>(null)
  const [tick, setTick] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const controller = useRef<AbortController | null>(null)

  const request = useCallback(
    (cursor: string | null, signal: AbortSignal) =>
      coreLink.call(
        'redis.value',
        {
          connectionId,
          db,
          key: keyName,
          type: type!,
          cursor,
          count: ELEMENTS_PAGE,
          ...(match ? { match } : {}),
        },
        { signal },
      ),
    [connectionId, db, keyName, type, match],
  )

  useEffect(() => {
    if (type === null || type === 'none') return
    const ctl = new AbortController()
    controller.current = ctl
    request(null, ctl.signal)
      .then((page) =>
        setSettled({ key, page, items: itemsOf(page), next: nextOf(page), error: null }),
      )
      .catch((error: unknown) => {
        if (ctl.signal.aborted) return
        setSettled({ key, page: null, items: [], next: null, error: messageOf(error) })
      })
    return () => ctl.abort()
    // The key says everything the request depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick])

  const current = settled?.key === key ? settled : null

  const loadMore = useCallback(() => {
    if (!current || current.next === null || loadingMore) return
    const ctl = new AbortController()
    controller.current = ctl
    setLoadingMore(true)
    request(current.next, ctl.signal)
      .then((page) =>
        setSettled((previous) =>
          previous && previous.key === key
            ? {
                ...previous,
                page,
                items: [...previous.items, ...itemsOf(page)],
                next: nextOf(page),
              }
            : previous,
        ),
      )
      .catch((error: unknown) => {
        if (ctl.signal.aborted) return
        setSettled((previous) =>
          previous && previous.key === key ? { ...previous, error: messageOf(error) } : previous,
        )
      })
      .finally(() => setLoadingMore(false))
  }, [current, key, loadingMore, request])

  return {
    page: current?.page ?? null,
    items: current?.items ?? [],
    loading: current === null && type !== null && type !== 'none',
    loadingMore,
    hasMore: current?.next != null,
    error: current?.error ?? null,
    loadMore,
    reload: () => setTick((n) => n + 1),
  }
}
