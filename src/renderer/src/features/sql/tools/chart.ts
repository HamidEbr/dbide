import type { Cell } from '@shared/query'
import {
  add,
  compareLabels,
  emptyAccumulator,
  labelOf,
  numberOf,
  resultOf,
  type Accumulator,
  type Aggregate,
} from './pivot'

export type ChartKind = 'bar' | 'line' | 'pie'

export interface ChartSpec {
  kind: ChartKind
  /** The column along the bottom, or whose values are the slices. */
  x: number
  /** The column that is measured. Null counts rows. */
  y: number | null
  aggregate: Aggregate
}

export interface ChartPoint {
  label: string
  value: number
}

export interface ChartData {
  points: ChartPoint[]
  /** Points left out: a chart of thousands of bars says nothing. */
  omitted: number
}

export const MAX_BARS = 40
export const MAX_LINE_POINTS = 500
export const MAX_SLICES = 12

/** The values of one column against another, grouped by the first. */
export function buildChart(rows: readonly (readonly Cell[])[], spec: ChartSpec): ChartData {
  const groups = new Map<string, Accumulator>()
  const aggregate = spec.y === null ? 'count' : spec.aggregate
  for (const row of rows) {
    const label = labelOf(row[spec.x])
    let acc = groups.get(label)
    if (!acc) groups.set(label, (acc = emptyAccumulator()))
    add(acc, spec.y === null ? null : numberOf(row[spec.y]))
  }
  let points: ChartPoint[] = []
  for (const [label, acc] of groups) {
    const value = resultOf(acc, aggregate)
    if (value !== null) points.push({ label, value })
  }
  if (spec.kind === 'line') {
    // A line goes along an axis, in its order.
    points.sort((a, b) => compareLabels(a.label, b.label))
    const omitted = Math.max(0, points.length - MAX_LINE_POINTS)
    return { points: points.slice(0, MAX_LINE_POINTS), omitted }
  }
  points.sort((a, b) => b.value - a.value)
  const limit = spec.kind === 'pie' ? MAX_SLICES : MAX_BARS
  const omitted = Math.max(0, points.length - limit)
  points = points.slice(0, limit)
  if (spec.kind === 'bar') points.sort((a, b) => compareLabels(a.label, b.label))
  return { points, omitted }
}

/** Round numbers to put along an axis from 0 (or the lowest value, when below) to the highest. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  const low = Math.min(0, min)
  const high = Math.max(0, max)
  if (low === high) return [0]
  const rough = (high - low) / count
  const power = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? rough
  const ticks: number[] = []
  for (let v = Math.floor(low / step) * step; v <= high + step * 0.5; v += step) {
    ticks.push(Math.round(v / step) * step)
    if (ticks.length > 20) break
  }
  return ticks
}

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString()
  return Math.abs(value) >= 100
    ? value.toLocaleString(undefined, { maximumFractionDigits: 1 })
    : value.toLocaleString(undefined, { maximumFractionDigits: 3 })
}
