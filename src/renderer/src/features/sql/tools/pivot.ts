import type { Cell } from '@shared/query'

export type Aggregate = 'count' | 'sum' | 'avg' | 'min' | 'max'
export const AGGREGATES: readonly { value: Aggregate; label: string }[] = [
  { value: 'count', label: 'Count' },
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Smallest' },
  { value: 'max', label: 'Largest' },
]

/** A cell as a number, or null when it isn't one. */
export function numberOf(cell: Cell | undefined): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null
  if (typeof cell === 'string' && cell.trim() !== '') {
    const n = Number(cell)
    return Number.isFinite(n) ? n : null
  }
  if (typeof cell === 'boolean') return cell ? 1 : 0
  return null
}

/** A cell as the label of a group. */
export function labelOf(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return 'NULL'
  if (cell instanceof Uint8Array)
    return `0x${Array.from(cell.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')}`
  return String(cell)
}

export const compareLabels = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

/** What is gathered for a group: enough to give any of the aggregates, and to merge groups for totals. */
export interface Accumulator {
  rows: number
  numbers: number
  sum: number
  min: number
  max: number
}

export const emptyAccumulator = (): Accumulator => ({
  rows: 0,
  numbers: 0,
  sum: 0,
  min: Infinity,
  max: -Infinity,
})

export function add(acc: Accumulator, value: number | null): void {
  acc.rows++
  if (value === null) return
  acc.numbers++
  acc.sum += value
  if (value < acc.min) acc.min = value
  if (value > acc.max) acc.max = value
}

export function merge(into: Accumulator, from: Accumulator): void {
  into.rows += from.rows
  into.numbers += from.numbers
  into.sum += from.sum
  if (from.min < into.min) into.min = from.min
  if (from.max > into.max) into.max = from.max
}

export function resultOf(acc: Accumulator | undefined, aggregate: Aggregate): number | null {
  if (!acc) return null
  if (aggregate === 'count') return acc.rows
  if (acc.numbers === 0) return null
  switch (aggregate) {
    case 'sum':
      return acc.sum
    case 'avg':
      return acc.sum / acc.numbers
    case 'min':
      return acc.min
    case 'max':
      return acc.max
  }
}

export interface PivotSpec {
  /** The column whose values become the rows of the pivot. */
  rows: number
  /** The column whose values become the columns, or null for a single column of results. */
  columns: number | null
  /** The column that is added up, averaged and so on. Ignored for a count. */
  value: number | null
  aggregate: Aggregate
}

export interface Pivot {
  rowLabels: string[]
  columnLabels: string[]
  cells: (number | null)[][]
  rowTotals: (number | null)[]
  columnTotals: (number | null)[]
  total: number | null
  /** There were more distinct values than are shown. */
  capped: boolean
}

export const MAX_PIVOT_ROWS = 2000
export const MAX_PIVOT_COLUMNS = 100

export function buildPivot(rows: readonly (readonly Cell[])[], spec: PivotSpec): Pivot {
  const groups = new Map<string, Accumulator>()
  const rowSet = new Set<string>()
  const columnSet = new Set<string>()
  const rowTotals = new Map<string, Accumulator>()
  const columnTotals = new Map<string, Accumulator>()
  const total = emptyAccumulator()
  const value = spec.aggregate === 'count' || spec.value === null ? null : spec.value

  for (const row of rows) {
    const r = labelOf(row[spec.rows])
    const c = spec.columns === null ? '' : labelOf(row[spec.columns])
    const n = value === null ? null : numberOf(row[value])
    rowSet.add(r)
    columnSet.add(c)
    for (const [map, key] of [
      [groups, `${r}\u0000${c}`],
      [rowTotals, r],
      [columnTotals, c],
    ] as const) {
      let acc = map.get(key)
      if (!acc) map.set(key, (acc = emptyAccumulator()))
      add(acc, n)
    }
    add(total, n)
  }

  const allRows = [...rowSet].sort(compareLabels)
  const allColumns = [...columnSet].sort(compareLabels)
  const rowLabels = allRows.slice(0, MAX_PIVOT_ROWS)
  const columnLabels = allColumns.slice(0, MAX_PIVOT_COLUMNS)
  return {
    rowLabels,
    columnLabels,
    cells: rowLabels.map((r) =>
      columnLabels.map((c) => resultOf(groups.get(`${r}\u0000${c}`), spec.aggregate)),
    ),
    rowTotals: rowLabels.map((r) => resultOf(rowTotals.get(r), spec.aggregate)),
    columnTotals: columnLabels.map((c) => resultOf(columnTotals.get(c), spec.aggregate)),
    total: resultOf(total, spec.aggregate),
    capped: allRows.length > rowLabels.length || allColumns.length > columnLabels.length,
  }
}
