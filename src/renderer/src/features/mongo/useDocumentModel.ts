import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { documentSource } from '@shared/mongo/documents'
import type { Json } from '@shared/mongo/ejson'
import { notify } from '@/state/notices'
import { useScripts, type ResultSet, type StatementRun } from '@/state/scripts'
import { setWritable } from '@/features/sql/actions'
import { commitDocuments } from './commit'
import { keyOf, parseDocument } from './docs'
import { changeCount, previews, stateOf, useDocumentEdits } from './edits'

export type DocumentRowState = 'clean' | 'changed' | 'deleted' | 'new'

/** One row of the result as it looks now: the document with its staged edits applied. */
export interface DocumentRow {
  index: number
  /** The document as it was loaded (or as it was first drafted, for a new one). */
  original: Json
  /** The document with the staged edits applied. */
  document: Json
  state: DocumentRowState
  /** The `_id` key, or null for a document without one. */
  key: string | null
  /** Set for a document that has not been saved yet. */
  insertKey?: string
}

export interface DocumentModel {
  resultSet: ResultSet
  scriptId: string
  /** Rows loaded plus new documents that were added. */
  totalRows: number
  /** Bumps when rows arrive or change; views redraw on it. */
  version: number
  rowAt: (index: number) => DocumentRow | undefined
  /** Why the documents can't be edited, or null when they can. */
  blockedReason: string | null
  /** Editing is possible but writes are locked. */
  locked: boolean
  unlock: () => void
  /** Stages a document's new contents. Returns why it can't, or null. */
  stage: (row: DocumentRow, next: Json) => string | null
  toggleDelete: (rows: DocumentRow[]) => void
  add: (document: Json) => string
  changeCount: number
  previews: string[]
  committing: boolean
  commitError: string | null
  commit: () => Promise<boolean>
  discard: () => void
}

/**
 * What the views of a document result share: the rows, the staged changes, and what can be done with
 * them. The rows come from the result's store; edits live in their own store keyed by the result.
 */
export function useDocumentModel(
  scriptId: string,
  resultSet: ResultSet,
  statement: StatementRun,
): DocumentModel {
  const { store } = resultSet
  const version = useSyncExternalStore(store.subscribe, store.getVersion)
  const writable = useScripts((state) => state.scripts[scriptId]?.writable ?? false)
  const edits = useDocumentEdits((state) => state.byOwner[resultSet.id])
  const source = useMemo(() => documentSource(resultSet.columns), [resultSet.columns])
  const [committing, setCommitting] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)

  const blockedReason = !source
    ? 'Only documents read straight from a collection with find() or findOne() can be edited.'
    : statement.status !== 'done' && statement.status !== 'paused'
      ? 'Wait for the query to finish first.'
      : store.spilled > 0
        ? 'This result is large, so it is read-only. Narrow the query to edit.'
        : null

  const inserts = edits?.inserts ?? []
  const totalRows = store.length + inserts.length

  const rowAt = useCallback(
    (index: number): DocumentRow | undefined => {
      if (index < store.length) {
        const document = parseDocument(store.getRow(index)?.[0])
        if (document === undefined) return undefined
        const staged = stateOf(edits, document)
        return {
          index,
          original: document,
          document: staged.document,
          state: staged.state,
          key: keyOf(document),
        }
      }
      const draft = inserts[index - store.length]
      return draft
        ? {
            index,
            original: draft.document,
            document: draft.document,
            state: 'new',
            key: null,
            insertKey: draft.key,
          }
        : undefined
    },
    // `version` is how the store says its rows changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, edits, inserts, version],
  )

  const stage = useCallback(
    (row: DocumentRow, next: Json): string | null => {
      if (blockedReason) return blockedReason
      if (row.insertKey !== undefined) {
        useDocumentEdits.getState().setInsert(resultSet.id, row.insertKey, next)
        return null
      }
      return useDocumentEdits.getState().stageUpdate(resultSet.id, row.original, next)
    },
    [blockedReason, resultSet.id],
  )

  const toggleDelete = useCallback(
    (rows: DocumentRow[]): void => {
      const state = useDocumentEdits.getState()
      const saved = rows.filter((row) => row.insertKey === undefined)
      for (const row of rows) {
        if (row.insertKey !== undefined) state.removeInsert(resultSet.id, row.insertKey)
      }
      if (saved.length > 0)
        state.toggleDelete(
          resultSet.id,
          saved.map((row) => row.original),
        )
    },
    [resultSet.id],
  )

  const add = useCallback(
    (document: Json): string => useDocumentEdits.getState().addInsert(resultSet.id, document),
    [resultSet.id],
  )

  const commit = useCallback(async (): Promise<boolean> => {
    if (committing) return false
    setCommitting(true)
    setCommitError(null)
    try {
      const problem = await commitDocuments(scriptId, resultSet)
      if (problem) {
        setCommitError(problem)
        return false
      }
      notify('Saved.')
      return true
    } finally {
      setCommitting(false)
    }
  }, [committing, scriptId, resultSet])

  const discard = useCallback((): void => {
    useDocumentEdits.getState().discard(resultSet.id)
    setCommitError(null)
  }, [resultSet.id])

  const shown = source ? previews(edits, source) : []

  return {
    resultSet,
    scriptId,
    totalRows,
    version,
    rowAt,
    blockedReason,
    locked: blockedReason === null && !writable,
    unlock: () => void setWritable(scriptId, true),
    stage,
    toggleDelete,
    add,
    changeCount: changeCount(edits),
    previews: shown,
    committing,
    commitError,
    commit,
    discard,
  }
}
