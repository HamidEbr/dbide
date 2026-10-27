import { create } from 'zustand'
import type { Cell } from '@shared/query'

/** A copy of a result kept to compare a later one against. */
export interface Snapshot {
  id: string
  label: string
  keptAt: number
  columns: string[]
  rows: Cell[][]
}

const MAX_SNAPSHOTS = 6

interface SnapshotsState {
  snapshots: Snapshot[]
  keep: (snapshot: Omit<Snapshot, 'id' | 'keptAt'>) => void
  drop: (id: string) => void
}

export const useSnapshots = create<SnapshotsState>((set) => ({
  snapshots: [],
  keep: (snapshot) =>
    set((state) => ({
      snapshots: [
        { ...snapshot, id: crypto.randomUUID(), keptAt: Date.now() },
        ...state.snapshots,
      ].slice(0, MAX_SNAPSHOTS),
    })),
  drop: (id) => set((state) => ({ snapshots: state.snapshots.filter((s) => s.id !== id) })),
}))
