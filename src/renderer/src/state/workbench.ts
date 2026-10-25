import { create } from 'zustand'
import type { EngineKind } from '@shared/connection'

export type TabKind =
  'welcome' | 'connection-editor' | 'connection' | 'settings' | 'sql' | 'broker' | 'redis'
export type PaletteMode = 'commands' | 'goto'
/** What the left side shows: the connection tree, the script library, or the query history. */
export type SidebarView = 'connections' | 'scripts' | 'history'

/** What a broker tab shows: a vhost's queues, or one queue, or one exchange. */
export interface BrokerTarget {
  view: 'vhost' | 'queue' | 'exchange'
  vhost: string
  /** The queue or exchange. Missing for a vhost. The default exchange is the empty string. */
  name?: string
}

/** What a Redis tab shows: the keys of a database, one key, a console, or the server's numbers. */
export interface RedisTarget {
  view: 'keys' | 'key' | 'console' | 'info'
  /** The database. A console may say -1: the one the connection opens in. */
  db: number
  /** The key a `key` tab edits, in the binary-safe form. */
  key?: string
  /** A glob a `keys` tab starts filtered by. */
  pattern?: string
}

export interface Tab {
  id: string
  kind: TabKind
  /** The saved connection a `connection` or editing tab is about. */
  connectionId?: string
  /** Identifies a connection that doesn't exist yet. */
  draftId?: string
  /** The script a `sql` tab edits. */
  scriptId?: string
  /** What a `broker` tab shows. */
  broker?: BrokerTarget
  /** What a `redis` tab shows. */
  redis?: RedisTarget
  initialUri?: string
  initialEngine?: EngineKind
}

interface WorkbenchState {
  tabs: Tab[]
  activeId: string | null
  palette: PaletteMode | null
  sidebar: SidebarView
  setSidebar: (view: SidebarView) => void
  /** A script moved to another connection: its tab follows. */
  retargetScript: (scriptId: string, connectionId: string) => void
  openTab: (tab: Tab) => void
  closeTab: (id: string) => void
  activate: (id: string) => void
  cycle: (delta: 1 | -1) => void
  setPalette: (mode: PaletteMode | null) => void
}

const WELCOME: Tab = { id: 'welcome', kind: 'welcome' }

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  tabs: [WELCOME],
  activeId: WELCOME.id,
  palette: null,
  sidebar: 'connections',

  setSidebar: (sidebar) => set({ sidebar }),

  retargetScript: (scriptId, connectionId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.scriptId === scriptId ? { ...tab, connectionId } : tab)),
    })),

  openTab: (tab) =>
    set((state) =>
      state.tabs.some((t) => t.id === tab.id)
        ? { activeId: tab.id }
        : { tabs: [...state.tabs, tab], activeId: tab.id },
    ),

  closeTab: (id) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === id)
      if (index === -1) return state
      const tabs = state.tabs.filter((tab) => tab.id !== id)
      if (state.activeId !== id) return { tabs }
      const next = tabs[index] ?? tabs[index - 1]
      return { tabs, activeId: next?.id ?? null }
    }),

  activate: (id) => set({ activeId: id }),

  cycle: (delta) => {
    const { tabs, activeId } = get()
    if (tabs.length === 0) return
    const index = tabs.findIndex((tab) => tab.id === activeId)
    const next = tabs[(index + delta + tabs.length) % tabs.length]
    if (next) set({ activeId: next.id })
  },

  setPalette: (palette) => set({ palette }),
}))

export const workbench = {
  openWelcome: () => useWorkbench.getState().openTab(WELCOME),
  openSettings: () => useWorkbench.getState().openTab({ id: 'settings', kind: 'settings' }),
  openScript: (scriptId: string, connectionId: string) =>
    useWorkbench.getState().openTab({ id: `sql:${scriptId}`, kind: 'sql', scriptId, connectionId }),
  openConnection: (connectionId: string) =>
    useWorkbench
      .getState()
      .openTab({ id: `conn:${connectionId}`, kind: 'connection', connectionId }),
  openBroker: (connectionId: string, broker: BrokerTarget) =>
    useWorkbench.getState().openTab({
      id: `broker:${connectionId}:${broker.view}:${broker.vhost}:${broker.name ?? ''}`,
      kind: 'broker',
      connectionId,
      broker,
    }),
  openRedis: (connectionId: string, redis: RedisTarget) =>
    useWorkbench.getState().openTab({
      id: `redis:${connectionId}:${redis.view}:${redis.db}:${redis.key ?? redis.pattern ?? ''}`,
      kind: 'redis',
      connectionId,
      redis,
    }),
  editConnection: (connectionId: string) =>
    useWorkbench
      .getState()
      .openTab({ id: `edit:${connectionId}`, kind: 'connection-editor', connectionId }),
  newConnection: (options: { initialUri?: string; initialEngine?: EngineKind } = {}) => {
    const draftId = crypto.randomUUID()
    useWorkbench
      .getState()
      .openTab({ id: `new:${draftId}`, kind: 'connection-editor', draftId, ...options })
  },
}
