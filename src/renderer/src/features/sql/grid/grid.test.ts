import { describe, expect, it, vi } from 'vitest'
import type { ColumnInfo } from '@shared/driver'
import type { Cell } from '@shared/query'
import { formatCopy } from './copy'
import { columnWidth, copyText, displayCell, isNumericType, toHex } from './format'
import { RowStore } from './row-store'
import { normalizeSelection, selectionSize, selectionStats } from './selection'

const col = (name: string, type = 'varchar', table?: string): ColumnInfo => ({
  name,
  type,
  ...(table ? { table } : {}),
})

describe('displayCell', () => {
  it('shows NULL, empty strings, and numbers distinctly', () => {
    expect(displayCell(null, col('a'))).toEqual({ text: 'NULL', kind: 'null' })
    expect(displayCell('', col('a'))).toEqual({ text: '""', kind: 'empty' })
    expect(displayCell(42, col('a', 'int'))).toEqual({ text: '42', kind: 'number' })
  })

  it('treats numeric strings from decimal and bigint columns as numbers', () => {
    expect(displayCell('12.50', col('price', 'decimal')).kind).toBe('number')
    expect(displayCell('9007199254740993', col('id', 'bigint')).kind).toBe('number')
    expect(displayCell('12.50', col('code', 'varchar')).kind).toBe('text')
  })

  it('previews binary values as hex and says how long they are', () => {
    expect(displayCell(new Uint8Array([0xde, 0xad]), col('b', 'blob'))).toEqual({
      text: '0xdead',
      kind: 'binary',
    })
    const long = displayCell(new Uint8Array(40).fill(0xff), col('b', 'blob'))
    expect(long.text).toBe(`0x${'ff'.repeat(16)}… (40 bytes)`)
  })

  it('cuts very long text for display only', () => {
    const text = 'x'.repeat(1000)
    expect(displayCell(text, col('t')).text).toHaveLength(301)
    expect(copyText(text)).toHaveLength(1000)
  })
})

describe('copyText', () => {
  it('copies NULL as empty and binary as full hex', () => {
    expect(copyText(null)).toBe('')
    expect(copyText(new Uint8Array(20).fill(1))).toBe(`0x${'01'.repeat(20)}`)
    expect(copyText(7)).toBe('7')
  })
})

describe('toHex and isNumericType', () => {
  it('pads each byte', () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe('000fff')
    expect(isNumericType('decimal')).toBe(true)
    expect(isNumericType('varchar')).toBe(false)
  })
})

describe('columnWidth', () => {
  it('grows with content but stays within bounds', () => {
    const narrow = columnWidth(col('id', 'int'), [[1], [2]], 0)
    const wide = columnWidth(
      col('note'),
      [['a very long note that goes on and on and on and on']],
      0,
    )
    expect(narrow).toBeGreaterThanOrEqual(72)
    expect(wide).toBeGreaterThan(narrow)
    expect(columnWidth(col('x'), [['y'.repeat(5000)]], 0)).toBe(360)
  })
})

describe('selection', () => {
  it('orders corners and clamps to the grid', () => {
    expect(normalizeSelection({ row: 5, col: 2 }, { row: 1, col: 0 }, 10, 3)).toEqual({
      r1: 1,
      r2: 5,
      c1: 0,
      c2: 2,
    })
    expect(normalizeSelection({ row: 0, col: 0 }, { row: 999, col: 99 }, 10, 3)).toEqual({
      r1: 0,
      r2: 9,
      c1: 0,
      c2: 2,
    })
    expect(normalizeSelection({ row: 0, col: 0 }, { row: 0, col: 0 }, 0, 3)).toBeNull()
  })

  it('counts cells', () => {
    expect(selectionSize({ r1: 0, r2: 2, c1: 1, c2: 2 })).toBe(6)
  })
})

describe('selectionStats', () => {
  const columns = [col('n', 'int'), col('price', 'decimal'), col('name')]
  const rows: Cell[][] = [
    [1, '10.50', 'a'],
    [2, '20.25', 'b'],
    [null, null, 'c'],
    [3, 'not a number', '7'],
  ]
  const getRow = (r: number): Cell[] | undefined => rows[r]

  it('sums, averages, and finds the extremes of numeric cells', () => {
    const stats = selectionStats({ r1: 0, r2: 3, c1: 0, c2: 1 }, getRow, columns)
    expect(stats.cells).toBe(8)
    expect(stats.numeric).toBe(5)
    expect(stats.sum).toBeCloseTo(36.75)
    expect(stats.avg).toBeCloseTo(7.35)
    expect(stats.min).toBe(1)
    expect(stats.max).toBe(20.25)
    expect(stats.partial).toBe(false)
  })

  it('ignores text, NULL, and numeric-looking text in text columns', () => {
    const stats = selectionStats({ r1: 0, r2: 3, c1: 2, c2: 2 }, getRow, columns)
    expect(stats.numeric).toBe(0)
    expect(stats.cells).toBe(4)
    expect(stats.avg).toBe(0)
  })

  it('stops scanning at the limit and says the numbers are partial', () => {
    const big: Cell[][] = Array.from({ length: 100 }, () => [1])
    const stats = selectionStats(
      { r1: 0, r2: 99, c1: 0, c2: 0 },
      (r) => big[r],
      [col('n', 'int')],
      10,
    )
    expect(stats.numeric).toBe(10)
    expect(stats.partial).toBe(true)
  })
})

