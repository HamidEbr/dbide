import { describe, expect, it } from 'vitest'
import { collapseUnchanged, diffLines, diffStats, type DiffLine } from './diff'

const oldSide = (lines: DiffLine[]): string[] =>
  lines.filter((l) => l.kind !== 'add').map((l) => l.text)
const newSide = (lines: DiffLine[]): string[] =>
  lines.filter((l) => l.kind !== 'del').map((l) => l.text)

/** Length of the longest common subsequence, to check the diff is as short as it can be. */
function lcs(a: string[], b: string[]): number {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      table[i]![j] =
        a[i - 1] === b[j - 1]
          ? table[i - 1]![j - 1]! + 1
          : Math.max(table[i - 1]![j]!, table[i]![j - 1]!)
    }
  }
  return table[a.length]![b.length]!
}

describe('diffLines', () => {
  it('reports no change for equal text', () => {
    const lines = diffLines('a\nb', 'a\nb')
    expect(lines.every((l) => l.kind === 'same')).toBe(true)
    expect(diffStats(lines)).toEqual({ added: 0, removed: 0 })
  })

  it('finds a changed line', () => {
    const lines = diffLines('SELECT 1;\nSELECT 2;\nSELECT 3;', 'SELECT 1;\nSELECT 20;\nSELECT 3;')
    expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      'same:SELECT 1;',
      'del:SELECT 2;',
      'add:SELECT 20;',
      'same:SELECT 3;',
    ])
  })

  it('numbers lines on each side', () => {
    const lines = diffLines('a\nb\nc', 'a\nc\nd')
    expect(lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ['same', 1, 1],
      ['del', 2, null],
      ['same', 3, 2],
      ['add', null, 3],
    ])
  })

  it('handles empty sides', () => {
    expect(diffStats(diffLines('', 'a\nb'))).toEqual({ added: 2, removed: 0 })
    expect(diffStats(diffLines('a\nb', ''))).toEqual({ added: 0, removed: 2 })
    expect(diffLines('', '')).toEqual([])
  })

  it('treats every line ending the same', () => {
    expect(diffStats(diffLines('a\r\nb\r\nc', 'a\nb\nc'))).toEqual({ added: 0, removed: 0 })
  })

  it('rebuilds both sides and finds the shortest script for random edits', () => {
    let seed = 7
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: random(14) }, () => `l${random(5)}`)
      const b = Array.from({ length: random(14) }, () => `l${random(5)}`)
      const lines = diffLines(a.join('\n'), b.join('\n'))
      expect(oldSide(lines)).toEqual(a)
      expect(newSide(lines)).toEqual(b)
      const { added, removed } = diffStats(lines)
      expect(added + removed).toBe(a.length + b.length - 2 * lcs(a, b))
    }
  })

  it('still answers, correctly, when the texts are too different to align', () => {
    const a = Array.from({ length: 1500 }, (_, i) => `old ${i}`)
    const b = Array.from({ length: 1500 }, (_, i) => `new ${i}`)
    const lines = diffLines(a.join('\n'), b.join('\n'))
    expect(oldSide(lines)).toEqual(a)
    expect(newSide(lines)).toEqual(b)
  })

  it('is quick on a large script with one edit', () => {
    const base = Array.from({ length: 50_000 }, (_, i) => `SELECT ${i};`)
    const edited = [...base]
    edited[25_000] = 'SELECT changed;'
    const started = performance.now()
    const stats = diffStats(diffLines(base.join('\n'), edited.join('\n')))
    expect(stats).toEqual({ added: 1, removed: 1 })
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('collapseUnchanged', () => {
  it('keeps context around a change and hides the rest', () => {
    const base = Array.from({ length: 20 }, (_, i) => `line ${i}`)
    const edited = [...base]
    edited[10] = 'changed'
    const blocks = collapseUnchanged(diffLines(base.join('\n'), edited.join('\n')), 2)
    expect(
      blocks.map((b) => (b.type === 'skip' ? `skip ${b.count}` : `lines ${b.lines.length}`)),
    ).toEqual(['skip 8', 'lines 6', 'skip 7'])
  })

  it('shows everything when the whole text changed', () => {
    const blocks = collapseUnchanged(diffLines('a\nb', 'c\nd'))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe('lines')
  })

  it('returns nothing for no lines', () => {
    expect(collapseUnchanged([])).toEqual([])
  })
})
