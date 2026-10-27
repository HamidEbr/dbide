import { create } from 'zustand'
import type { ColumnInfo } from '@shared/driver'

/** What the export dialog needs to know about the result it was opened for. */
export interface ExportRequest {
  /** The script whose result is exported. Missing for a table exported from the tree. */
  scriptId?: string
  connectionId: string
  database: string | null
  sql: string
  columns: ColumnInfo[]
  /**
   * Set when a whole table is exported from the tree: the dialog builds the SELECT itself, from the columns,
   * the condition and the limit chosen in it.
   */
  table?: { schema: string; table: string; columns: string[] }
}

/** A whole database written as a SQL file. */
export interface DumpRequest {
  connectionId: string
  database: string
}

/** A statement whose query plan is shown. */
export interface ExplainRequest {
  connectionId: string
  database: string | null
  sql: string
}

/** A file imported into a table, or into a new one, of a database. */
export interface ImportRequest {
  connectionId: string
  database: string
  /** The table the rows go into, when it was opened from one. */
  table?: string
}

interface DialogsState {
  /** The script whose local history is open. */
  localHistory: string | null
  export: ExportRequest | null
  dump: DumpRequest | null
  explain: ExplainRequest | null
  dbeaverImport: boolean
  importData: ImportRequest | null
  openLocalHistory: (scriptId: string) => void
  closeLocalHistory: () => void
  openExport: (request: ExportRequest) => void
  closeExport: () => void
  openDump: (request: DumpRequest) => void
  closeDump: () => void
  openExplain: (request: ExplainRequest) => void
  closeExplain: () => void
  openDbeaverImport: () => void
  closeDbeaverImport: () => void
  openImportData: (request: ImportRequest) => void
  closeImportData: () => void
}

/** Which of the larger dialogs is open. The dialogs hold the rest of their own state. */
export const useDialogs = create<DialogsState>((set) => ({
  localHistory: null,
  export: null,
  dump: null,
  explain: null,
  dbeaverImport: false,
  importData: null,
  openLocalHistory: (scriptId) => set({ localHistory: scriptId }),
  closeLocalHistory: () => set({ localHistory: null }),
  openExport: (request) => set({ export: request }),
  closeExport: () => set({ export: null }),
  openDump: (request) => set({ dump: request }),
  closeDump: () => set({ dump: null }),
  openExplain: (request) => set({ explain: request }),
  closeExplain: () => set({ explain: null }),
  openDbeaverImport: () => set({ dbeaverImport: true }),
  closeDbeaverImport: () => set({ dbeaverImport: false }),
  openImportData: (request) => set({ importData: request }),
  closeImportData: () => set({ importData: null }),
}))
