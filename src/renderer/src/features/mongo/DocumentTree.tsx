import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { formatShell, isContainer, TYPE_LABELS, typeOf, idOf, type Json } from '@shared/mongo/ejson'
import { DENSITY_ROW_HEIGHT } from '@shared/settings'
import { useData } from '@/state/data'
import { summarize } from './docs'
import { cellView } from './DocumentTable'
import type { RowSelection } from './DocumentTable'
import type { DocumentModel } from './useDocumentModel'

const OVERSCAN = 8
const INDENT = 16

interface FieldRow {
  kind: 'field'
  docIndex: number
  depth: number
  name: string
  value: Json
  isIndex: boolean
  container: boolean
  expanded: boolean
  key: string
}

type FlatRow = { kind: 'doc'; docIndex: number } | FieldRow

const pathKey = (docIndex: number, path: string[]): string =>
  `${docIndex}\u0001${path.join('\u0001')}`

/** The fields of an open document, nested ones included when they are open too. */
function fieldsOf(document: Json, docIndex: number, open: Set<string>): FieldRow[] {
  const out: FieldRow[] = []
  const walk = (value: Json, depth: number, path: string[]): void => {
    const isArray = Array.isArray(value)
    const entries: [string, Json][] = isArray
      ? value.map((item, i): [string, Json] => [String(i), item])
      : Object.entries(value as { [key: string]: Json })
    for (const [name, child] of entries) {
      const childPath = [...path, name]
      const key = pathKey(docIndex, childPath)
      const container = isContainer(child)
      const expanded = container && open.has(key)
      out.push({
        kind: 'field',
        docIndex,
        depth,
        name,
        value: child,
        isIndex: isArray,
        container,
        expanded,
        key,
      })
      if (expanded) walk(child, depth + 1, childPath)
    }
  }
  if (isContainer(document)) walk(document, 0, [])
  else
    out.push({
      kind: 'field',
      docIndex,
      depth: 0,
      name: 'value',
      value: document,
      isIndex: false,
      container: false,
      expanded: false,
      key: pathKey(docIndex, ['value']),
    })
  return out
}

interface TreeProps {
  model: DocumentModel
  selection: RowSelection | null
  onSelect: (selection: RowSelection | null) => void
  onOpen: (row: number) => void
  onDelete: () => void
  onCopy: () => void
  onFocused: () => void
  onBlurred: () => void
}

/**
 * The documents as a tree: each is one line until opened, then its fields, and the fields of nested
 * documents and arrays when those are opened. Only the lines on screen are drawn.
 */
