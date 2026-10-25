import { create } from 'zustand'
import type { Environment } from '@shared/environment'

export interface GuardRequest {
  /** `run` confirms statements; `unlock` confirms lifting read-only mode. */
  action?: 'run' | 'unlock'
  connectionName: string
  environment: Environment
  statements: string[]
  reasons: string[]
  /** The user must type the connection's name before the run button works. */
  typedName: boolean
  /** The question, when it isn't about statements. */
  title?: string
  /** The confirming button's words. */
  confirmLabel?: string
  /** `statements` are descriptions of what will happen, not SQL: shown one per line, with no terminators. */
  plain?: boolean
}

interface GuardState {
  request: (GuardRequest & { resolve: (confirmed: boolean) => void }) | null
  /** Resolves true when the user confirms and false when they back out. */
  ask: (request: GuardRequest) => Promise<boolean>
  answer: (confirmed: boolean) => void
}

export const useGuard = create<GuardState>((set, get) => ({
  request: null,

  ask: (request) =>
    new Promise<boolean>((resolve) => {
      // A second question while one is open means the first is abandoned.
      get().request?.resolve(false)
      set({ request: { ...request, resolve } })
    }),

  answer: (confirmed) => {
    const open = get().request
    if (!open) return
    set({ request: null })
    open.resolve(confirmed)
  },
}))
