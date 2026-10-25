import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Cell } from '@shared/query'
import { SpillStore, type SpillOwner } from './spill'

let root: string
let store: SpillStore

const owner = (key: string, script = 's1', run = 'r1'): SpillOwner => ({ script, run, key })
const numbers = (from: number, count: number): Cell[][] =>
  Array.from({ length: count }, (_, i) => [from + i, `row ${from + i}`])

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dbide-spill-'))
  store = new SpillStore(join(root, 'spill'))
})
afterEach(() => {
  try {
    store.close()
  } catch {
    // Already closed by the test.
  }
  rmSync(root, { recursive: true, force: true })
})

describe('SpillStore', () => {
  it('gives back the rows it was given, in order, in pages', () => {
    store.append(owner('a'), 0, numbers(0, 2500))
    expect(store.fetch('a', 0, 3)).toEqual(numbers(0, 3))
    expect(store.fetch('a', 1000, 2)).toEqual(numbers(1000, 2))
    expect(store.fetch('a', 2498, 10)).toEqual(numbers(2498, 2))
    expect(store.fetch('a', 5000, 10)).toEqual([])
    expect(store.count('a')).toBe(2500)
  })

  it('takes rows in several batches and keeps their positions', () => {
    store.append(owner('a'), 0, numbers(0, 3))
    store.append(owner('a'), 3, numbers(3, 3))
    expect(store.fetch('a', 0, 10)).toEqual(numbers(0, 6))
  })

  it('keeps every kind of cell exactly: NULL, booleans, numbers, text, and bytes', () => {
    const row: Cell[] = [
      null,
      true,
      false,
      0,
      -1.5,
      9007199254740993n.toString(),
      'ü 日本語 🎉',
      '',
      new Uint8Array([0, 1, 255]),
    ]
    store.append(owner('a'), 0, [row])
    const back = store.fetch('a', 0, 1)[0]!
    expect(back.slice(0, 8)).toEqual(row.slice(0, 8))
    expect([...(back[8] as Uint8Array)]).toEqual([0, 1, 255])
  })

  it('keeps results apart', () => {
    store.append(owner('a'), 0, numbers(0, 2))
    store.append(owner('b'), 0, numbers(100, 2))
    expect(store.fetch('a', 0, 5)).toEqual(numbers(0, 2))
    expect(store.fetch('b', 0, 5)).toEqual(numbers(100, 2))
    expect(store.fetch('missing', 0, 5)).toEqual([])
  })

  it('lets go of what an earlier run held, but not the run that is current or other scripts', () => {
    store.append(owner('old', 's1', 'r1'), 0, numbers(0, 3))
    store.append(owner('new', 's1', 'r2'), 0, numbers(0, 3))
    store.append(owner('other', 's2', 'r9'), 0, numbers(0, 3))
    store.dropOtherRuns('s1', 'r2')
    expect(store.count('old')).toBe(0)
    expect(store.count('new')).toBe(3)
    expect(store.count('other')).toBe(3)
  })

  it('lets go of everything a script holds', () => {
    store.append(owner('a', 's1'), 0, numbers(0, 3))
    store.append(owner('b', 's1', 'r2'), 0, numbers(0, 3))
    store.append(owner('c', 's2'), 0, numbers(0, 3))
    store.dropScript('s1')
    expect([store.count('a'), store.count('b'), store.count('c')]).toEqual([0, 0, 3])
  })

  it('adds up the numbers in a block of rows, reading text in numeric columns as numbers', () => {
    const rows: Cell[][] = [
      [1, '2.5', 'x'],
      [3, 'n/a', 'y'],
      [null, '4', 'z'],
    ]
    store.append(owner('a'), 0, rows)
    const { totals, partial } = store.totals('a', 0, 3, [
      { index: 0, type: 'int' },
      { index: 1, type: 'decimal' },
      { index: 2, type: 'varchar' },
    ])
    expect(partial).toBe(false)
    expect(totals).toEqual({ numeric: 4, sum: 10.5, min: 1, max: 4 })
  })

  it('stops adding up after the limit and says so', () => {
    store.append(owner('a'), 0, numbers(0, 100))
    const { totals, partial } = store.totals('a', 0, 100, [{ index: 0, type: 'int' }], 10)
    expect(partial).toBe(true)
    expect(totals.numeric).toBe(10)
  })

  it('refuses to fill the disk, and keeps what it already had', () => {
    const small = new SpillStore(join(root, 'small'), 2000)
    try {
      small.append(owner('a'), 0, numbers(0, 5))
      expect(() => small.append(owner('b'), 0, numbers(0, 1000))).toThrow(/too much disk space/)
      expect(small.count('a')).toBe(5)
      expect(small.count('b')).toBe(0)
    } finally {
      small.close()
    }
  })

  it('gives space back when a run is let go, so the limit is about what is held now', () => {
    const small = new SpillStore(join(root, 'small2'), 3000)
    try {
      small.append(owner('a', 's1', 'r1'), 0, numbers(0, 100))
      expect(() => small.append(owner('b', 's1', 'r2'), 0, numbers(0, 100))).toThrow(/too much/)
      small.dropOtherRuns('s1', 'r2')
      small.append(owner('b', 's1', 'r2'), 0, numbers(0, 100))
      expect(small.count('b')).toBe(100)
    } finally {
      small.close()
    }
  })

  it('starts empty even if an earlier run left files behind, and removes them when closed', () => {
    store.append(owner('a'), 0, numbers(0, 3))
    const again = new SpillStore(store.dir)
    expect(again.count('a')).toBe(0)
    again.close()
    expect(existsSync(store.dir)).toBe(false)
  })

  it('reads a range that starts and ends inside different pieces', () => {
    store.append(owner('a'), 0, numbers(0, 7))
    store.append(owner('a'), 7, numbers(7, 7))
    store.append(owner('a'), 14, numbers(14, 7))
    expect(store.fetch('a', 5, 11).map((r) => r[0])).toEqual([
      5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ])
    expect(store.fetch('a', 13, 2).map((r) => r[0])).toEqual([13, 14])
    expect(store.count('a')).toBe(21)
  })

  it('stores rows with enormous cells in smaller pieces', () => {
    const big = 'x'.repeat(20 * 1024 * 1024)
    const rows: Cell[][] = [[big], [big], [big], [big]]
    store.append(owner('huge'), 0, rows)
    expect(store.count('huge')).toBe(4)
    expect(store.fetch('huge', 3, 1)[0]![0]).toBe(big)
  })

  it('appends nothing for no rows', () => {
    store.append(owner('a'), 0, [])
    expect(store.count('a')).toBe(0)
  })

  it('holds a lot of rows', () => {
    for (let b = 0; b < 100; b++) store.append(owner('big'), b * 1000, numbers(b * 1000, 1000))
    expect(store.count('big')).toBe(100_000)
    expect(store.fetch('big', 99_999, 1)).toEqual(numbers(99_999, 1))
  })
})
