import { create } from 'zustand'

export interface Notice {
  id: number
  kind: 'info' | 'warn' | 'error'
  message: string
}

interface NoticesState {
  notices: Notice[]
  show: (message: string, kind?: Notice['kind']) => void
  dismiss: (id: number) => void
}

let nextId = 1

/** Short messages that confirm an action or say why it didn't work. They dismiss themselves. */
export const useNotices = create<NoticesState>((set, get) => ({
  notices: [],

  show: (message, kind = 'info') => {
    const id = nextId++
    set((state) => ({ notices: [...state.notices.slice(-3), { id, kind, message }] }))
    setTimeout(() => get().dismiss(id), kind === 'info' ? 2500 : 10_000)
  },

  dismiss: (id) => set((state) => ({ notices: state.notices.filter((n) => n.id !== id) })),
}))

export const notify = (message: string, kind?: Notice['kind']): void =>
  useNotices.getState().show(message, kind)
