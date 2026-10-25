export interface ColumnWindow {
  /** The first column to draw. */
  first: number
  /** One past the last column to draw. */
  last: number
  /** How far from the left edge of the columns the first drawn column starts, in pixels. */
  offset: number
}

/** The start of each column, plus the end of the last one. `starts[i]` is where column `i` begins. */
export function columnStarts(widths: readonly number[]): number[] {
  const starts = new Array<number>(widths.length + 1)
  let x = 0
  for (let i = 0; i < widths.length; i++) {
    starts[i] = x
    x += widths[i]!
  }
  starts[widths.length] = x
  return starts
}

/** The first index in `starts` (0..length-1) whose column ends after `x`. */
function firstEndingAfter(starts: readonly number[], x: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (starts[mid + 1]! > x) high = mid
    else low = mid + 1
  }
  return low
}

/**
 * The columns that have to be drawn for the part of the grid on screen, with some room on both
 * sides so a fast scroll doesn't show blanks. Columns are laid out after a fixed gutter on the
 * left, and the gutter stays in view, so it covers the first `gutter` pixels of the viewport.
 */
export function visibleColumns(
  starts: readonly number[],
  scrollLeft: number,
  viewportWidth: number,
  gutter: number,
  overscan = 320,
): ColumnWindow {
  const count = starts.length - 1
  if (count <= 0) return { first: 0, last: 0, offset: 0 }

  // In column space: x = 0 is where the first column begins.
  const left = Math.max(0, scrollLeft - overscan)
  const right = scrollLeft + viewportWidth - gutter + overscan

  const first = Math.min(count - 1, firstEndingAfter(starts, left))
  let last = first
  while (last < count && starts[last]! < right) last++
  return { first, last: Math.max(last, first + 1), offset: starts[first]! }
}
