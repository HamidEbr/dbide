/**
 * A line diff for "local history": what changed between two versions of a script. Myers'
 * O(ND) algorithm after trimming the lines the two versions share at both ends, which for a
 * typical edit leaves almost nothing to compare.
 */

export type DiffKind = 'same' | 'add' | 'del'

export interface DiffLine {
  kind: DiffKind
  text: string
  /** 1-based line number in the old text. Null for added lines. */
  oldNo: number | null
  /** 1-based line number in the new text. Null for deleted lines. */
  newNo: number | null
}

/** Beyond this many edits the diff is not worth computing; the changed middle is shown as replaced. */
const MAX_EDITS = 1000

const splitLines = (text: string): string[] => (text === '' ? [] : text.split(/\r\n|\r|\n/))

type Op = 'same' | 'add' | 'del'

/** The shortest edit script between two lists, or null when it would take more than `limit` edits. */
function myers(a: string[], b: string[], limit: number): Op[] | null {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map(() => 'add')
  if (m === 0) return a.map(() => 'del')

  const max = Math.min(n + m, limit)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
      let x = down ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, n, m, d, offset)
    }
  }
  return null
}

function backtrack(trace: Int32Array[], n: number, m: number, edits: number, offset: number): Op[] {
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = edits; d > 0; d--) {
    const v = trace[d]!
    const k = x - y
    const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
    const previousK = down ? k + 1 : k - 1
    const previousX = v[offset + previousK]!
    const previousY = previousX - previousK
    while (x > previousX && y > previousY) {
      ops.push('same')
      x--
      y--
    }
    ops.push(down ? 'add' : 'del')
    x = previousX
    y = previousY
  }
  while (x > 0 && y > 0) {
    ops.push('same')
    x--
    y--
  }
  return ops.reverse()
}

/** Line by line differences, in order. Both texts are split on any line ending. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const middleA = a.slice(start, endA)
  const middleB = b.slice(start, endB)
  const ops = myers(middleA, middleB, MAX_EDITS) ??
    // Too different to align: show the middle as removed, then added.
    [...middleA.map((): Op => 'del'), ...middleB.map((): Op => 'add')]

  const lines: DiffLine[] = []
  let oldNo = 1
  let newNo = 1
  const push = (kind: DiffKind, text: string): void => {
    lines.push({
      kind,
      text,
      oldNo: kind === 'add' ? null : oldNo,
      newNo: kind === 'del' ? null : newNo,
    })
    if (kind !== 'add') oldNo++
    if (kind !== 'del') newNo++
  }

  for (let i = 0; i < start; i++) push('same', a[i]!)
  let ia = 0
  let ib = 0
  for (const op of ops) {
    if (op === 'same') {
      push('same', middleA[ia]!)
      ia++
      ib++
    } else if (op === 'del') {
      push('del', middleA[ia++]!)
    } else {
      push('add', middleB[ib++]!)
    }
  }
  for (let i = endA; i < a.length; i++) push('same', a[i]!)
  return lines
}

export interface DiffStats {
  added: number
  removed: number
}

export function diffStats(lines: readonly DiffLine[]): DiffStats {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'add') added++
    else if (line.kind === 'del') removed++
  }
  return { added, removed }
}

export type DiffBlock =
  | { type: 'lines'; lines: DiffLine[] }
  /** A run of unchanged lines that is hidden. The lines are kept, so it can be opened. */
  | { type: 'skip'; count: number; lines: DiffLine[] }

/** Hides unchanged lines further than `context` lines from a change. */
export function collapseUnchanged(lines: readonly DiffLine[], context = 3): DiffBlock[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.kind === 'same') return
    for (
      let i = Math.max(0, index - context);
      i <= Math.min(lines.length - 1, index + context);
      i++
    ) {
      keep[i] = true
    }
  })

  const blocks: DiffBlock[] = []
  let run: DiffLine[] = []
  let skipped: DiffLine[] = []
  const closeRun = (): void => {
    if (run.length > 0) blocks.push({ type: 'lines', lines: run })
    run = []
  }
  const closeSkip = (): void => {
    if (skipped.length > 0) blocks.push({ type: 'skip', count: skipped.length, lines: skipped })
    skipped = []
  }

  lines.forEach((line, index) => {
    if (keep[index]) {
      closeSkip()
      run.push(line)
    } else {
      closeRun()
      skipped.push(line)
    }
  })
  closeRun()
  closeSkip()
  return blocks
}
