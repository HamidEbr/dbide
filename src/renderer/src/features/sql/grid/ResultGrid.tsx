import { Link2 } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import type { Cell } from '@shared/query'
import { DENSITY_ROW_HEIGHT } from '@shared/settings'
import { cellToEditText } from '@shared/value'
import { writeClipboard } from '@/lib/clipboard'
import { useData } from '@/state/data'
import { useInspector } from '@/state/inspector'
import { notify } from '@/state/notices'
import { useScripts, type ResultSet, type StatementRun } from '@/state/scripts'
import { EditBar } from '../edit/EditBar'
import { FieldEditor, type Move } from '../edit/FieldEditor'
import { generateStatements, type GenerateKind } from '../edit/generate'
import { registerEditHandle } from '../edit/handles'
import { useRowEditing } from '../edit/useRowEditing'
import { createScript } from '../scripts'
import { clearActiveGrid, setActiveGrid, type GridHandle } from './active-grid'
import { formatCopy, type CopyFormat } from './copy'
import { dialectOf, type SqlDialect } from '@shared/dialect'
import { buildLookup, describeLink, type FkLink } from './foreign-keys'
import { columnWidth, displayCell } from './format'
import { useForeignKeys } from './useForeignKeys'
import { normalizeSelection, selectionSize, type GridPoint } from './selection'
import { useSelectionStats } from './useSelectionStats'
import { columnStarts, visibleColumns } from './virtual'

/** The most rows a copy takes. Beyond it the text would be bigger than the clipboard can sensibly hold. */
const MAX_COPY_ROWS = 250_000

const HEADER_HEIGHT = 30
const GUTTER_WIDTH = 56
const OVERSCAN = 6
const MIN_COLUMN_WIDTH = 48

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 })

interface Anchor {
  anchor: GridPoint
  focus: GridPoint
}

interface CellEdit {
  row: number
  col: number
  initial: string
  /** Opened with Enter or a double-click (select all) rather than by typing (caret at the end). */
  selectAll: boolean
}

interface ResultGridProps {
  resultSet: ResultSet
  scriptId: string
  statement: StatementRun
  /** Whether this grid's tab is the one on screen. Only that grid drives the inspector. */
  active: boolean
}

