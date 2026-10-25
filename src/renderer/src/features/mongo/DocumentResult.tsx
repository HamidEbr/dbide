import { ListTree, LockOpen, Plus, Table2, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { documentSource } from '@shared/mongo/documents'
import { formatRelaxedJson, formatShell, type Json } from '@shared/mongo/ejson'
import { formatShortcut } from '@/commands/keybinding'
import { Button, Segmented } from '@/components/ui'
import { writeClipboard } from '@/lib/clipboard'
import { notify } from '@/state/notices'
import { useInspector } from '@/state/inspector'
import { registerEditHandle } from '@/features/sql/edit/handles'
import { clearActiveGrid, setActiveGrid, type GridHandle } from '@/features/sql/grid/active-grid'
import { useScripts, type ResultSet, type StatementRun } from '@/state/scripts'
import { ColumnScanner } from './columns'
import { DocumentTable, type RowSelection } from './DocumentTable'
import { DocumentTree } from './DocumentTree'
import { useDocumentEdits } from './edits'
import { useDocumentModel, type DocumentRow } from './useDocumentModel'

type View = 'table' | 'tree'

/** The view last used, so the next result opens the way the last one was left. */
let lastView: View = 'table'

/** The most documents one copy takes, so the text stays something a clipboard can hold. */
const MAX_COPY_DOCUMENTS = 5000

interface DocumentResultProps {
  scriptId: string
  resultSet: ResultSet
  statement: StatementRun
  active: boolean
}

export function DocumentResult({ scriptId, resultSet, statement, active }: DocumentResultProps) {
  const model = useDocumentModel(scriptId, resultSet, statement)
  const { store } = resultSet
  const source = useMemo(() => documentSource(resultSet.columns), [resultSet.columns])
  const [view, setView] = useState<View>(lastView)
  const [selection, setSelection] = useState<RowSelection | null>(null)
  const [reviewing, setReviewing] = useState(false)
  /** Asks the inspector to open its editor for a row: set by Add, Clone, and a cell holding nested values. */
  const [editRequest, setEditRequest] = useState<{ row: number; nonce: number } | null>(null)

  // ───────── the fields of the result, found as documents arrive ─────────

  const scanner = useMemo(() => new ColumnScanner(), [])
  const [scanTick, setScanTick] = useState(0)
  const columns = useMemo(() => {
    scanner.scan(store.rows)
    return scanner.columns()
    // `version` says the store has more rows; `scanTick` asks for the next pass over them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanner, store, model.version, scanTick])
  useEffect(() => {
    if (!scanner.behind(store.rows.length)) return
    const timer = setTimeout(() => setScanTick((n) => n + 1), 16)
    return () => clearTimeout(timer)
  }, [scanner, store, columns, scanTick, model.version])

  const changeView = (next: View): void => {
    lastView = next
    setView(next)
  }

  // ───────── selection ─────────

  const selectedRows = useCallback((): DocumentRow[] => {
    if (!selection) return []
    const from = Math.min(selection.anchor, selection.focus)
    const to = Math.max(selection.anchor, selection.focus)
    const rows: DocumentRow[] = []
    for (let i = from; i <= to && i < model.totalRows; i++) {
      const row = model.rowAt(i)
      if (row) rows.push(row)
    }
    return rows
  }, [selection, model])

  const open = (row: number): void => {
    setSelection({ anchor: row, focus: row })
    setEditRequest({ row, nonce: Date.now() })
  }

  const remove = (): void => {
    const rows = selectedRows()
    if (rows.length === 0) return notify('Select the documents to delete first.')
    if (model.blockedReason) return notify(model.blockedReason)
    if (model.locked) return notify('Editing is locked. Unlock writes first.')
    model.toggleDelete(rows)
  }

  const addDocument = (document: Json = {}): void => {
    if (model.blockedReason) return notify(model.blockedReason)
    if (model.locked) return notify('Editing is locked. Unlock writes first.')
    model.add(document)
    // The new document is the last row; show it, ready to be typed into.
    const row =
      store.length + (useDocumentEdits.getState().byOwner[resultSet.id]?.inserts.length ?? 1) - 1
    setSelection({ anchor: row, focus: row })
    setEditRequest({ row, nonce: Date.now() })
  }

  // ───────── copy ─────────

  const copy = useCallback(
    async (format: string): Promise<void> => {
      const rows = selectedRows().slice(0, MAX_COPY_DOCUMENTS)
      if (rows.length === 0) return notify('Select some documents first.')
      const documents = rows.map((row) => row.document)
      const text =
        format === 'json'
          ? formatRelaxedJson(documents.length === 1 ? documents[0]! : documents, 2)
          : documents.map((document) => formatShell(document, { indent: 2 })).join('\n')
      await writeClipboard(text)
      notify(
        `Copied ${documents.length.toLocaleString()} document${documents.length === 1 ? '' : 's'}.`,
      )
    },
    [selectedRows],
  )

  const actions = useRef({ copy })
  useEffect(() => {
    actions.current = { copy }
  })
  const handle = useMemo<GridHandle>(
    () => ({
      copy: (format) => void actions.current.copy(format),
      generate: () => notify('That is for SQL results. Copy the document instead.'),
      follow: () => notify('Documents have no foreign keys.'),
    }),
    [],
  )
  useEffect(() => () => clearActiveGrid(handle), [handle])

  // ───────── Save and Discard from the keyboard and the command palette ─────────

  const api = useRef({ count: 0, commit: model.commit, discard: model.discard })
  useEffect(() => {
    api.current = { count: model.changeCount, commit: model.commit, discard: model.discard }
  })
  const hasChanges = model.changeCount > 0
  useEffect(() => {
    if (!active || !hasChanges) return
    return registerEditHandle(scriptId, {
      count: () => api.current.count,
      commit: () => void api.current.commit(),
      discard: () => api.current.discard(),
    })
  }, [active, hasChanges, scriptId])

  // ───────── the inspector follows the selected document ─────────

  const focusRow = selection?.focus ?? null
  const shown = focusRow === null ? undefined : model.rowAt(focusRow)
  const wantsEditor = editRequest !== null && editRequest.row === focusRow
  const shownKey = shown
    ? `${resultSet.id}:${shown.insertKey ?? shown.key ?? shown.index}:${wantsEditor ? editRequest.nonce : 0}`
    : null
  useEffect(() => {
    if (!active) return
    const inspector = useInspector.getState()
    if (focusRow === null || !shown || !source || shownKey === null)
      return inspector.setDocument(null)
    inspector.setDocument({
      ownerId: resultSet.id,
      id: shownKey,
      database: source.database,
      collection: source.collection,
      rowIndex: focusRow,
      rowCount: model.totalRows,
      document: shown.document,
      original: shown.original,
      state: shown.state,
      blockedReason: model.blockedReason,
      locked: model.locked,
      editOnOpen: wantsEditor,
      unlock: model.unlock,
      stage: (next) => model.stage(shown, next),
      toggleDelete: () => model.toggleDelete([shown]),
      clone: () => {
        const clone =
          typeof shown.document === 'object' &&
          shown.document !== null &&
          !Array.isArray(shown.document)
            ? Object.fromEntries(Object.entries(shown.document).filter(([key]) => key !== '_id'))
            : {}
        addDocument(clone as Json)
      },
      revert: () =>
        useDocumentEdits.getState().stageUpdate(resultSet.id, shown.original, shown.original),
      move: (delta) => setSelection({ anchor: focusRow + delta, focus: focusRow + delta }),
    })
    // The target is rebuilt whenever what it describes changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active,
    focusRow,
    shown,
    source,
    shownKey,
    model.totalRows,
    model.blockedReason,
    model.locked,
  ])

  useEffect(
    () => () => {
      const inspector = useInspector.getState()
      if (inspector.document?.ownerId === resultSet.id) inspector.setDocument(null)
    },
    [resultSet.id],
  )
  useEffect(() => {
    if (active) return
    const inspector = useInspector.getState()
    if (inspector.document?.ownerId === resultSet.id) inspector.setDocument(null)
  }, [active, resultSet.id])

  // ───────── drawing ─────────

  const writable = useScripts((state) => state.scripts[scriptId]?.writable ?? false)
  const selectedCount = selection ? Math.abs(selection.focus - selection.anchor) + 1 : 0
  const shared = {
    model,
    selection,
    onSelect: setSelection,
    onOpen: open,
    onDelete: remove,
    onCopy: () => void copy('shell'),
    onFocused: () => setActiveGrid(handle),
    onBlurred: () => clearActiveGrid(handle),
  }

  return (
    <div className="grid-wrap doc-result">
      <div className="edit-bar-wrap">
        <div className="edit-bar">
          <Segmented<View>
            label="View"
            value={view}
            onChange={changeView}
            options={[
              { value: 'table', label: 'Table' },
              { value: 'tree', label: 'Tree' },
            ]}
          />
          <span className="doc-view-icons" aria-hidden>
            {view === 'table' ? <Table2 size={13} /> : <ListTree size={13} />}
          </span>

          {model.blockedReason ? (
            <span className="muted edit-reason" title={model.blockedReason}>
              Read-only result. {model.blockedReason}
            </span>
          ) : writable ? (
            <>
              <Button variant="ghost" icon={<Plus size={13} />} onClick={() => addDocument()}>
                Add document
              </Button>
              <Button variant="ghost" icon={<Trash2 size={13} />} onClick={remove}>
                Delete
              </Button>
            </>
          ) : (
            <>
              <span className="muted">Editing is locked.</span>
              <Button variant="ghost" icon={<LockOpen size={13} />} onClick={model.unlock}>
                Unlock writes
              </Button>
            </>
          )}

          <span className="spacer" />

          {model.changeCount > 0 ? (
            <>
              <span className="edit-count">
                {model.changeCount} unsaved change{model.changeCount === 1 ? '' : 's'}
              </span>
              <Button
                variant="ghost"
                onClick={() => setReviewing((on) => !on)}
                aria-expanded={reviewing}
              >
                {reviewing ? 'Hide commands' : 'Review commands'}
              </Button>
              <Button variant="ghost" onClick={model.discard}>
                Discard
              </Button>
              <Button
                variant="primary"
                onClick={() => void model.commit()}
                title={`Save every staged change (${formatShortcut('Mod+S', window.dbide.platform).join('')})`}
              >
                {model.committing ? 'Saving…' : `Save ${model.changeCount}`}
              </Button>
            </>
          ) : !model.blockedReason && writable ? (
            <span className="muted edit-hint">
              Double-click a cell to edit it, or press Space to open the document.
            </span>
          ) : null}
        </div>
        {model.commitError ? (
          <p className="note-error edit-error" role="alert">
            {model.commitError}
          </p>
        ) : null}
        {reviewing && model.changeCount > 0 ? (
          <pre className="edit-preview mono selectable" aria-label="Commands that will run">
            {model.previews.join('\n')}
          </pre>
        ) : null}
      </div>

      {view === 'table' ? (
        <DocumentTable {...shared} columns={columns} hidden={scanner.hidden} />
      ) : (
        <DocumentTree {...shared} />
      )}

      <div className="grid-footer" aria-live="polite">
        <span>
          {selectedCount === 0
            ? 'Click a document to select it. Its text appears in the inspector.'
            : selectedCount === 1 && selection
              ? `Document ${(selection.focus + 1).toLocaleString()}`
              : `${selectedCount.toLocaleString()} documents`}
        </span>
      </div>
    </div>
  )
}
