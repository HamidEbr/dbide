import { create } from 'zustand'
import type { Cell } from '@shared/query'
import {
  addInsert,
  emptyChangeSet,
  removeInsert,
  setInsertValue,
  setUpdate,
  toggleDeletes,
  type ChangeSet,
} from '@/features/sql/edit/change-set'

interface EditsState {
  /** Staged changes by result set id. A result with none has no entry. */
  sets: Record<string, ChangeSet>
  update: (id: string, change: (set: ChangeSet) => ChangeSet) => void
  discard: (id: string) => void
}

export const useEdits = create<EditsState>((set) => ({
  sets: {},

  update: (id, change) =>
    set((state) => {
      const next = change(state.sets[id] ?? emptyChangeSet())
      const empty =
        Object.keys(next.updates).length +
          Object.keys(next.deletes).length +
          next.inserts.length ===
        0
      if (empty) {
        const { [id]: _gone, ...rest } = state.sets
        return { sets: rest }
      }
      return { sets: { ...state.sets, [id]: next } }
    }),

  discard: (id) =>
    set((state) => {
      const { [id]: _gone, ...rest } = state.sets
      return { sets: rest }
    }),
}))

/** Named operations, so callers never rebuild a change set by hand. */
export const edits = {
  setCell: (
    id: string,
    row: number,
    key: Cell[],
    col: number,
    value: Cell,
    original: Cell,
    type: string,
  ): void =>
    useEdits.getState().update(id, (s) => setUpdate(s, row, key, col, value, original, type)),
  toggleDelete: (id: string, rows: { row: number; key: Cell[] }[]): void =>
    useEdits.getState().update(id, (s) => toggleDeletes(s, rows)),
  addRow: (id: string, rowId: string): void =>
    useEdits.getState().update(id, (s) => addInsert(s, rowId)),
  setNewCell: (id: string, rowId: string, col: number, value: Cell | undefined): void =>
    useEdits.getState().update(id, (s) => setInsertValue(s, rowId, col, value)),
  removeRow: (id: string, rowId: string): void =>
    useEdits.getState().update(id, (s) => removeInsert(s, rowId)),
  discard: (id: string): void => useEdits.getState().discard(id),
}
