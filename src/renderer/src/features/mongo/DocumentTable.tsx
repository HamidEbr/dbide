import { Check, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { formatCell, formatShell, type Json, typeOf } from '@shared/mongo/ejson'
import { evaluate } from '@shared/mongo/eval'
import { MongoSyntaxError, parseMongoValue } from '@shared/mongo/lang'
import { DENSITY_ROW_HEIGHT } from '@shared/settings'
import { useData } from '@/state/data'
import { notify } from '@/state/notices'
import { columnStarts, visibleColumns } from '@/features/sql/grid/virtual'
import { columnWidth, VALUE_COLUMN, type DocumentColumn } from './columns'
import { withField } from './diff'
import type { DocumentModel, DocumentRow } from './useDocumentModel'

const HEADER_HEIGHT = 30
const GUTTER_WIDTH = 56
const OVERSCAN = 6
const MIN_COLUMN_WIDTH = 48
const MAX_CELL_CHARS = 300

export interface RowSelection {
  anchor: number
  focus: number
}

/** The value in a top-level field of a document, or undefined when the document has no such field. */
export function fieldOf(document: Json, path: string): Json | undefined {
  if (
    typeof document === 'object' &&
    document !== null &&
    !Array.isArray(document) &&
    typeOf(document) === 'object'
  ) {
    return (document as { [key: string]: Json })[path]
  }
  // A result whose rows are not documents (a count, a list of names) has one column of values.
  return path === VALUE_COLUMN ? document : undefined
}

/** The text a cell shows, and the class that colours it. */
export function cellView(value: Json | undefined): { text: string; kind: string } {
  if (value === undefined) return { text: '', kind: 'missing' }
  const type = typeOf(value)
  let text = formatCell(value)
  if (text.length > MAX_CELL_CHARS) text = `${text.slice(0, MAX_CELL_CHARS)}…`
  if (type === 'null') return { text, kind: 'null' }
  if (type === 'int' || type === 'long' || type === 'double' || type === 'decimal') {
    return { text, kind: 'number' }
  }
  if (type === 'object' || type === 'array') return { text, kind: 'container' }
  if (type === 'string')
    return { text: text === '' ? '""' : text, kind: text === '' ? 'empty' : 'text' }
  if (type === 'objectId' || type === 'uuid') return { text, kind: 'id' }
  if (type === 'date' || type === 'timestamp') return { text, kind: 'date' }
  return { text, kind: 'binary' }
}

/** What goes in the editor for a cell: the value in the shell's notation. */
const editText = (value: Json | undefined): string =>
  value === undefined ? '' : formatShell(value, { indent: false })

interface CellEdit {
  row: number
  column: string
  initial: string
}

/** Reads what someone typed into a cell as a value. */
function readValue(text: string): { ok: true; value: Json } | { ok: false; message: string } {
  try {
    return { ok: true, value: evaluate(parseMongoValue(text)) }
  } catch (error) {
    if (error instanceof MongoSyntaxError) return { ok: false, message: error.message }
    throw error
  }
}

interface TableProps {
  model: DocumentModel
  selection: RowSelection | null
  onSelect: (selection: RowSelection | null) => void
  onOpen: (row: number) => void
  onDelete: () => void
  onCopy: () => void
  /** Lets the parent make this the grid that Copy acts on. */
  onFocused: () => void
  onBlurred: () => void
  columns: DocumentColumn[]
  hidden: number
}

/**
 * The documents as a table: one column per top-level field, found as the documents arrive. Nested
 * values show their size and open in the inspector. Double-click a cell, or press Enter, to edit it
 * as text in the shell's notation.
 */
export function DocumentTable({
  model,
  selection,
  onSelect,
  onOpen,
  onDelete,
  onCopy,
  onFocused,
  onBlurred,
  columns,
  hidden,
}: TableProps) {
  const density = useData((state) => state.settings.density)
  const rowHeight = DENSITY_ROW_HEIGHT[density]
  const { totalRows, rowAt } = model

  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [widths, setWidths] = useState<Record<string, number>>({})
  const [focusColumn, setFocusColumn] = useState(0)
  const [edit, setEdit] = useState<CellEdit | null>(null)

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(() =>
      setViewport({ width: element.clientWidth, height: element.clientHeight }),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const widthOf = useCallback(
    (column: DocumentColumn): number => {
      const set = widths[column.path]
      if (set !== undefined) return set
      const sample: string[] = []
      for (let r = 0; r < Math.min(40, totalRows); r++) {
        const row = rowAt(r)
        if (row) sample.push(cellView(fieldOf(row.document, column.path)).text)
      }
      return columnWidth(column.path, sample)
    },
    // Widths are decided once per column, from the first rows; later rows don't move them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [widths, columns.length],
  )
  const columnWidths = useMemo(() => columns.map(widthOf), [columns, widthOf])
  const starts = useMemo(() => columnStarts(columnWidths), [columnWidths])
  const windowOfColumns = visibleColumns(starts, scrollLeft, viewport.width, GUTTER_WIDTH)
  const totalWidth = GUTTER_WIDTH + (starts[starts.length - 1] ?? 0)
  const bodyHeight = Math.max(0, viewport.height - HEADER_HEIGHT)
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN)
  const last = Math.min(totalRows, Math.ceil((scrollTop + bodyHeight) / rowHeight) + OVERSCAN)

  const range = selection
    ? {
        r1: Math.min(selection.anchor, selection.focus),
        r2: Math.max(selection.anchor, selection.focus),
      }
    : null

  const ensureVisible = (row: number): void => {
    const element = scroller.current
    if (!element) return
    const top = row * rowHeight
    const body = element.clientHeight - HEADER_HEIGHT
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + rowHeight > element.scrollTop + body) element.scrollTop = top + rowHeight - body
  }

  const goTo = (row: number, extend: boolean): void => {
    const target = Math.max(0, Math.min(totalRows - 1, row))
    onSelect({ anchor: extend && selection ? selection.anchor : target, focus: target })
    ensureVisible(target)
  }

  const startEdit = (rowIndex: number, columnIndex: number, initial?: string): void => {
    const row = rowAt(rowIndex)
    const column = columns[columnIndex]
    if (!row || !column) return
    if (model.blockedReason) return notify(model.blockedReason)
    if (model.locked) return notify('Editing is locked. Unlock writes first.')
    if (row.state === 'deleted') return notify('This document is marked for deletion.')
    if (row.key === null && row.state !== 'new') {
      return notify('This document has no _id, so it can’t be edited.')
    }
    if (column.path === '_id' && row.state !== 'new') {
      return notify('The _id of a document can’t be changed.')
    }
    const value = fieldOf(row.document, column.path)
    const type = value === undefined ? 'undefined' : typeOf(value)
    if (type === 'object' || type === 'array') {
      // Nested values need room; the inspector has it.
      onOpen(rowIndex)
      return
    }
    setEdit({ row: rowIndex, column: column.path, initial: initial ?? editText(value) })
  }

  const finishEdit = (text: string): string | null => {
    if (!edit) return null
    const row = rowAt(edit.row)
    if (!row) return 'This document is no longer here.'
    const parsed = readValue(text)
    if (!parsed.ok) return parsed.message
    const message = model.stage(row, withField(row.document, edit.column, parsed.value))
    if (message) return message
    setEdit(null)
    scroller.current?.focus()
    return null
  }

  const cancelEdit = (): void => {
    setEdit(null)
    scroller.current?.focus()
  }

  const pointFrom = (target: EventTarget | null): { row: number; col: number } | null => {
    const cell = (target as HTMLElement | null)?.closest<HTMLElement>('[data-c]')
    if (!cell) return null
    return { row: Number(cell.dataset.r), col: Number(cell.dataset.c) }
  }

  const onMouseDown = (event: ReactMouseEvent): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.doc-cell-editor')) return
    const point = pointFrom(event.target)
    if (!point) return
    scroller.current?.focus()
    setFocusColumn(point.col)
    onSelect({
      anchor: event.shiftKey && selection ? selection.anchor : point.row,
      focus: point.row,
    })
    const onMove = (move: MouseEvent): void => {
      const next = pointFrom(document.elementFromPoint(move.clientX, move.clientY))
      if (next)
        onSelect({
          anchor: event.shiftKey && selection ? selection.anchor : point.row,
          focus: next.row,
        })
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const selectRow = (row: number, extend: boolean): void => {
    scroller.current?.focus()
    onSelect({ anchor: extend && selection ? selection.anchor : row, focus: row })
  }

  const startResize = (path: string, current: number, event: ReactMouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const onMove = (move: MouseEvent): void => {
      const width = Math.max(MIN_COLUMN_WIDTH, current + move.clientX - startX)
      setWidths((all) => ({ ...all, [path]: width }))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if ((event.target as HTMLElement).closest('.doc-cell-editor')) return
    if (totalRows === 0) return
    const mod = event.metaKey || event.ctrlKey
    const current = selection?.focus ?? 0
    const page = Math.max(1, Math.floor(bodyHeight / rowHeight) - 1)
    switch (event.key) {
      case 'ArrowUp':
        goTo(current - 1, event.shiftKey)
        break
      case 'ArrowDown':
        goTo(current + 1, event.shiftKey)
        break
      case 'PageUp':
        goTo(current - page, event.shiftKey)
        break
      case 'PageDown':
        goTo(current + page, event.shiftKey)
        break
      case 'Home':
        goTo(0, event.shiftKey)
        break
      case 'End':
        goTo(totalRows - 1, event.shiftKey)
        break
      case 'ArrowLeft':
        setFocusColumn((c) => Math.max(0, c - 1))
        break
      case 'ArrowRight':
        setFocusColumn((c) => Math.min(columns.length - 1, c + 1))
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
      case 'Enter':
        if (!selection) return
        if (event.shiftKey) onOpen(current)
        else startEdit(current, focusColumn)
        break
      case 'F2':
        if (!selection) return
        startEdit(current, focusColumn)
        break
      case ' ':
        if (!selection) return
        onOpen(current)
        break
      case 'Escape':
        onSelect(null)
        break
      case 'Delete':
      case 'Backspace':
        if (!selection) return
        onDelete()
        break
      default:
        return
    }
    event.preventDefault()
  }

  const drawnRows: number[] = []
  for (let r = first; r < last; r++) drawnRows.push(r)
  const drawn: number[] = []
  for (let c = windowOfColumns.first; c < Math.min(columns.length, windowOfColumns.last); c++) {
    drawn.push(c)
  }

  return (
    <div
      className="grid doc-table"
      role="grid"
      aria-rowcount={totalRows + 1}
      aria-colcount={columns.length}
      tabIndex={0}
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget
        setScrollTop(element.scrollTop)
        const next = visibleColumns(starts, element.scrollLeft, viewport.width, GUTTER_WIDTH)
        if (next.first !== windowOfColumns.first || next.last !== windowOfColumns.last) {
          setScrollLeft(element.scrollLeft)
        }
      }}
      onKeyDown={onKeyDown}
      onFocus={(event) => event.target === event.currentTarget && onFocused()}
      onBlur={(event) => event.target === event.currentTarget && onBlurred()}
      style={{ ['--row-h' as string]: `${rowHeight}px` }}
    >
      <div
        className="grid-inner"
        style={{ width: totalWidth, height: HEADER_HEIGHT + totalRows * rowHeight }}
      >
        <div className="grid-header" role="row" style={{ height: HEADER_HEIGHT }}>
          <div className="grid-gutter grid-corner" style={{ width: GUTTER_WIDTH }} />
          <div className="grid-spacer" style={{ width: windowOfColumns.offset }} />
          {drawn.map((index) => {
            const column = columns[index]!
            const types = column.types.length > 1 ? 'mixed' : (column.types[0] ?? '')
            return (
              <div
                key={column.path}
                role="columnheader"
                aria-colindex={index + 1}
                className="grid-head"
                style={{ width: columnWidths[index] }}
                title={`${column.path} · ${column.types.join(', ')}`}
              >
                <span className="grid-head-name">{column.path}</span>
                <span className="grid-head-type">{types}</span>
                <span
                  className="grid-resize"
                  onMouseDown={(event) => startResize(column.path, columnWidths[index]!, event)}
                />
              </div>
            )
          })}
        </div>

        <div
          className="grid-rows"
          style={{ top: HEADER_HEIGHT, transform: `translateY(${first * rowHeight}px)` }}
          onMouseDown={onMouseDown}
          onDoubleClick={(event) => {
            const point = pointFrom(event.target)
            if (point) startEdit(point.row, point.col)
          }}
        >
          {drawnRows.map((r) => {
            const row = rowAt(r)
            if (!row) {
              return (
                <div
                  key={`pending-${r}`}
                  role="row"
                  className="grid-row grid-row-pending"
                  style={{ height: rowHeight }}
                  aria-busy="true"
                >
                  <div className="grid-gutter" style={{ width: GUTTER_WIDTH }}>
                    {r + 1}
                  </div>
                </div>
              )
            }
            const inRange = range !== null && r >= range.r1 && r <= range.r2
            const original = row.state === 'changed' ? row.original : null
            return (
              <div
                key={row.insertKey ?? r}
                role="row"
                className={`grid-row ${row.state === 'deleted' ? 'row-deleted' : ''} ${row.state === 'new' ? 'row-new' : ''}`}
                style={{ height: rowHeight }}
              >
                <div
                  className={`grid-gutter ${inRange ? 'in-selection' : ''}`}
                  style={{ width: GUTTER_WIDTH }}
                  onMouseDown={(event) => {
                    event.stopPropagation()
                    if (event.button === 0) selectRow(r, event.shiftKey)
                  }}
                  onDoubleClick={() => onOpen(r)}
                >
                  {row.state === 'new' ? '+' : r + 1}
                </div>
                <div className="grid-spacer" style={{ width: windowOfColumns.offset }} />
                {drawn.map((c) => {
                  const column = columns[c]!
                  const value = fieldOf(row.document, column.path)
                  const view = cellView(value)
                  const isFocus = selection?.focus === r && focusColumn === c
                  const isEditing = edit?.row === r && edit.column === column.path
                  const changed =
                    original !== null &&
                    JSON.stringify(fieldOf(original, column.path)) !== JSON.stringify(value)
                  return (
                    <div
                      key={column.path}
                      role="gridcell"
                      data-r={r}
                      data-c={c}
                      className={`grid-cell cell-${view.kind} ${inRange ? 'selected' : ''} ${isFocus ? 'focus' : ''} ${changed ? 'cell-changed' : ''} ${isEditing ? 'cell-editing' : ''}`}
                      style={{ width: columnWidths[c] }}
                      title={view.kind === 'container' ? 'Open in the inspector' : undefined}
                    >
                      {isEditing ? (
                        <CellEditor
                          initial={edit.initial}
                          onCommit={finishEdit}
                          onCancel={cancelEdit}
                        />
                      ) : (
                        view.text
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
      {hidden > 0 ? (
        <p className="doc-hidden-note muted">
          {hidden.toLocaleString()} more field{hidden === 1 ? '' : 's'} not shown. Open a document
          to see them all.
        </p>
      ) : null}
    </div>
  )
}

/** A one-line editor for a cell. Enter keeps the value, Escape drops it; a value that doesn't read stays open. */
function CellEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (text: string) => string | null
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const keep = (): void => {
    const message = onCommit(text)
    if (message) setError(message)
  }

  return (
    <span className="doc-cell-editor">
      <input
        ref={input}
        className="mono"
        aria-label="Value"
        aria-invalid={error !== null}
        title={error ?? undefined}
        value={text}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value)
          setError(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') keep()
          else if (event.key === 'Escape') onCancel()
          else return
          event.preventDefault()
          event.stopPropagation()
        }}
      />
      {error ? (
        <span className="doc-cell-error" role="alert">
          {error}
        </span>
      ) : null}
      <button
        type="button"
        className="doc-cell-btn"
        aria-label="Keep"
        onMouseDown={(e) => e.preventDefault()}
        onClick={keep}
      >
        <Check size={12} />
      </button>
      <button
        type="button"
        className="doc-cell-btn"
        aria-label="Cancel"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onCancel}
      >
        <X size={12} />
      </button>
    </span>
  )
}

export type { DocumentRow }
