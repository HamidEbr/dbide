import { describe, expect, it, vi } from 'vitest'
import type { Cell } from '@shared/query'
import { RowStore, type RowBacking } from './row-store'

const rows = (from: number, count: number): Cell[][] =>
  Array.from({ length: count }, (_, i) => [from + i])

/** A backing that holds `total` rows, numbered from `base`, and answers when told to. */
function backing(total: number, base: number) {
  const calls: { from: number; count: number }[] = []
  const waiting: (() => void)[] = []
  let failing = false
  const api: RowBacking = {
    fetch: (from, count) => {
      calls.push({ from, count })
      return new Promise((resolve, reject) => {
        waiting.push(() => {
          if (failing) reject(new Error('gone'))
          else resolve(rows(base + from, Math.max(0, Math.min(count, total - from))))
        })
      })
    },
    stats: vi.fn(() => Promise.resolve({ numeric: 1, sum: 2, min: 3, max: 4, partial: false })),
  }
  return {
    api,
    calls,
    answer: async () => {
      waiting.splice(0).forEach((resolve) => resolve())
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    fail: (value: boolean) => (failing = value),
  }
}

const immediate = (callback: () => void): void => callback()

function bigStore(resident = 5, held = 100, pageRows = 10, maxPages = 3) {
  const b = backing(held, resident)
  const store = new RowStore(immediate, b.api, pageRows, maxPages)
  store.append(rows(0, resident))
  store.appendSpilled(held)
  return { store, ...b }
}

describe('a result that fits in the window', () => {
  it('reads rows straight from memory and never asks for any', () => {
    const store = new RowStore(immediate)
    store.append(rows(0, 3))
    expect(store.length).toBe(3)
    expect(store.spilled).toBe(0)
    expect(store.getRow(2)).toEqual([2])
    expect(store.getRow(3)).toBeUndefined()
  })
})

describe('a result with rows held by the core', () => {
  it('counts the held rows in its length', () => {
    const { store } = bigStore()
    expect(store.length).toBe(105)
    expect(store.spilled).toBe(100)
    expect(store.rows).toHaveLength(5)
  })

  it('answers nothing for a held row, asks for its page once, and has it when the page arrives', async () => {
    const { store, calls, answer } = bigStore()
    const seen: number[] = []
    store.subscribe(() => seen.push(store.getVersion()))

    expect(store.getRow(7)).toBeUndefined()
    expect(store.getRow(8)).toBeUndefined()
    // Both rows are on the first held page: one request.
    expect(calls).toEqual([{ from: 0, count: 10 }])

    await answer()
    expect(store.getRow(7)).toEqual([7])
    expect(store.getRow(14)).toEqual([14])
    expect(seen.length).toBeGreaterThan(0)
    expect(calls).toHaveLength(1)
  })

  it('finds a row on a later page', async () => {
    const { store, calls, answer } = bigStore()
    expect(store.getRow(5 + 35)).toBeUndefined()
    expect(calls).toEqual([{ from: 30, count: 10 }])
    await answer()
    expect(store.getRow(40)).toEqual([40])
  })

  it('lets go of the page that was used least recently', async () => {
    const { store, calls, answer } = bigStore(5, 100, 10, 3)
    for (const row of [5, 15, 25]) store.getRow(row)
    await answer()
    store.getRow(5) // the first page is used again, so the second is now the oldest
    store.getRow(35)
    await answer()
    expect(store.peekRow(15)).toBeUndefined()
    expect(store.peekRow(5)).toEqual([5])
    expect(store.peekRow(35)).toEqual([35])
    // Looking again at the one that was let go asks for it again.
    store.getRow(15)
    expect(calls.at(-1)).toEqual({ from: 10, count: 10 })
  })

  it('peeks without asking', () => {
    const { store, calls } = bigStore()
    expect(store.peekRow(50)).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('does not ask again right after a page failed, but does later', async () => {
    const { store, calls, answer, fail } = bigStore()
    fail(true)
    store.getRow(10)
    await answer()
    store.getRow(10)
    await answer()
    expect(calls).toHaveLength(1)

    fail(false)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 4000)
    try {
      store.getRow(10)
    } finally {
      vi.useRealTimers()
    }
    await answer()
    expect(calls).toHaveLength(2)
    expect(store.getRow(10)).toEqual([10])
  })

  it('does nothing for a held row when there is no backing', () => {
    const store = new RowStore(immediate)
    store.append(rows(0, 2))
    store.appendSpilled(5)
    expect(store.getRow(4)).toBeUndefined()
  })

  it('keeps edits to the rows it holds, and removing rows moves the held ones up', async () => {
    const { store, answer } = bigStore()
    store.setCells(1, { 0: 'edited' })
    expect(store.getRow(1)).toEqual(['edited'])
    store.removeRows([0])
    expect(store.rows).toHaveLength(4)
    expect(store.length).toBe(104)
    // The first held row is now the one after the last row the window holds.
    store.getRow(4)
    await answer()
    expect(store.getRow(4)).toEqual([5])
  })
})

describe('readRange', () => {
  it('reads across the rows it holds and the ones the core holds, in order', async () => {
    const { store, answer } = bigStore()
    const read = store.readRange(3, 14)
    await answer()
    await answer()
    expect((await read).map((r) => r[0])).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
  })

  it('stops at the end of the result', async () => {
    const { store, answer } = bigStore()
    const read = store.readRange(100, 500)
    await answer()
    await answer()
    expect((await read).map((r) => r[0])).toEqual([100, 101, 102, 103, 104])
  })

  it('does not need the core for rows the window holds', async () => {
    const { store, calls } = bigStore()
    expect((await store.readRange(1, 3)).map((r) => r[0])).toEqual([1, 2, 3])
    expect(calls).toEqual([])
  })

  it('uses a page that is already at hand', async () => {
    const { store, calls, answer } = bigStore()
    store.getRow(6)
    await answer()
    const before = calls.length
    expect((await store.readRange(6, 8)).map((r) => r[0])).toEqual([6, 7, 8])
    expect(calls).toHaveLength(before)
  })
})

describe('heldTotals', () => {
  it('asks the core about the part of a range that it holds, by position in the held part', async () => {
    const { store, api } = bigStore()
    const result = await store.heldTotals(3, 20, [{ index: 0, type: 'int' }])
    expect(result).toMatchObject({ numeric: 1, partial: false })
    expect(api.stats).toHaveBeenCalledWith(0, 16, [{ index: 0, type: 'int' }])
    await store.heldTotals(10, 12, [])
    expect(api.stats).toHaveBeenLastCalledWith(5, 3, [])
  })

  it('has nothing to ask when the range is all in the window', async () => {
    const { store, api } = bigStore()
    expect(await store.heldTotals(0, 4, [])).toBeNull()
    expect(api.stats).not.toHaveBeenCalled()
  })
})
