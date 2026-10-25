import { useCallback, useEffect, useRef, useState } from 'react'
import { messageOf } from '@/lib/format'

export interface ServerCall<T> {
  data: T | null
  error: string | null
  /** True until the first answer or failure. A refresh keeps showing the last answer. */
  loading: boolean
  /** When the last answer arrived. */
  updatedAt: number | null
  reload: () => void
}

/**
 * Asks the server for something and keeps the answer, optionally asking again every few seconds while
 * the view is on screen. A call that is still out when the next one starts is cancelled, and so is the last
 * one when the view goes away. `load` is read through a ref, so a new function each render doesn't re-ask.
 */
export function useServerCall<T>(
  load: (signal: AbortSignal) => Promise<T>,
  options: { refreshMs?: number; paused?: boolean } = {},
): ServerCall<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; at: number | null }>({
    data: null,
    error: null,
    at: null,
  })
  const [tick, setTick] = useState(0)
  const loader = useRef(load)
  useEffect(() => {
    loader.current = load
  })

  useEffect(() => {
    if (options.paused && tick === 0 && state.at !== null) return
    const controller = new AbortController()
    loader
      .current(controller.signal)
      .then((data) => setState({ data, error: null, at: Date.now() }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState((current) => ({ ...current, error: messageOf(error), at: Date.now() }))
      })
    return () => controller.abort()
    // A new tick asks again; so does coming back to a view that was paused.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, options.paused])

  useEffect(() => {
    if (!options.refreshMs || options.paused) return
    const timer = setInterval(() => setTick((n) => n + 1), options.refreshMs)
    return () => clearInterval(timer)
  }, [options.refreshMs, options.paused])

  const reload = useCallback(() => setTick((n) => n + 1), [])
  return {
    data: state.data,
    error: state.error,
    loading: state.data === null && state.error === null,
    updatedAt: state.at,
    reload,
  }
}
