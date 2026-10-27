import { describe, expect, it } from 'vitest'
import { buildChart, niceTicks } from './chart'
import { compareResults } from './compare'
import { buildPivot } from './pivot'

const sales = [
  ['north', '2025', 10],
  ['north', '2026', 30],
  ['south', '2025', 5],
  ['south', '2026', null],
  ['south', '2026', 7],
] as const

describe('buildPivot', () => {
  it('groups rows by two columns and totals each way', () => {
    const p = buildPivot(sales, { rows: 0, columns: 1, value: 2, aggregate: 'sum' })
    expect(p.rowLabels).toEqual(['north', 'south'])
    expect(p.columnLabels).toEqual(['2025', '2026'])
    expect(p.cells).toEqual([
      [10, 30],
      [5, 7],
    ])
    expect(p.rowTotals).toEqual([40, 12])
    expect(p.columnTotals).toEqual([15, 37])
    expect(p.total).toBe(52)
  })

  it('counts rows, including those with no number, and averages only the numbers', () => {
    expect(
      buildPivot(sales, { rows: 0, columns: null, value: null, aggregate: 'count' }).cells,
    ).toEqual([[2], [3]])
    const avg = buildPivot(sales, { rows: 0, columns: null, value: 2, aggregate: 'avg' })
    expect(avg.cells).toEqual([[20], [6]])
    expect(avg.total).toBeCloseTo(13)
    expect(buildPivot(sales, { rows: 0, columns: 1, value: 2, aggregate: 'max' }).cells[1]).toEqual(
      [5, 7],
    )
  })

  it('writes a missing combination as null, orders labels as numbers when they are, and labels NULL', () => {
    const p = buildPivot(
      [
        ['b', 10],
        ['a', 2],
        [null, 1],
      ],
      { rows: 1, columns: 0, value: null, aggregate: 'count' },
    )
    expect(p.rowLabels).toEqual(['1', '2', '10'])
    expect(p.columnLabels).toEqual(['a', 'b', 'NULL'])
    expect(p.cells[0]).toEqual([null, null, 1])
  })
})

describe('buildChart', () => {
  it('sums a measure by a category, in label order for bars and largest first for a pie', () => {
    const bar = buildChart(sales, { kind: 'bar', x: 0, y: 2, aggregate: 'sum' })
    expect(bar.points).toEqual([
      { label: 'north', value: 40 },
      { label: 'south', value: 12 },
    ])
    const pie = buildChart(sales, { kind: 'pie', x: 1, y: null, aggregate: 'sum' })
    expect(pie.points.map((p) => p.label)).toEqual(['2026', '2025'])
    expect(pie.points[0]!.value).toBe(3)
  })

  it('keeps a line in the order of its axis, and says what it left out', () => {
    const rows = Array.from({ length: 600 }, (_, i) => [String(600 - i), i])
    const line = buildChart(rows, { kind: 'line', x: 0, y: 1, aggregate: 'sum' })
    expect(line.points[0]!.label).toBe('1')
    expect(line.points).toHaveLength(500)
    expect(line.omitted).toBe(100)
    const bars = buildChart(rows, { kind: 'bar', x: 0, y: 1, aggregate: 'sum' })
    expect(bars.points).toHaveLength(40)
    expect(bars.omitted).toBe(560)
  })
})

describe('niceTicks', () => {
  it('gives round numbers from zero up past the highest value', () => {
    expect(niceTicks(0, 97)).toEqual([0, 20, 40, 60, 80, 100])
    expect(niceTicks(-5, 5)).toContain(0)
    expect(niceTicks(0, 0)).toEqual([0])
  })
})

describe('compareResults', () => {
  const a = {
    columns: ['id', 'name', 'qty'],
    rows: [
      [1, 'ann', 5],
      [2, 'bob', 7],
      [3, 'cy', 1],
    ],
  }
  const b = {
    columns: ['ID', 'name', 'extra'],
    rows: [
      ['1', 'ann', 'x'],
      ['2', 'bobby', 'y'],
      ['4', 'di', 'z'],
    ],
  }

  it('finds rows added, removed and changed by key, over the columns both have', () => {
    const c = compareResults(a, b, ['id'])
    expect(c.columns).toEqual(['id', 'name'])
    expect(c.onlyA).toEqual(['qty'])
    expect(c.onlyB).toEqual(['extra'])
    expect(c.counts).toEqual({ same: 1, changed: 1, removed: 1, added: 1 })
    const changed = c.rows.find((r) => r.status === 'changed')!
    expect(changed.differs).toEqual([false, true])
    expect(changed.b).toEqual(['2', 'bobby'])
  })

  it('without a key, compares whole rows', () => {
    const c = compareResults(
      { columns: ['x'], rows: [[1], [2]] },
      { columns: ['x'], rows: [[2], [3]] },
      [],
    )
    expect(c.counts).toEqual({ same: 1, changed: 0, removed: 1, added: 1 })
  })

  it('pairs repeated keys in order, and tells NULL from empty text', () => {
    const c = compareResults(
      {
        columns: ['k', 'v'],
        rows: [
          ['a', null],
          ['a', ''],
        ],
      },
      {
        columns: ['k', 'v'],
        rows: [
          ['a', null],
          ['a', null],
        ],
      },
      ['k'],
    )
    expect(c.rows.map((r) => r.status)).toEqual(['same', 'changed'])
  })
})
