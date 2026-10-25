import { create } from 'zustand'
import { HISTORY_PAGE_SIZE, type HistoryEntry, type HistoryStatus } from '@shared/scripts'
import { coreLink } from '@/ipc/link'

interface Filters {
  search: string
  connectionId: string | null
  /** `all`, or only the statements that failed. */
  status: 'all' | 'error'
}

interface HistoryState extends Filters {
  entries: HistoryEntry[]
  hasMore: boolean
  loading: boolean
  error: string | null
  setFilters: (patch: Partial<Filters>) => void
  /** Fetches the newest entries again, keeping as many as are already shown. */
  reload: () => Promise<void>
  loadMore: () => Promise<void>
  remove: (id: number) => Promise<void>
  clear: (connectionId?: string) => Promise<void>
}

/** Answers that arrive after a newer request was sent are dropped. */
let latest = 0

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

function queryOf(filters: Filters, extra: { before?: number; limit: number }) {
  return {
    limit: extra.limit,
    ...(extra.before !== undefined ? { before: extra.before } : {}),
    ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
    ...(filters.connectionId ? { connectionId: filters.connectionId } : {}),
    ...(filters.status === 'error' ? { status: 'error' as HistoryStatus } : {}),
  }
}

export const useHistory = create<HistoryState>((set, get) => ({
  search: '',
  connectionId: null,
  status: 'all',
  entries: [],
  hasMore: false,
  loading: false,
  error: null,

  setFilters: (patch) => {
    set(patch)
    void get().reload()
  },

  reload: async () => {
    const ticket = ++latest
    const { entries } = get()
    const limit = Math.min(500, Math.max(HISTORY_PAGE_SIZE, entries.length))
    set({ loading: true })
    try {
      const page = await coreLink.call('history.list', queryOf(get(), { limit }))
      if (ticket === latest) {
        set({ entries: page.entries, hasMore: page.hasMore, loading: false, error: null })
      }
    } catch (error) {
      if (ticket === latest) set({ loading: false, error: messageOf(error) })
    }
  },

  loadMore: async () => {
    const { entries, hasMore, loading } = get()
    const last = entries.at(-1)
    if (!hasMore || loading || !last) return
    const ticket = ++latest
    set({ loading: true })
    try {
      const page = await coreLink.call(
        'history.list',
        queryOf(get(), { limit: HISTORY_PAGE_SIZE, before: last.id }),
      )
      if (ticket === latest) {
        set((state) => ({
          entries: [...state.entries, ...page.entries],
          hasMore: page.hasMore,
          loading: false,
          error: null,
        }))
      }
    } catch (error) {
      if (ticket === latest) set({ loading: false, error: messageOf(error) })
    }
  },

  remove: async (id) => {
    set((state) => ({ entries: state.entries.filter((e) => e.id !== id) }))
    await coreLink.call('history.delete', { id })
  },

  clear: async (connectionId) => {
    await coreLink.call('history.clear', connectionId ? { connectionId } : {})
    await get().reload()
  },
}))
