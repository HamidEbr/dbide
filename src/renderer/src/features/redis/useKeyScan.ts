import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeySummary, RedisType } from '@shared/redis/types'
import { KEYS_PAGE, toGlob } from '@shared/redis/types'
import { coreLink } from '@/ipc/link'
import { messageOf } from '@/lib/format'

interface Settled {
  /** Which search these keys answer. A different search starts from nothing. */
  key: string
  keys: KeySummary[]
  cursor: string | null
  examined: number
  total: number | null
  error: string | null
}

export interface KeyScan {
  keys: KeySummary[]
  /** The whole keyspace has been looked at. */
  done: boolean
  /** The first page of this search has not come back yet. */
  loading: boolean
  /** More keys are being fetched after the first page. */
  loadingMore: boolean
  error: string | null
  /** About how many keys the server was asked to look at. */
  examined: number
  /** How many keys the database holds. */
  total: number | null
  loadMore: () => void
  reload: () => void
  /** Stops a scan that is still running. */
  stop: () => void
  /** Takes a key out of the list, after it was deleted. */
  remove: (key: string) => void
}

/**
 * Scans a database for keys a page at a time. The search starts over when the connection, database,
 * pattern or type changes, and a scan still running for the old search is cancelled.
 */
export function useKeyScan(
  connectionId: string,
  db: number,
  typedPattern: string,
  type: RedisType | undefined,
): KeyScan {
  const key = `${connectionId}|${db}|${typedPattern}|${type ?? ''}`
  const [settled, setSettled] = useState<Settled | null>(null)
  const [tick, setTick] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    const ctl = new AbortController()
    controller.current = ctl
    coreLink
      .call(
        'redis.scan',
        {
          connectionId,
          db,
          pattern: toGlob(typedPattern),
          ...(type ? { type } : {}),
          cursor: null,
          limit: KEYS_PAGE,
        },
        { signal: ctl.signal },
      )
      .then((page) =>
        setSettled({
          key,
          keys: page.keys,
          cursor: page.cursor,
          examined: page.examined,
          total: page.total,
          error: null,
        }),
      )
      .catch((error: unknown) => {
        if (ctl.signal.aborted) return
        setSettled({
          key,
          keys: [],
          cursor: null,
          examined: 0,
          total: null,
          error: messageOf(error),
        })
      })
    return () => ctl.abort()
    // The key already says everything the request depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick])

  const current = settled?.key === key ? settled : null

  const loadMore = useCallback(() => {
    if (!current || current.cursor === null || loadingMore) return
    const ctl = new AbortController()
    controller.current = ctl
    setLoadingMore(true)
    coreLink
      .call(
        'redis.scan',
        {
          connectionId,
          db,
          pattern: toGlob(typedPattern),
          ...(type ? { type } : {}),
          cursor: current.cursor,
          limit: KEYS_PAGE,
        },
        { signal: ctl.signal },
      )
      .then((page) =>
        setSettled((previous) => {
          if (!previous || previous.key !== key) return previous
          // A scan can bring a key back that an earlier page had.
          const seen = new Set(previous.keys.map((k) => k.key))
          return {
            ...previous,
            keys: [...previous.keys, ...page.keys.filter((k) => !seen.has(k.key))],
            cursor: page.cursor,
            examined: previous.examined + page.examined,
          }
        }),
      )
      .catch((error: unknown) => {
        if (ctl.signal.aborted) return
        setSettled((previous) =>
          previous && previous.key === key ? { ...previous, error: messageOf(error) } : previous,
        )
      })
      .finally(() => setLoadingMore(false))
  }, [connectionId, current, db, key, loadingMore, type, typedPattern])

  return {
    keys: current?.keys ?? [],
    done: current !== null && current.cursor === null,
    loading: current === null,
    loadingMore,
    error: current?.error ?? null,
    examined: current?.examined ?? 0,
    total: current?.total ?? null,
    loadMore,
    reload: () => setTick((n) => n + 1),
    stop: () => {
      controller.current?.abort()
      setLoadingMore(false)
      // A first page that was stopped shows as an empty, finished search.
      setSettled((previous) =>
        previous?.key === key
          ? previous
          : {
              key,
              keys: [],
              cursor: null,
              examined: 0,
              total: null,
              error: 'The scan was stopped.',
            },
      )
    },
    remove: (removed) =>
      setSettled((previous) =>
        previous ? { ...previous, keys: previous.keys.filter((k) => k.key !== removed) } : previous,
      ),
  }
}
