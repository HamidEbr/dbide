import { create } from 'zustand'
import type { ColumnInfo } from '@shared/driver'
import type { Json } from '@shared/mongo/ejson'
import type { Cell } from '@shared/query'

/** What the inspector shows: one cell of one row, and what can be done with it. */
export interface InspectorTarget {
  /** The result set the cell belongs to. */
  ownerId: string
  columns: ColumnInfo[]
  rowIndex: number
  colIndex: number
  /** The row as it looks now, with staged edits applied. `undefined` means "table default". */
  row: (Cell | undefined)[]
  /** Columns of this row that carry a staged change. */
  changed: ReadonlySet<number>
  isNewRow: boolean
  isDeleted: boolean
  rowCount: number
  /** Present only when the result can be edited. */
  edit: {
    /** Why a column can't be edited, or null when it can. */
    blocked: (col: number) => string | null
    /** Stages a value for a column of this row. Returns an error message, or null on success. */
    set: (col: number, value: Cell) => string | null
  } | null
  /** Why this result can't be edited, when it can't. */
  readOnlyReason: string | null
  move: (deltaRow: number) => void
  focusColumn: (col: number) => void
}

/** What the inspector shows for a MongoDB result: one document, and what can be done with it. */
export interface DocumentTarget {
  /** The result the document belongs to. */
  ownerId: string
  /** Names the document across redraws, so the editor starts fresh for another one. */
  id: string
  database: string
  collection: string
  rowIndex: number
  rowCount: number
  /** The document with its staged edits applied. */
  document: Json
  /** The document as it was loaded. */
  original: Json
  state: 'clean' | 'changed' | 'deleted' | 'new'
  /** Why the document can't be edited, or null when it can. */
  blockedReason: string | null
  /** Editing is possible, but writes are locked. */
  locked: boolean
  /** Open the editor as soon as the document is shown. */
  editOnOpen: boolean
  unlock: () => void
  /** Stages the document's new contents. Returns why it can't be staged, or null. */
  stage: (next: Json) => string | null
  /** Marks the document for deletion, or unmarks it. */
  toggleDelete: () => void
  /** Adds a copy of the document, without its `_id`, as a new document. */
  clone: () => void
  /** Drops the edits staged for this document. */
  revert: () => void
  move: (delta: number) => void
}

export type InspectorTab = 'value' | 'record'

interface InspectorState {
  target: InspectorTarget | null
  /** Set instead of `target` while a MongoDB result is in front. */
  document: DocumentTarget | null
  setDocument: (document: DocumentTarget | null) => void
  tab: InspectorTab
  /** The value editor is open for the current cell. */
  editing: boolean
  setTarget: (target: InspectorTarget | null) => void
  setTab: (tab: InspectorTab) => void
  setEditing: (editing: boolean) => void
}

export const useInspector = create<InspectorState>((set, get) => ({
  target: null,
  document: null,
  setDocument: (document) => set({ document }),
  tab: 'value',
  editing: false,

  setTarget: (target) => {
    const previous = get().target
    const sameCell =
      previous &&
      target &&
      previous.ownerId === target.ownerId &&
      previous.rowIndex === target.rowIndex &&
      previous.colIndex === target.colIndex
    // Moving to another cell closes an open editor, so a half-typed value is never applied to it.
    set({ target, ...(sameCell ? {} : { editing: false }) })
  },
  setTab: (tab) => set({ tab }),
  setEditing: (editing) => set({ editing }),
}))
