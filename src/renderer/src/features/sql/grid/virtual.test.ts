import { describe, expect, it } from 'vitest'
import { columnStarts, visibleColumns } from './virtual'

const same = (count: number, width = 100): number[] => Array.from({ length: count }, () => width)

describe('columnStarts', () => {
  it('lists where each column begins, and where the last one ends', () => {
    expect(columnStarts([10, 20, 30])).toEqual([0, 10, 30, 60])
    expect(columnStarts([])).toEqual([0])
  })
})

describe('visibleColumns', () => {
  const gutter = 56

  it('draws everything when everything fits', () => {
    const starts = columnStarts(same(5))
    expect(visibleColumns(starts, 0, 800, gutter, 0)).toEqual({ first: 0, last: 5, offset: 0 })
  })

  it('draws only the columns on screen, plus room on each side', () => {
    const starts = columnStarts(same(1000))
    const view = visibleColumns(starts, 0, 1000, gutter, 0)
    expect(view.first).toBe(0)
    // 1000 px of viewport minus the 56 px gutter shows 9.44 columns, so ten are touched.
    expect(view.last).toBe(10)

    const roomy = visibleColumns(starts, 0, 1000, gutter, 320)
    expect(roomy.last).toBe(13)
  })

  it('follows the scroll position and reports where the first drawn column starts', () => {
    const starts = columnStarts(same(1000))
    const view = visibleColumns(starts, 50_000, 1000, gutter, 0)
    expect(view.first).toBe(500)
    expect(view.offset).toBe(50_000)
    expect(view.last).toBe(510)
  })

  it('does not draw a column that is entirely hidden behind the left edge', () => {
    const starts = columnStarts(same(100))
    // Scrolled exactly one column: column 0 ends at the left edge of the scroller.
    expect(visibleColumns(starts, 100, 800, gutter, 0).first).toBe(1)
    expect(visibleColumns(starts, 99, 800, gutter, 0).first).toBe(0)
  })

  it('copes with columns of different widths', () => {
    const starts = columnStarts([48, 400, 48, 48, 900, 48])
    const view = visibleColumns(starts, 440, 300, gutter, 0)
    // Column 1 spans 48–448, so it is still in view at 440. The viewport reaches 684 once the
    // gutter is taken off, and column 4 starts at 544, so it is drawn too. Column 5 is not.
    expect(view.first).toBe(1)
    expect(view.last).toBe(5)
  })

  it('draws the last columns at the end of a wide result and never runs past it', () => {
    const starts = columnStarts(same(300))
    const view = visibleColumns(starts, 300 * 100 - 900, 900, gutter, 320)
    expect(view.last).toBe(300)
    expect(view.first).toBeGreaterThan(280)
  })

  it('has nothing to draw for no columns, and always one column for one', () => {
    expect(visibleColumns(columnStarts([]), 0, 500, gutter)).toEqual({
      first: 0,
      last: 0,
      offset: 0,
    })
    expect(visibleColumns(columnStarts([200]), 5000, 500, gutter)).toEqual({
      first: 0,
      last: 1,
      offset: 0,
    })
  })
})
