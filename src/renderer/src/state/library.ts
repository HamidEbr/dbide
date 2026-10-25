import { create } from 'zustand'
import type { ScriptInfo } from '@shared/scripts'
import { coreLink } from '@/ipc/link'

interface LibraryState {
  /** Every script in the scripts folder, open or not. */
  scripts: ScriptInfo[]
  loaded: boolean
  error: string | null
  refresh: () => Promise<void>
}

export const useLibrary = create<LibraryState>((set) => ({
  scripts: [],
  loaded: false,
  error: null,

  refresh: async () => {
    try {
      set({ scripts: await coreLink.call('scripts.list', undefined), loaded: true, error: null })
    } catch (error) {
      set({ loaded: true, error: error instanceof Error ? error.message : String(error) })
    }
  },
}))
