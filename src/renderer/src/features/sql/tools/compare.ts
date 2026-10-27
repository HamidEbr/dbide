import type { Cell } from '@shared/query'

export type DiffStatus = 'same' | 'changed' | 'added' | 'removed'

export interface DiffRow {
  status: DiffStatus
  /** The row's values for the columns both results have: `a` in the first result, `b` in the second. */
  a: Cell[] | null
  b: Cell[] | null
  /** For a changed row, whether each shared column differs. */
  differs: boolean[]
}

export interface Comparison {
  /** The columns both results have, by name. */
  columns: string[]
  /** Columns only one of them has. */
  onlyA: string[]
  onlyB: string[]
  rows: DiffRow[]
  counts: Record<DiffStatus, number>
}

/** A value in a form where `1` and `'1'` are the same, and bytes compare by content. */
function normal(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return '\u0000null'
  if (cell instanceof Uint8Array)
    return `\u0000bytes:${Array.from(cell, (b) => b.toString(16)).join('')}`
  if (typeof cell === 'boolean') return cell ? '1' : '0'
  return String(cell)
}

export const MAX_COMPARED_ROWS = 100_000

/**
 * Lines up two results by the columns that identify a row (the key). A key found in only one result is added or
 * removed; in both, the row is the same or changed. The same key twice in one result pairs the first with the first,
 * the second with the second.
 */
export function compareResults(
  a: { columns: readonly string[]; rows: readonly (readonly Cell[])[] },
  b: { columns: readonly string[]; rows: readonly (readonly Cell[])[] },
  keys: readonly string[],
): Comparison {
  const lower = (name: string): string => name.toLowerCase()
  const inB = new Set(b.columns.map(lower))
  const shared = a.columns.filter((c) => inB.has(lower(c)))
  const sharedLower = new Set(shared.map(lower))
  const indexA = shared.map((c) => a.columns.findIndex((x) => lower(x) === lower(c)))
  const indexB = shared.map((c) => b.columns.findIndex((x) => lower(x) === lower(c)))
  const keyAt = shared
    .map((c, i) => [c, i] as const)
    .filter(([c]) => keys.some((k) => lower(k) === lower(c)))
    .map(([, i]) => i)
  // Without a key a row is identified by all of its values.
  const keyColumns = keyAt.length > 0 ? keyAt : shared.map((_, i) => i)

  const valuesA = (row: readonly Cell[]): Cell[] => indexA.map((i) => row[i] ?? null)
  const valuesB = (row: readonly Cell[]): Cell[] => indexB.map((i) => row[i] ?? null)
  const identity = (values: Cell[], seen: Map<string, number>): string => {
    const base = keyColumns.map((i) => normal(values[i])).join('\u0001')
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return `${base}\u0002${n}`
  }

  const seenB = new Map<string, number>()
  const byKeyB = new Map<string, Cell[]>()
  const orderB: string[] = []
  for (const row of b.rows) {
    const values = valuesB(row)
    const id = identity(values, seenB)
    byKeyB.set(id, values)
    orderB.push(id)
  }

  const rows: DiffRow[] = []
  const seenA = new Map<string, number>()
  const matched = new Set<string>()
  for (const row of a.rows) {
    const values = valuesA(row)
    const id = identity(values, seenA)
    const other = byKeyB.get(id)
    if (!other) {
      rows.push({ status: 'removed', a: values, b: null, differs: [] })
      continue
    }
    matched.add(id)
    const differs = values.map((v, i) => normal(v) !== normal(other[i]))
    rows.push({ status: differs.some(Boolean) ? 'changed' : 'same', a: values, b: other, differs })
  }
  for (const id of orderB) {
    if (!matched.has(id)) rows.push({ status: 'added', a: null, b: byKeyB.get(id)!, differs: [] })
  }

  const counts: Comparison['counts'] = { same: 0, changed: 0, added: 0, removed: 0 }
  for (const r of rows) counts[r.status]++
  return {
    columns: shared,
    onlyA: a.columns.filter((c) => !sharedLower.has(lower(c))),
    onlyB: b.columns.filter((c) => !a.columns.some((x) => lower(x) === lower(c))),
    rows,
    counts,
  }
}
