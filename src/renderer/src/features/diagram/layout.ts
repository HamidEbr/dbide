/**
 * Placing tables on a page for an ER diagram. A table that others point at (through a foreign key) goes to the
 * left of the ones that point at it, so the diagram reads left to right from reference data to the tables built on
 * it. Tables with no relations go in a grid below.
 */

export interface DiagramColumn {
  name: string
  type: string
  key: '' | 'PRI' | 'UNI' | 'MUL'
}

export interface DiagramTable {
  name: string
  view: boolean
  columns: DiagramColumn[]
}

export interface DiagramLink {
  table: string
  column: string
  refTable: string
  refColumn: string
}

export interface Placed {
  table: DiagramTable
  x: number
  y: number
  w: number
  h: number
  /** Columns drawn, and how many were left out of the box. */
  shown: DiagramColumn[]
  hidden: number
}

export interface PlacedLink extends DiagramLink {
  /** Where the line starts (on the table holding the key) and ends (on the table it points at). */
  from: { x: number; y: number; side: 'left' | 'right' }
  to: { x: number; y: number; side: 'left' | 'right' }
  self: boolean
}

export interface Layout {
  tables: Placed[]
  links: PlacedLink[]
  width: number
  height: number
}

export const HEADER_H = 28
export const ROW_H = 18
export const MAX_COLUMNS_SHOWN = 14
const GAP_X = 130
const GAP_Y = 28
const MARGIN = 24

const charWidth = 7.2

function size(
  table: DiagramTable,
  showColumns: boolean,
): Pick<Placed, 'w' | 'h' | 'shown' | 'hidden'> {
  let shown: DiagramColumn[] = []
  let hidden = 0
  if (showColumns) {
    // Keys first, so a long table still shows what links it.
    const keys = table.columns.filter((c) => c.key !== '')
    const rest = table.columns.filter((c) => c.key === '')
    const ordered = table.columns.length <= MAX_COLUMNS_SHOWN ? table.columns : [...keys, ...rest]
    shown = ordered.slice(0, MAX_COLUMNS_SHOWN)
    hidden = table.columns.length - shown.length
  }
  const widest = Math.max(
    table.name.length + 2,
    ...shown.map((c) => c.name.length + c.type.length + 6),
    hidden > 0 ? 12 : 0,
  )
  return {
    w: Math.max(150, Math.round(widest * charWidth + 28)),
    h: HEADER_H + (shown.length + (hidden > 0 ? 1 : 0)) * ROW_H + 6,
    shown,
    hidden,
  }
}

/** The layer of each table: one more than the deepest table it points at. Cycles are cut where they close. */
function layers(names: string[], links: DiagramLink[]): Map<string, number> {
  const refs = new Map<string, Set<string>>(names.map((n) => [n, new Set()]))
  for (const l of links) if (l.table !== l.refTable) refs.get(l.table)?.add(l.refTable)
  const rank = new Map<string, number>()
  const visiting = new Set<string>()
  const visit = (name: string): number => {
    const known = rank.get(name)
    if (known !== undefined) return known
    if (visiting.has(name)) return 0
    visiting.add(name)
    let r = 0
    for (const ref of refs.get(name) ?? []) r = Math.max(r, visit(ref) + 1)
    visiting.delete(name)
    rank.set(name, r)
    return r
  }
  for (const n of names) visit(n)
  return rank
}

export function layoutDiagram(
  tables: DiagramTable[],
  allLinks: DiagramLink[],
  options: { showColumns: boolean } = { showColumns: true },
): Layout {
  const byName = new Map(tables.map((t) => [t.name, t]))
  // Only links between tables that are on the page.
  const links = allLinks.filter((l) => byName.has(l.table) && byName.has(l.refTable))
  const connected = new Set(links.flatMap((l) => [l.table, l.refTable]))
  const related = tables.filter((t) => connected.has(t.name))
  const loose = tables.filter((t) => !connected.has(t.name))

  const rank = layers(
    related.map((t) => t.name),
    links,
  )
  const columns: DiagramTable[][] = []
  for (const t of related) (columns[rank.get(t.name) ?? 0] ??= []).push(t)

  // Order within a layer by where the tables they relate to sit in the layer before.
  const order = new Map<string, number>()
  columns.forEach((layer, li) => {
    if (!layer) return
    if (li === 0) layer.sort((a, b) => a.name.localeCompare(b.name))
    else {
      const centre = (t: DiagramTable): number => {
        const near = links
          .filter((l) => l.table === t.name && l.refTable !== t.name)
          .map((l) => order.get(l.refTable))
          .filter((n): n is number => n !== undefined)
        return near.length ? near.reduce((a, b) => a + b, 0) / near.length : Number.MAX_SAFE_INTEGER
      }
      layer.sort((a, b) => centre(a) - centre(b) || a.name.localeCompare(b.name))
    }
    layer.forEach((t, i) => order.set(t.name, i))
  })

  const placed = new Map<string, Placed>()
  let x = MARGIN
  let height = MARGIN
  for (const layer of columns) {
    if (!layer || layer.length === 0) continue
    const sized = layer.map((t) => ({ t, ...size(t, options.showColumns) }))
    const w = Math.max(...sized.map((s) => s.w))
    let y = MARGIN
    for (const s of sized) {
      placed.set(s.t.name, { table: s.t, x, y, w: s.w, h: s.h, shown: s.shown, hidden: s.hidden })
      y += s.h + GAP_Y
    }
    height = Math.max(height, y)
    x += w + GAP_X
  }
  let width = Math.max(x - GAP_X + MARGIN, MARGIN * 2)

  // Tables with nothing to relate to: a grid under the rest, as wide as the diagram (or a sensible width).
  if (loose.length > 0) {
    const sized = loose.map((t) => ({ t, ...size(t, options.showColumns) }))
    const rowWidth = Math.max(width, 900)
    let lx = MARGIN
    let ly = height + (related.length > 0 ? MARGIN : 0)
    let rowH = 0
    for (const s of sized) {
      if (lx + s.w > rowWidth && lx > MARGIN) {
        lx = MARGIN
        ly += rowH + GAP_Y
        rowH = 0
      }
      placed.set(s.t.name, {
        table: s.t,
        x: lx,
        y: ly,
        w: s.w,
        h: s.h,
        shown: s.shown,
        hidden: s.hidden,
      })
      lx += s.w + GAP_Y
      rowH = Math.max(rowH, s.h)
      width = Math.max(width, lx)
    }
    height = ly + rowH + MARGIN
  } else {
    height += MARGIN - GAP_Y
  }

  const rowY = (p: Placed, column: string): number => {
    const i = p.shown.findIndex((c) => c.name === column)
    return p.y + (i >= 0 ? HEADER_H + i * ROW_H + ROW_H / 2 : HEADER_H / 2)
  }
  const placedLinks: PlacedLink[] = links.map((l) => {
    const from = placed.get(l.table)!
    const to = placed.get(l.refTable)!
    const self = l.table === l.refTable
    // The table that points sits to the right of the one it points at, so the line leaves its left side.
    const fromLeft = !self && from.x > to.x
    const toRight = !self && from.x > to.x
    return {
      ...l,
      self,
      from: {
        x: fromLeft ? from.x : from.x + from.w,
        y: rowY(from, l.column),
        side: fromLeft ? 'left' : 'right',
      },
      to: {
        x: toRight ? to.x + to.w : to.x,
        y: rowY(to, l.refColumn),
        side: toRight ? 'right' : 'left',
      },
    }
  })
  return { tables: [...placed.values()], links: placedLinks, width, height }
}