export function DocumentTree({
  model,
  selection,
  onSelect,
  onOpen,
  onDelete,
  onCopy,
  onFocused,
  onBlurred,
}: TreeProps) {
  const density = useData((state) => state.settings.density)
  const rowHeight = DENSITY_ROW_HEIGHT[density]
  const { totalRows, rowAt } = model

  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(0)
  const [openDocs, setOpenDocs] = useState<Set<number>>(() => new Set([0]))
  const [openPaths, setOpenPaths] = useState<Set<string>>(() => new Set())
  const [cursor, setCursor] = useState(0)

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(() => setHeight(element.clientHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // The lines of every open document, rebuilt when the documents or what is open changes.
  const opened = useMemo(() => {
    const list = [...openDocs].filter((d) => d < totalRows).sort((a, b) => a - b)
    const rows = new Map<number, FieldRow[]>()
    for (const d of list) {
      const row = rowAt(d)
      if (row) rows.set(d, fieldsOf(row.document, d, openPaths))
    }
    return { list: list.filter((d) => rows.has(d)), rows }
    // rowAt changes whenever the rows or their edits do.
  }, [openDocs, openPaths, rowAt, totalRows])

  const total = totalRows + [...opened.rows.values()].reduce((sum, rows) => sum + rows.length, 0)

  const flatAt = (index: number): FlatRow => {
    let extra = 0
    for (const d of opened.list) {
      const header = d + extra
      const rows = opened.rows.get(d)!
      if (index < header) return { kind: 'doc', docIndex: index - extra }
      if (index === header) return { kind: 'doc', docIndex: d }
      if (index <= header + rows.length) return rows[index - header - 1]!
      extra += rows.length
    }
    return { kind: 'doc', docIndex: index - extra }
  }

  /** Where a document's own line is, counting the lines of open documents above it. */
  const flatIndexOfDoc = (docIndex: number): number => {
    let extra = 0
    for (const d of opened.list) {
      if (d >= docIndex) break
      extra += opened.rows.get(d)!.length
    }
    return docIndex + extra
  }

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN)
  const last = Math.min(total, Math.ceil((scrollTop + height) / rowHeight) + OVERSCAN)

  const toggleDoc = (docIndex: number, open?: boolean): void =>
    setOpenDocs((current) => {
      const next = new Set(current)
      const want = open ?? !next.has(docIndex)
      if (want) next.add(docIndex)
      else next.delete(docIndex)
      return next
    })

  const togglePath = (key: string, open?: boolean): void =>
    setOpenPaths((current) => {
      const next = new Set(current)
      const want = open ?? !next.has(key)
      if (want) next.add(key)
      else next.delete(key)
      return next
    })

  const ensureVisible = (index: number): void => {
    const element = scroller.current
    if (!element) return
    const top = index * rowHeight
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + rowHeight > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + rowHeight - element.clientHeight
    }
  }

  const select = (index: number, extend: boolean): void => {
    const target = Math.max(0, Math.min(total - 1, index))
    setCursor(target)
    const doc = flatAt(target).docIndex
    onSelect({ anchor: extend && selection ? selection.anchor : doc, focus: doc })
    ensureVisible(target)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (total === 0) return
    const line = flatAt(Math.min(cursor, total - 1))
    const mod = event.metaKey || event.ctrlKey
    switch (event.key) {
      case 'ArrowDown':
        select(cursor + 1, event.shiftKey)
        break
      case 'ArrowUp':
        select(cursor - 1, event.shiftKey)
        break
      case 'Home':
        select(0, event.shiftKey)
        break
      case 'End':
        select(total - 1, event.shiftKey)
        break
      case 'PageDown':
        select(cursor + Math.max(1, Math.floor(height / rowHeight) - 1), event.shiftKey)
        break
      case 'PageUp':
        select(cursor - Math.max(1, Math.floor(height / rowHeight) - 1), event.shiftKey)
        break
      case 'ArrowRight':
        if (line.kind === 'doc') toggleDoc(line.docIndex, true)
        else if (line.container) togglePath(line.key, true)
        break
      case 'ArrowLeft':
        if (line.kind === 'doc') toggleDoc(line.docIndex, false)
        else if (line.container && line.expanded) togglePath(line.key, false)
        else select(flatIndexOfDoc(line.docIndex), false)
        break
      case 'Enter':
        if (line.kind === 'doc') toggleDoc(line.docIndex)
        else if (line.container) togglePath(line.key)
        break
      case ' ':
        onOpen(line.docIndex)
        break
      case 'a':
      case 'A':
        if (!mod) return
        onSelect({ anchor: 0, focus: totalRows - 1 })
        break
      case 'c':
      case 'C':
        if (!mod) return
        onCopy()
        break
      case 'Delete':
      case 'Backspace':
        if (!selection) return
        onDelete()
        break
      case 'Escape':
        onSelect(null)
        break
      default:
        return
    }
    event.preventDefault()
  }

  const rows: number[] = []
  for (let i = first; i < last; i++) rows.push(i)
  const range = selection
    ? {
        r1: Math.min(selection.anchor, selection.focus),
        r2: Math.max(selection.anchor, selection.focus),
      }
    : null

  return (
    <div
      className="doc-tree"
      role="tree"
      aria-label="Documents"
      tabIndex={0}
      ref={scroller}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
      onFocus={(event) => event.target === event.currentTarget && onFocused()}
      onBlur={(event) => event.target === event.currentTarget && onBlurred()}
      style={{ ['--row-h' as string]: `${rowHeight}px` }}
    >
      <div style={{ height: total * rowHeight, position: 'relative' }}>
        <div style={{ transform: `translateY(${first * rowHeight}px)` }}>
          {rows.map((index) => {
            const line = flatAt(index)
            const selected =
              range !== null && line.docIndex >= range.r1 && line.docIndex <= range.r2
            const common = {
              style: { height: rowHeight },
              onMouseDown: (event: React.MouseEvent) => {
                if (event.button !== 0) return
                scroller.current?.focus()
                select(index, event.shiftKey)
              },
            }

            if (line.kind === 'doc') {
              const row = rowAt(line.docIndex)
              if (!row) {
                return (
                  <div
                    key={`pending-${index}`}
                    className="doc-row doc-row-pending"
                    aria-busy="true"
                    style={{ height: rowHeight }}
                  >
                    <span className="doc-row-index">{line.docIndex + 1}</span>
                  </div>
                )
              }
              const open = openDocs.has(line.docIndex)
              const id = idOf(row.document)
              return (
                <div
                  key={row.insertKey ?? `doc-${line.docIndex}`}
                  role="treeitem"
                  aria-expanded={open}
                  aria-selected={selected}
                  className={`doc-row doc-row-head ${selected ? 'selected' : ''} ${index === cursor ? 'cursor' : ''} ${row.state === 'deleted' ? 'row-deleted' : ''} ${row.state === 'changed' ? 'doc-changed' : ''} ${row.state === 'new' ? 'row-new' : ''}`}
                  {...common}
                  onDoubleClick={() => onOpen(line.docIndex)}
                >
                  <button
                    type="button"
                    className="doc-chevron"
                    tabIndex={-1}
                    aria-label={open ? 'Collapse' : 'Expand'}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => toggleDoc(line.docIndex)}
                  >
                    {open ? (
                      <ChevronDown size={13} aria-hidden />
                    ) : (
                      <ChevronRight size={13} aria-hidden />
                    )}
                  </button>
                  <span className="doc-row-index">
                    {row.state === 'new' ? '+' : line.docIndex + 1}
                  </span>
                  {id !== undefined ? (
                    <span className="doc-row-id mono">{cellView(id).text}</span>
                  ) : null}
                  <span className="doc-row-summary mono">
                    {open ? '' : summarize(row.document, 200)}
                  </span>
                </div>
              )
            }

            const view = cellView(line.value)
            return (
              <div
                key={line.key}
                role="treeitem"
                aria-level={line.depth + 2}
                aria-expanded={line.container ? line.expanded : undefined}
                aria-selected={selected}
                className={`doc-row doc-row-field ${selected ? 'selected' : ''} ${index === cursor ? 'cursor' : ''}`}
                {...common}
              >
                <span
                  className="doc-field-indent"
                  style={{ width: 34 + (line.depth + 1) * INDENT }}
                />
                {line.container ? (
                  <button
                    type="button"
                    className="doc-chevron"
                    tabIndex={-1}
                    aria-label={line.expanded ? 'Collapse' : 'Expand'}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => togglePath(line.key)}
                  >
                    {line.expanded ? (
                      <ChevronDown size={13} aria-hidden />
                    ) : (
                      <ChevronRight size={13} aria-hidden />
                    )}
                  </button>
                ) : (
                  <span className="doc-chevron" />
                )}
                <span className={`doc-field-name mono ${line.isIndex ? 'doc-field-index' : ''}`}>
                  {line.isIndex ? line.name : line.name}
                </span>
                <span
                  className={`doc-field-value mono val-${view.kind}`}
                  title={formatShell(line.value)}
                >
                  {view.text}
                </span>
                <span className="doc-field-type">{TYPE_LABELS[typeOf(line.value)]}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