describe('formatCopy', () => {
  const columns = [
    col('id', 'int', 'users'),
    col('name', 'varchar', 'users'),
    col('avatar', 'blob', 'users'),
  ]
  const rows: Cell[][] = [
    [1, 'Ann', new Uint8Array([1, 2])],
    [2, 'Bob "B"\nSmith', null],
  ]

  it('TSV leaves NULL empty and quotes values with tabs, quotes, or newlines', () => {
    expect(formatCopy('tsv', columns, rows)).toBe('1\tAnn\t0x0102\n2\t"Bob ""B""\nSmith"\t')
  })

  it('TSV and CSV can include headers', () => {
    expect(formatCopy('tsv', columns.slice(0, 2), [[1, 'Ann']], { headers: true })).toBe(
      'id\tname\n1\tAnn',
    )
    expect(formatCopy('csv', columns.slice(0, 2), [[1, 'A,nn']], { headers: true })).toBe(
      'id,name\n1,"A,nn"',
    )
  })

  it('JSON keeps types and renders binary as hex', () => {
    const json = JSON.parse(formatCopy('json', columns, rows)) as Record<string, unknown>[]
    expect(json[0]).toEqual({ id: 1, name: 'Ann', avatar: '0x0102' })
    expect(json[1]).toEqual({ id: 2, name: 'Bob "B"\nSmith', avatar: null })
  })

  it('Markdown escapes pipes and writes NULL', () => {
    expect(
      formatCopy('markdown', columns.slice(0, 2), [
        [1, 'a|b'],
        [2, null],
      ]),
    ).toBe('| id | name |\n| --- | --- |\n| 1 | a\\|b |\n| 2 | NULL |')
  })

  it('SQL INSERT quotes strings, keeps numbers bare, and names the table', () => {
    expect(formatCopy('sql-insert', columns, rows)).toBe(
      [
        "INSERT INTO `users` (`id`, `name`, `avatar`) VALUES (1, 'Ann', 0x0102);",
        'INSERT INTO `users` (`id`, `name`, `avatar`) VALUES (2, \'Bob "B"\nSmith\', NULL);',
      ].join('\n'),
    )
  })

  it('SQL INSERT escapes quotes and backslashes, and leaves decimals unquoted', () => {
    const out = formatCopy(
      'sql-insert',
      [col('p', 'decimal', 't'), col('s', 'varchar', 't')],
      [['9.99', "it's a\\b"]],
    )
    expect(out).toBe("INSERT INTO `t` (`p`, `s`) VALUES (9.99, 'it''s a\\\\b');")
  })

  it('SQL INSERT uses a placeholder when columns come from several tables', () => {
    const out = formatCopy('sql-insert', [col('a', 'int', 't1'), col('b', 'int', 't2')], [[1, 2]])
    expect(out).toContain('INSERT INTO `table_name`')
  })
})

describe('RowStore', () => {
  it('appends rows and tells subscribers once per interval', () => {
    const queued: (() => void)[] = []
    const store = new RowStore((callback) => queued.push(callback))
    const listener = vi.fn()
    store.subscribe(listener)

    store.append([[1], [2]])
    store.append([[3]])
    expect(store.length).toBe(3)
    expect(listener).not.toHaveBeenCalled()
    expect(queued).toHaveLength(1)

    queued.shift()!()
    expect(listener).toHaveBeenCalledOnce()
    expect(store.getVersion()).toBe(1)

    store.append([[4]])
    expect(queued).toHaveLength(1)
  })

  it('overwrites cells in place and tells subscribers', () => {
    const store = new RowStore((callback) => callback())
    const listener = vi.fn()
    store.append([
      ['a', 1],
      ['b', 2],
    ])
    store.subscribe(listener)
    store.setCells(1, { 0: 'B', 1: null })
    expect(store.getRow(1)).toEqual(['B', null])
    expect(listener).toHaveBeenCalledOnce()
    store.setCells(9, { 0: 'x' })
    expect(store.length).toBe(2)
  })

  it('removes rows and closes the gaps', () => {
    const store = new RowStore((callback) => callback())
    store.append([[0], [1], [2], [3], [4]])
    store.removeRows([1, 3])
    expect(store.rows).toEqual([[0], [2], [4]])
    expect(store.length).toBe(3)
    store.removeRows([])
    expect(store.length).toBe(3)
  })

  it('stops notifying after unsubscribe and serves rows by index', () => {
    const store = new RowStore((callback) => callback())
    const listener = vi.fn()
    const off = store.subscribe(listener)
    store.append([['a']])
    expect(listener).toHaveBeenCalledOnce()
    off()
    store.append([['b']])
    expect(listener).toHaveBeenCalledOnce()
    expect(store.getRow(1)).toEqual(['b'])
    expect(store.getRow(9)).toBeUndefined()
  })
})
