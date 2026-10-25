import { create } from 'zustand'
import type { AppInfo } from '@shared/api'
import type { CoreState } from '@shared/bridge'
import type { ConnectionSummary } from '@shared/connection'
import type { DriverDescriptor } from '@shared/driver'
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings'
import { coreLink } from '@/ipc/link'

interface DataState {
  coreState: CoreState
  /** True once the first load from the core finished. */
  loaded: boolean
  connections: ConnectionSummary[]
  engines: DriverDescriptor[]
  settings: Settings
  info: AppInfo | null
  setCoreState: (state: CoreState) => void
  load: () => Promise<void>
  refreshConnections: () => Promise<void>
  updateSettings: (patch: Partial<Settings>) => Promise<void>
}

export const useData = create<DataState>((set, get) => ({
  coreState: 'starting',
  loaded: false,
  connections: [],
  engines: [],
  settings: DEFAULT_SETTINGS,
  info: null,

  setCoreState: (coreState) => set({ coreState }),

  load: async () => {
    const [info, engines, settings, connections] = await Promise.all([
      coreLink.call('app.info', undefined),
      coreLink.call('engines.list', undefined),
      coreLink.call('settings.get', undefined),
      coreLink.call('connections.list', undefined),
    ])
    set({ info, engines, settings, connections, loaded: true })
  },

  refreshConnections: async () => {
    set({ connections: await coreLink.call('connections.list', undefined) })
  },

  updateSettings: async (patch) => {
    const previous = get().settings
    set({ settings: { ...previous, ...patch } })
    try {
      set({ settings: await coreLink.call('settings.set', patch) })
    } catch (error) {
      set({ settings: previous })
      throw error
    }
  },
}))

export function engineName(engines: DriverDescriptor[], engine: string): string {
  return engines.find((d) => d.engine === engine)?.displayName ?? engine
}