export function ResultGrid({ resultSet, scriptId, statement, active }: ResultGridProps) {
  const { columns, store } = resultSet
  const density = useData((state) => state.settings.density)
  const rowHeight = DENSITY_ROW_HEIGHT[density]

  // Re-render when a batch lands. The rows themselves are read straight from the store.
  const version = useSyncExternalStore(store.subscribe, store.getVersion)
  const editing = useRowEditing(scriptId, resultSet, statement)
  const sourceConnectionId = useScripts((state) => state.scripts[scriptId]?.connectionId ?? '')
  const dialect: SqlDialect = useData((state) => {
    const engine = state.connections.find((c) => c.id === sourceConnectionId)?.engine
    return (engine && dialectOf(engine)) || 'mysql'
  })
  const totalRows = editing.totalRows

  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [widths, setWidths] = useState(() =>
    columns.map((column, index) => columnWidth(column, store.rows.slice(0, 50), index)),
  )
  const [selected, setSelected] = useState<Anchor | null>(null)
  const [cellEdit, setCellEdit] = useState<CellEdit | null>(null)
  // Mirrors `selected` so two mouse events in quick succession see each other's result.
  const selectedRef = useRef<Anchor | null>(null)
  const update = useCallback((next: Anchor | null): void => {
    selectedRef.current = next
    setSelected(next)
  }, [])

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(() =>
      setViewport({ width: element.clientWidth, height: element.clientHeight }),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Only the columns on screen are drawn, so a result with hundreds of columns scrolls as smoothly
  // as one with a few.
  const starts = useMemo(() => columnStarts(widths), [widths])
  const columnWindow = visibleColumns(starts, scrollLeft, viewport.width, GUTTER_WIDTH)
  const totalWidth = GUTTER_WIDTH + (starts[starts.length - 1] ?? 0)
  const bodyHeight = Math.max(0, viewport.height - HEADER_HEIGHT)
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN)
  const last = Math.min(totalRows, Math.ceil((scrollTop + bodyHeight) / rowHeight) + OVERSCAN)

  const selection = useMemo(
    () =>
      selected
        ? normalizeSelection(selected.anchor, selected.focus, totalRows, columns.length)
        : null,
    [selected, totalRows, columns.length],
  )

  const peekRow = useCallback((r: number) => editing.effectiveRow(r, true), [editing])
  const stats = useSelectionStats({ store, columns, selection, peekRow, version })

  const select = useCallback(
    (anchor: GridPoint, focus: GridPoint = anchor): void => update({ anchor, focus }),
    [update],
  )

  const ensureVisible = useCallback(
    (row: number, col: number): void => {
      const element = scroller.current
      if (!element) return
      const top = row * rowHeight
      const body = element.clientHeight - HEADER_HEIGHT
      if (top < element.scrollTop) element.scrollTop = top
      else if (top + rowHeight > element.scrollTop + body) {
        element.scrollTop = top + rowHeight - body
      }
      const left = GUTTER_WIDTH + (starts[col] ?? 0)
      const right = left + (widths[col] ?? 0)
      if (left - GUTTER_WIDTH < element.scrollLeft)
        element.scrollLeft = Math.max(0, left - GUTTER_WIDTH)
      else if (right > element.scrollLeft + element.clientWidth) {
        element.scrollLeft = right - element.clientWidth
      }
    },
    [rowHeight, widths, starts],
  )

  const goTo = useCallback(
    (row: number, col: number, extendFrom?: GridPoint): void => {
      const clamped = {
        row: Math.max(0, Math.min(totalRows - 1, row)),
        col: Math.max(0, Math.min(columns.length - 1, col)),
      }
      select(extendFrom ?? clamped, clamped)
      ensureVisible(clamped.row, clamped.col)
    },
    [totalRows, columns.length, select, ensureVisible],
  )

  const copy = useCallback(
    async (format: CopyFormat, options?: { headers?: boolean }): Promise<void> => {
      if (!selection) return notify('Select some cells first.')
      const count = selection.r2 - selection.r1 + 1
      if (count > MAX_COPY_ROWS) {
        return notify(
          `That is ${count.toLocaleString()} rows. Copy is limited to ${MAX_COPY_ROWS.toLocaleString()}; use Export to take the whole result.`,
        )
      }
      const cols = columns.slice(selection.c1, selection.c2 + 1)
      const rows: Cell[][] = []
      const inWindow = store.rows.length
      for (let r = selection.r1; r <= selection.r2; r++) {
        if (store.spilled > 0 && r >= inWindow) break
        const view = editing.effectiveRow(r)
        if (view) {
          rows.push(view.cells.slice(selection.c1, selection.c2 + 1).map((v) => v ?? null))
        }
      }
      // Rows the core holds are fetched; there are no staged edits on them.
      if (store.spilled > 0 && selection.r2 >= inWindow) {
        const held = await store.readRange(Math.max(selection.r1, inWindow), selection.r2)
        for (const row of held) rows.push(row.slice(selection.c1, selection.c2 + 1))
      }
      await writeClipboard(formatCopy(format, cols, rows, options))
      notify(
        `Copied ${selectionSize(selection).toLocaleString()} cell${selectionSize(selection) === 1 ? '' : 's'}`,
      )
    },
    [selection, columns, editing, store],
  )

  const generate = useCallback(
    (kind: GenerateKind): void => {
      const label = kind.toUpperCase()
      if (!selection) return notify('Select some rows first.')
      if (!editing.table) {
        return notify(
          `Can’t write ${label} statements. ${editing.reason ?? 'The table’s keys are still loading.'}`,
        )
      }
      const picked: (Cell | undefined)[][] = []
      for (let r = selection.r1; r <= selection.r2; r++) {
        const view = editing.effectiveRow(r)
        // A row that is not in the table yet has nothing to update or delete.
        if (view && view.state !== 'new') picked.push(view.cells)
      }
      const columnsPicked = Array.from(
        { length: selection.c2 - selection.c1 + 1 },
        (_, i) => selection.c1 + i,
      )
      const result = generateStatements(
        kind,
        editing.table,
        columns,
        picked,
        columnsPicked,
        dialect,
      )
      if (!result.ok) return notify(result.message)
      void writeClipboard(result.statements.join('\n')).then(() =>
        notify(
          `Copied ${result.statements.length.toLocaleString()} ${label} statement${result.statements.length === 1 ? '' : 's'}.`,
        ),
      )
    },
    [selection, editing, columns, dialect],
  )

  // ───────── foreign keys ─────────

  const connectionId = useScripts((state) => state.scripts[scriptId]?.connectionId ?? '')
  const links = useForeignKeys(
    connectionId,
    columns,
    statement.status === 'done' || statement.status === 'paused',
  )

  /** Opens the rows a link leads to, as a new script that runs at once. */
  const followLink = useCallback(
    (link: FkLink, row: number): void => {
      const cells = editing.effectiveRow(row)?.cells
      const lookup = cells ? buildLookup(link, columns, cells, 1000, dialect) : null
      if (!lookup) return notify('That value is NULL, so it doesn’t point at any row.')
      createScript({
        connectionId,
        database: lookup.database,
        text: lookup.sql,
        name: lookup.title,
        run: true,
      })
    },
    [editing, columns, connectionId, dialect],
  )

  const follow = useCallback(
    (direction: 'references' | 'referencedBy'): void => {
      const at = selectedRef.current?.focus
      if (!at) return notify('Select a cell first.')
      const link = links[at.col]?.find((l) => l.direction === direction)
      if (!link) {
        return notify(
          direction === 'references'
            ? 'This column isn’t a foreign key.'
            : 'No other table points at this column.',
        )
      }
      followLink(link, at.row)
    },
    [links, followLink],
  )

  // One handle for the life of the grid. It calls whatever the latest render made of each action, so
  // moving the selection never replaces it, and with it the "grid that commands act on".
  const actions = useRef({ copy, generate, follow })
  useEffect(() => {
    actions.current = { copy, generate, follow }
  })
  const handle = useMemo<GridHandle>(
    () => ({
      copy: (format, options) => actions.current.copy(format, options),
      generate: (kind) => actions.current.generate(kind),
      follow: (direction) => actions.current.follow(direction),
    }),
    [],
  )
  useEffect(() => () => clearActiveGrid(handle), [handle])

  // ───────── editing ─────────

  const startEdit = useCallback(
    (row: number, col: number, initial?: string): void => {
      if (editing.status !== 'ready') {
        notify(editing.reason ?? 'This result can’t be edited.')
        return
      }
      if (!editing.writable) {
        notify('Editing is locked. Unlock writes first.')
        return
      }
      const reason = editing.blocked(col)
      if (reason) return notify(reason)
      const view = editing.effectiveRow(row)
      if (!view) return
      if (view.state === 'deleted') return notify('This row is marked for deletion.')
      const current = view.cells[col]
      if (initial === undefined && typeof current === 'string' && current.includes('\n')) {
        // One line can't show these without changing them. The inspector has room.
        useInspector.getState().setTab('value')
        useInspector.getState().setEditing(true)
        return
      }
      setCellEdit({
        row,
        col,
        initial: initial ?? cellToEditText(current),
        selectAll: initial === undefined,
      })
    },
    [editing],
  )

  const finishEdit = (value: Cell, move: Move): string | null => {
    if (!cellEdit) return null
    const message = editing.stageCell(cellEdit.row, cellEdit.col, value)
    if (message) return message
    const { row, col } = cellEdit
    setCellEdit(null)
    scroller.current?.focus()
    const delta: Record<Move, [number, number]> = {
      down: [1, 0],
      up: [-1, 0],
      right: [0, 1],
      left: [0, -1],
      none: [0, 0],
    }
    const [dr, dc] = delta[move]
    goTo(row + dr, col + dc)
    return null
  }

  const cancelEdit = (): void => {
    setCellEdit(null)
    scroller.current?.focus()
  }

  // Read from the ref, so a key pressed right after a click sees that click.
  const rowsInSelection = (): number[] => {
    const current = selectedRef.current
    const now = current
      ? normalizeSelection(current.anchor, current.focus, totalRows, columns.length)
      : null
    if (!now) return []
    return Array.from({ length: now.r2 - now.r1 + 1 }, (_, i) => now.r1 + i)
  }

  const deleteSelected = (): void => {
    const rows = rowsInSelection()
    if (rows.length === 0) return notify('Select the rows to delete first.')
    editing.toggleDelete(rows)
  }

  /** Set by Add row; acted on once the new row exists, which is after the next render. */
  const pendingNewRow = useRef<{ row: number; col: number } | null>(null)

  const addRow = (): void => {
    const row = editing.addRow()
    // Start in the first column a person would type into: not computed, not an auto-increment key.
    const col = columns.findIndex(
      (_, c) => editing.blocked(c) === null && !editing.columnMeta(c)?.autoIncrement,
    )
    pendingNewRow.current = { row, col: Math.max(0, col) }
  }

  useEffect(() => {
    const pending = pendingNewRow.current
    if (!pending || totalRows <= pending.row) return
    pendingNewRow.current = null
    goTo(pending.row, pending.col)
    startEdit(pending.row, pending.col, '')
  }, [totalRows, goTo, startEdit])

  const commit = async (): Promise<void> => {
    const saved = await editing.commit()
    if (saved) update(null)
  }

  // Lets Save (the commit shortcut) and the command palette reach this result's changes.
  const changeApi = useRef({ count: 0, commit, discard: editing.discard })
  useEffect(() => {
    changeApi.current = { count: editing.changeCount, commit, discard: editing.discard }
  })
  const hasChanges = editing.changeCount > 0
  useEffect(() => {
    if (!active || !hasChanges) return
    return registerEditHandle(scriptId, {
      count: () => changeApi.current.count,
      commit: () => void changeApi.current.commit(),
      discard: () => changeApi.current.discard(),
    })
  }, [active, hasChanges, scriptId])

  // ───────── the inspector follows the selected cell ─────────

  const api = useRef({ editing, goTo })
  useEffect(() => {
    api.current = { editing, goTo }
  })

  const focus = selected?.focus ?? null
  useEffect(() => {
    if (!active) return
    const inspector = useInspector.getState()
    if (!focus || focus.row >= totalRows) return inspector.setTarget(null)
    const view = api.current.editing.effectiveRow(focus.row)
    if (!view) return inspector.setTarget(null)
    inspector.setTarget({
      ownerId: resultSet.id,
      columns,
      rowIndex: focus.row,
      colIndex: focus.col,
      row: view.cells,
      changed: view.changed,
      isNewRow: view.state === 'new',
      isDeleted: view.state === 'deleted',
      rowCount: totalRows,
      edit:
        editing.status === 'ready'
          ? {
              blocked: (c) => api.current.editing.blocked(c),
              set: (c, value) => api.current.editing.stageCell(focus.row, c, value),
            }
          : null,
      readOnlyReason: editing.reason,
      move: (delta) => api.current.goTo(focus.row + delta, focus.col),
      focusColumn: (c) => api.current.goTo(focus.row, c),
    })
  }, [
    active,
    focus,
    version,
    editing.changeSet,
    editing.status,
    editing.reason,
    totalRows,
    resultSet.id,
    columns,
  ])

  useEffect(
    () => () => {
      const inspector = useInspector.getState()
      if (inspector.target?.ownerId === resultSet.id) inspector.setTarget(null)
    },
    [resultSet.id],
  )

  // ───────── mouse and keyboard ─────────

  const pointFrom = (target: EventTarget | null): GridPoint | null => {
    const cell = (target as HTMLElement | null)?.closest<HTMLElement>('[data-c]')
    if (!cell) return null
    return { row: Number(cell.dataset.r), col: Number(cell.dataset.c) }
  }

  const onMouseDown = (event: ReactMouseEvent): void => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('.field-editor')) return
    const point = pointFrom(event.target)
    if (!point) return
    scroller.current?.focus()
    // Clicking a cell makes this the grid commands act on, even before the browser reports focus.
    setActiveGrid(handle)

    // Command-click (Ctrl-click off the Mac) on a foreign key goes to the row it points at.
    const modifier = window.dbide.platform === 'darwin' ? event.metaKey : event.ctrlKey
    const link = modifier ? links[point.col]?.find((l) => l.direction === 'references') : undefined
    if (link) {
      select(point)
      followLink(link, point.row)
      return
    }
    const anchor = event.shiftKey && selectedRef.current ? selectedRef.current.anchor : point
    select(anchor, point)

    const onMove = (move: MouseEvent): void => {
      const under = document.elementFromPoint(move.clientX, move.clientY)
      const next = pointFrom(under)
      if (next && selectedRef.current) update({ anchor: selectedRef.current.anchor, focus: next })
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
    const anchorRow = extend && selectedRef.current ? selectedRef.current.anchor.row : row
    select({ row: anchorRow, col: 0 }, { row, col: columns.length - 1 })
  }

  const selectColumn = (col: number, extend: boolean): void => {
    scroller.current?.focus()
    const anchorCol = extend && selectedRef.current ? selectedRef.current.anchor.col : col
    select({ row: 0, col: anchorCol }, { row: totalRows - 1, col })
  }

  const startResize = (index: number, event: ReactMouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = widths[index] ?? MIN_COLUMN_WIDTH
    const onMove = (move: MouseEvent): void => {
      const width = Math.max(MIN_COLUMN_WIDTH, startWidth + move.clientX - startX)
      setWidths((current) => current.map((w, i) => (i === index ? width : w)))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    // Keys typed into a cell editor belong to it.
    if ((event.target as HTMLElement).closest('.field-editor')) return
    if (totalRows === 0) return
    const mod = event.metaKey || event.ctrlKey
    const current = selected?.focus ?? { row: 0, col: 0 }
    const page = Math.max(1, Math.floor(bodyHeight / rowHeight) - 1)

    let target: GridPoint
    switch (event.key) {
      case 'ArrowUp':
        target = { row: current.row - 1, col: current.col }
        break
      case 'ArrowDown':
        target = { row: current.row + 1, col: current.col }
        break
      case 'ArrowLeft':
        target = { row: current.row, col: current.col - 1 }
        break
      case 'ArrowRight':
        target = { row: current.row, col: current.col + 1 }
        break
      case 'PageUp':
        target = { row: current.row - page, col: current.col }
        break
      case 'PageDown':
        target = { row: current.row + page, col: current.col }
        break
      case 'Home':
        target = mod ? { row: 0, col: 0 } : { row: current.row, col: 0 }
        break
      case 'End':
        target = mod
          ? { row: totalRows - 1, col: columns.length - 1 }
          : { row: current.row, col: columns.length - 1 }
        break
      case 'a':
      case 'A':
        if (mod) {
          event.preventDefault()
          select({ row: 0, col: 0 }, { row: totalRows - 1, col: columns.length - 1 })
          return
        }
        return startTyping(event)
      case 'Escape':
        update(null)
        return
      case 'Enter':
      case 'F2':
        if (!selected) return
        event.preventDefault()
        startEdit(current.row, current.col)
        return
      case 'Delete':
      case 'Backspace':
        if (editing.status !== 'ready' || !selectedRef.current) return
        event.preventDefault()
        if (editing.writable) deleteSelected()
        else notify('Editing is locked. Unlock writes first.')
        return
      case '0':
      case ')':
        if (mod && event.shiftKey && selected) {
          event.preventDefault()
          const message = editing.stageCell(current.row, current.col, null)
          if (message) notify(message)
        }
        return
      default:
        return startTyping(event)
    }

    event.preventDefault()
    goTo(target.row, target.col, event.shiftKey && selected ? selected.anchor : undefined)
  }

  /** A printable key on a selected cell starts editing it, like a spreadsheet. */
  const startTyping = (event: KeyboardEvent): void => {
    if (!selected || event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey)
      return
    if (editing.status !== 'ready') return
    event.preventDefault()
    startEdit(selected.focus.row, selected.focus.col, event.key)
  }

  const rows: number[] = []
  for (let r = first; r < last; r++) rows.push(r)
  const drawn: number[] = []
  for (let c = columnWindow.first; c < Math.min(columns.length, columnWindow.last); c++)
    drawn.push(c)

  const focusLinks = selected ? links[selected.focus.col] : undefined
  const focusLink =
    focusLinks?.find((l) => l.direction === 'references') ??
    focusLinks?.find((l) => l.direction === 'referencedBy')
  const modifierName = window.dbide.platform === 'darwin' ? '⌘' : 'Ctrl'

  const description = selection
    ? selectionSize(selection) === 1
      ? `Row ${(selection.r1 + 1).toLocaleString()} · ${columns[selection.c1]?.name ?? ''}`
      : `${(selection.r2 - selection.r1 + 1).toLocaleString()} rows × ${selection.c2 - selection.c1 + 1} columns`
    : null

  return (
    <div className="grid-wrap">
      <EditBar
        editing={editing}
        onAddRow={addRow}
        onDeleteSelected={deleteSelected}
        onCommit={() => void commit()}
      />
      <div
        className="grid"
        role="grid"
        aria-rowcount={totalRows + 1}
        aria-colcount={columns.length}
        tabIndex={0}
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget
          setScrollTop(element.scrollTop)
          // Horizontal scrolling only re-renders when a column enters or leaves the window.
          const next = visibleColumns(starts, element.scrollLeft, viewport.width, GUTTER_WIDTH)
          if (next.first !== columnWindow.first || next.last !== columnWindow.last) {
            setScrollLeft(element.scrollLeft)
            // A cell editor that scrolled out of the drawn columns is closed, not left half-typed.
            if (cellEdit && (cellEdit.col < next.first || cellEdit.col >= next.last)) {
              setCellEdit(null)
            }
          }
        }}
        onKeyDown={onKeyDown}
        // Focus moving into a cell editor must not make the grid the target of Copy.
        onFocus={(event) => event.target === event.currentTarget && setActiveGrid(handle)}
        onBlur={(event) => event.target === event.currentTarget && clearActiveGrid(handle)}
        style={{ ['--row-h' as string]: `${rowHeight}px` }}
      >
        <div
          className="grid-inner"
          style={{ width: totalWidth, height: HEADER_HEIGHT + totalRows * rowHeight }}
        >
          <div className="grid-header" role="row" style={{ height: HEADER_HEIGHT }}>
            <div className="grid-gutter grid-corner" style={{ width: GUTTER_WIDTH }} />
            <div className="grid-spacer" style={{ width: columnWindow.offset }} />
            {drawn.map((index) => {
              const column = columns[index]!
              return (
                <div
                  key={index}
                  role="columnheader"
                  aria-colindex={index + 1}
                  className="grid-head"
                  style={{ width: widths[index] }}
                  title={`${column.name} · ${column.type}`}
                  onMouseDown={(event) => event.button === 0 && selectColumn(index, event.shiftKey)}
                >
                  <span className="grid-head-name">{column.name}</span>
                  <span className="grid-head-type">{column.type}</span>
                  {links[index]?.length ? (
                    <Link2
                      size={11}
                      className="grid-head-fk"
                      aria-label="Foreign key"
                      data-fk={index}
                    />
                  ) : null}
                  <span
                    className="grid-resize"
                    onMouseDown={(event) => startResize(index, event)}
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
            {rows.map((r) => {
              const view = editing.effectiveRow(r)
              // A row the core holds is on its way: keep its place, so the rows below don't jump.
              if (!view) {
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
              const inRows = selection !== null && r >= selection.r1 && r <= selection.r2
              return (
                <div
                  key={view.newId ?? r}
                  role="row"
                  className={`grid-row ${view.state === 'deleted' ? 'row-deleted' : ''} ${view.state === 'new' ? 'row-new' : ''}`}
                  style={{ height: rowHeight }}
                >
                  <div
                    className={`grid-gutter ${inRows ? 'in-selection' : ''}`}
                    style={{ width: GUTTER_WIDTH }}
                    onMouseDown={(event) => {
                      event.stopPropagation()
                      if (event.button === 0) selectRow(r, event.shiftKey)
                    }}
                  >
                    {view.state === 'new' ? '+' : r + 1}
                  </div>
                  <div className="grid-spacer" style={{ width: columnWindow.offset }} />
                  {drawn.map((c) => {
                    const column = columns[c]!
                    const value = view.cells[c]
                    const display = displayCell(value === undefined ? null : value, column)
                    const inSelection =
                      selection !== null && inRows && c >= selection.c1 && c <= selection.c2
                    const isFocus = selected?.focus.row === r && selected.focus.col === c
                    const isEditing = cellEdit?.row === r && cellEdit.col === c
                    const kind = value === undefined ? 'default' : display.kind
                    return (
                      <div
                        key={c}
                        role="gridcell"
                        data-r={r}
                        data-c={c}
                        className={`grid-cell cell-${kind} ${inSelection ? 'selected' : ''} ${isFocus ? 'focus' : ''} ${view.changed.has(c) ? 'cell-changed' : ''} ${isEditing ? 'cell-editing' : ''}`}
                        style={{ width: widths[c] }}
                      >
                        {isEditing ? (
                          <FieldEditor
                            column={column}
                            nullable={column.nullable !== false}
                            initial={cellEdit.initial}
                            selectAll={cellEdit.selectAll}
                            compact
                            onCommit={finishEdit}
                            onCancel={cancelEdit}
                          />
                        ) : value === undefined ? (
                          'DEFAULT'
                        ) : (
                          display.text
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className="grid-footer" aria-live="polite">
        <span>{description ?? 'Click a cell to select. Shift-click or drag to extend.'}</span>
        {focusLink ? (
          <span className="grid-fk-hint">
            {focusLink.direction === 'references' ? `${modifierName}-click: ` : ''}
            {describeLink(focusLink)}
          </span>
        ) : null}
        {stats && stats.numeric > 0 ? (
          <span className="grid-stats mono">
            Σ {numberFormat.format(stats.sum)} · avg {numberFormat.format(stats.avg)} · min{' '}
            {numberFormat.format(stats.min)} · max {numberFormat.format(stats.max)} ·{' '}
            {stats.numeric.toLocaleString()} numbers{stats.partial ? ' (partial)' : ''}
          </span>
        ) : null}
      </div>
    </div>
  )
}
