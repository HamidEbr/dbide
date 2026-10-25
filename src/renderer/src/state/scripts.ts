import { create } from 'zustand'
import type { ColumnInfo } from '@shared/driver'
import type { ScriptLanguage } from '@shared/scripts'
import type { RowStore } from '@/features/sql/grid/row-store'

export type StatementStatus =
  'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled' | 'skipped'

export interface ResultSet {
  id: string
  columns: ColumnInfo[]
  /** Rows live in the store, outside React state. */
  store: RowStore
}

export interface StatementRun {
  index: number
  sql: string
  status: StatementStatus
  resultSets: ResultSet[]
  ok: { affectedRows: number; insertId: string | null; message: string; warnings: number } | null
  error: { code: string | null; message: string } | null
  durationMs: number | null
  /** Set when the result stopped at the hard row cap. */
  truncated: boolean
}

export type RunState = 'running' | 'cancelling' | 'completed' | 'cancelled' | 'error'

export interface ScriptRun {
  runId: string
  state: RunState
  statements: StatementRun[]
}

export type SaveState = 'saved' | 'saving' | 'error'

export interface Script {
  id: string
  /** The file name without its extension. */
  name: string
  /** What the script is written in: decides its editor, its statements and its file type. */
  language: ScriptLanguage
  connectionId: string
  database: string | null
  text: string
  /** False means the session is read-only. Production connections start locked. */
  writable: boolean
  run: ScriptRun | null
  /** Whether the text is safe in its file. Typing makes it unsaved for a moment before it saves. */
  saveState: SaveState
  saveError: string | null
}

interface ScriptsState {
  scripts: Record<string, Script>
  add: (script: Script) => void
  patch: (id: string, patch: Partial<Omit<Script, 'id'>>) => void
  patchRun: (id: string, runId: string, update: (run: ScriptRun) => ScriptRun) => void
  remove: (id: string) => void
}

export const useScripts = create<ScriptsState>((set) => ({
  scripts: {},

  add: (script) => set((state) => ({ scripts: { ...state.scripts, [script.id]: script } })),

  patch: (id, patch) =>
    set((state) => {
      const script = state.scripts[id]
      return script ? { scripts: { ...state.scripts, [id]: { ...script, ...patch } } } : state
    }),

  /** Applies an update only while `runId` is still the script's current run. */
  patchRun: (id, runId, update) =>
    set((state) => {
      const script = state.scripts[id]
      if (!script?.run || script.run.runId !== runId) return state
      return { scripts: { ...state.scripts, [id]: { ...script, run: update(script.run) } } }
    }),

  remove: (id) =>
    set((state) => {
      const { [id]: _removed, ...rest } = state.scripts
      return { scripts: rest }
    }),
}))
