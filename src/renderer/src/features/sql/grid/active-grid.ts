import type { GenerateKind } from '../edit/generate'
import type { CopyFormat, CopyOptions } from './copy'

/** What commands can ask of the grid that currently has keyboard focus. */
export interface GridHandle {
  copy(format: CopyFormat, options?: CopyOptions): void
  /** Copies `UPDATE` or `DELETE` statements for the selected rows. */
  generate(kind: GenerateKind): void
  /** Opens the rows a foreign key leads to from the focused cell. */
  follow(direction: 'references' | 'referencedBy'): void
}

let current: GridHandle | null = null

export const setActiveGrid = (handle: GridHandle | null): void => {
  current = handle
}

export const clearActiveGrid = (handle: GridHandle): void => {
  if (current === handle) current = null
}

export const activeGrid = (): GridHandle | null => current
