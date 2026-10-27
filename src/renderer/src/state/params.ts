import { create } from 'zustand'
import type { ParamValue } from '@shared/params'

const KEY = 'dbide.params'

/** The values last used for a script's parameters, so the next run starts from them. */
export function savedParameters(scriptId: string): Record<string, ParamValue> {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<
      string,
      Record<string, ParamValue>
    >
    return all[scriptId] ?? {}
  } catch {
    return {}
  }
}

export function saveParameters(scriptId: string, values: Record<string, ParamValue>): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<
      string,
      Record<string, ParamValue>
    >
    all[scriptId] = { ...all[scriptId], ...values }
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // Remembering is a convenience.
  }
}

export interface ParameterPrompt {
  scriptId: string
  names: string[]
  defaults: Record<string, ParamValue>
  resolve: (values: Record<string, ParamValue> | null) => void
}

interface PromptState {
  request: ParameterPrompt | null
  /** Resolves with the values, or null when the person backs out. */
  ask: (scriptId: string, names: string[]) => Promise<Record<string, ParamValue> | null>
  answer: (values: Record<string, ParamValue> | null) => void
}

export const useParameterPrompt = create<PromptState>((set, get) => ({
  request: null,
  ask: (scriptId, names) =>
    new Promise((resolve) => {
      get().request?.resolve(null)
      set({ request: { scriptId, names, defaults: savedParameters(scriptId), resolve } })
    }),
  answer: (values) => {
    const open = get().request
    if (!open) return
    set({ request: null })
    if (values) saveParameters(open.scriptId, values)
    open.resolve(values)
  },
}))
