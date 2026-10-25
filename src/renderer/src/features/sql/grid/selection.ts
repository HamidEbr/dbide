import type { ColumnInfo } from '@shared/driver'
import type { Cell } from '@shared/query'
import {
  addToTotals,
  emptyTotals,
  mergeTotals,
  numericValueOf,
  type NumberTotals,
} from '@shared/value'

/** An inclusive rectangle of cells. */
export interface Selection {
  r1: number
  c1: number
  r2: number
  c2: number
}

export interface GridPoint {
  row: number
  col: number
}

/** Clamps a selection to the grid and puts its corners in order. */
export function normalizeSelection(
  anchor: GridPoint,
  focus: GridPoint,
  rowCount: number,
  colCount: number,
): Selection | null {
  if (rowCount === 0 || colCount === 0) return null
  const clamp = (value: number, max: number): number => Math.max(0, Math.min(max - 1, value))
  const ar = clamp(anchor.row, rowCount)
  const ac = clamp(anchor.col, colCount)
  const fr = clamp(focus.row, rowCount)
  const fc = clamp(focus.col, colCount)
  return {
    r1: Math.min(ar, fr),
    r2: Math.max(ar, fr),
    c1: Math.min(ac, fc),
    c2: Math.max(ac, fc),
  }
}

export const selectionSize = (s: Selection): number => (s.r2 - s.r1 + 1) * (s.c2 - s.c1 + 1)

export interface SelectionStats {
  /** Cells in the selection. */
  cells: number
  /** Cells that held a number. */
  numeric: number
  sum: number
  avg: number
  min: number
  max: number
  /** True when the selection was larger than the scan limit and the numbers are partial. */
  partial: boolean
}

/** The statistics a selection shows, from totals that may come from several places. */
export function statsFrom(totals: NumberTotals, cells: number, partial: boolean): SelectionStats {
  return {
    cells,
    numeric: totals.numeric,
    sum: totals.sum,
    avg: totals.numeric > 0 ? totals.sum / totals.numeric : 0,
    min: totals.numeric > 0 ? totals.min : 0,
    max: totals.numeric > 0 ? totals.max : 0,
    partial,
  }
}

/** The numbers in the rows of a selection that are at hand. Scans at most `limit` cells. */
export function selectionTotals(
  selection: Selection,
  getRow: (row: number) => Cell[] | undefined,
  columns: ColumnInfo[],
  limit = 500_000,
): { totals: NumberTotals; scanned: number } {
  const totals = emptyTotals()
  let scanned = 0
  scan: for (let r = selection.r1; r <= selection.r2; r++) {
    const row = getRow(r)
    if (!row) continue
    for (let c = selection.c1; c <= selection.c2; c++) {
      if (scanned++ >= limit) break scan
      const n = numericValueOf(row[c] as Cell, columns[c]?.type)
      if (n !== null) addToTotals(totals, n)
    }
  }
  return { totals, scanned }
}

/** Count, sum, average, min, and max of the numbers in a selection. Scans at most `limit` cells. */
export function selectionStats(
  selection: Selection,
  getRow: (row: number) => Cell[] | undefined,
  columns: ColumnInfo[],
  limit = 500_000,
): SelectionStats {
  const cells = selectionSize(selection)
  const { totals } = selectionTotals(selection, getRow, columns, limit)
  return statsFrom(totals, cells, cells > limit)
}

export { mergeTotals }
