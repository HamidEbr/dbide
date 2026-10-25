import { describe, expect, it } from 'vitest'
import type { Cell } from '@shared/query'
import { ColumnScanner, MAX_COLUMNS, columnWidth } from './columns'

const row = (document: unknown): Cell[] => [JSON.stringify(document)]
const int = (n: number) => ({ $numberInt: String(n) })

describe('ColumnScanner', () => {
  it('finds the fields in the order they appear, with _id first wherever it turned up', () => {
    const scanner = new ColumnScanner()
    scanner.scan([row({ name: 'a', _id: int(1) }), row({ _id: int(2), age: int(3), name: 'b' })])
    expect(scanner.columns().map((c) => c.path)).toEqual(['_id', 'name', 'age'])
  })

  it('notes every type a field has had, so a column that mixes them says so', () => {
    const scanner = new ColumnScanner()
    scanner.scan([
      row({ _id: int(1), v: 'text' }),
      row({ _id: int(2), v: int(5) }),
      row({ _id: int(3), v: null }),
    ])
    expect(scanner.columns().find((c) => c.path === 'v')?.types).toEqual(['string', 'int', 'null'])
  })

  it('reads only what it has not read, and hands out the same list until something changes', () => {
    const scanner = new ColumnScanner()
    const rows: Cell[][] = [row({ _id: int(1), a: 'x' })]
    scanner.scan(rows)
    const first = scanner.columns()
    rows.push(row({ _id: int(2), a: 'y' }))
    expect(scanner.scan(rows)).toBe(false)
    expect(scanner.columns()).toBe(first)
    rows.push(row({ _id: int(3), b: 'z' }))
    expect(scanner.scan(rows)).toBe(true)
    expect(scanner.columns()).not.toBe(first)
    expect(scanner.columns().map((c) => c.path)).toEqual(['_id', 'a', 'b'])
  })

  it('stands a single column for results that are not documents', () => {
    const scanner = new ColumnScanner()
    scanner.scan([row(int(5)), row('text'), row([1, 2])])
    expect(scanner.columns()).toEqual([{ path: 'value', types: ['int', 'string', 'array'] }])
  })

  it('stops at a cap and says how many fields it left out', () => {
    const scanner = new ColumnScanner()
    const wide: Record<string, unknown> = {}
    for (let i = 0; i < MAX_COLUMNS + 7; i++) wide[`f${i}`] = i
    scanner.scan([row(wide)])
    expect(scanner.columns()).toHaveLength(MAX_COLUMNS)
    expect(scanner.hidden).toBe(7)
  })

  it('skips cells that are not JSON, and works through a big result in passes', () => {
    const scanner = new ColumnScanner()
    const rows: Cell[][] = [
      ['not json'],
      [null],
      ...Array.from({ length: 4000 }, (_, i) => row({ _id: int(i) })),
    ]
    scanner.scan(rows)
    expect(scanner.behind(rows.length)).toBe(true)
    while (scanner.behind(rows.length)) scanner.scan(rows)
    expect(scanner.columns().map((c) => c.path)).toEqual(['_id'])
  })
})

describe('columnWidth', () => {
  it('fits the name and a sample of the values, within limits', () => {
    expect(columnWidth('a', ['x'])).toBe(96)
    expect(columnWidth('a', ['x'.repeat(30)])).toBeGreaterThan(200)
    expect(columnWidth('a', ['x'.repeat(500)])).toBeLessThanOrEqual(340)
  })
})
