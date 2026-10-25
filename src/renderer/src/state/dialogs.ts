import { create } from 'zustand'
import type { ColumnInfo } from '@shared/driver'

/** What the export dialog needs to know about the result it was opened for. */
export interface ExportRequest {
  scriptId: string
  connectionId: string
  database: string | null
  sql: string
  columns: ColumnInfo[]
}

interface DialogsState {
  /** The script whose local history is open. */
  localHistory: string | null
  export: ExportRequest | null
  openLocalHistory: (scriptId: string) => void
  closeLocalHistory: () => void
  openExport: (request: ExportRequest) => void
  closeExport: () => void
}

/** Which of the larger dialogs is open. The dialogs hold the rest of their own state. */
export const useDialogs = create<DialogsState>((set) => ({
  localHistory: null,
  export: null,
  openLocalHistory: (scriptId) => set({ localHistory: scriptId }),
  closeLocalHistory: () => set({ localHistory: null }),
  openExport: (request) => set({ export: request }),
  closeExport: () => set({ export: null }),
}))
