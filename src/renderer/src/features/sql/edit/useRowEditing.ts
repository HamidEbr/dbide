import { useCallback, useEffect, useMemo, useState } from 'react'
import { dialectOf, type SqlDialect } from '@shared/dialect'
import {
  buildEditStatements,
  singleSourceTable,
  type TableColumn,
  type TableDescription,
} from '@shared/edit'
import { RESIDENT_ROWS, type Cell } from '@shared/query'
import { RpcError } from '@shared/rpc'
import { coreLink } from '@/ipc/link'
import { useData } from '@/state/data'
import { edits, useEdits } from '@/state/edits'
import { useGuard } from '@/state/guard'
import { notify } from '@/state/notices'
import { useScripts, type ResultSet, type StatementRun } from '@/state/scripts'
import { tableKey, useTables } from '@/state/tables'
import { setWritable } from '../actions'
import { evaluateRun } from '../guard'
import { applySavedChanges } from './apply'
import {
  columnTypes,
  countChanges,
  emptyChangeSet,
  toEditBatch,
  type ChangeSet,
} from './change-set'

const NO_CHANGES: ChangeSet = emptyChangeSet()
const NO_COLUMNS: ReadonlySet<number> = new Set()

export interface EffectiveRow {
  /** The row as it looks with staged edits applied. `undefined` means the table default. */
  cells: (Cell | undefined)[]
  state: 'normal' | 'deleted' | 'new'
  changed: ReadonlySet<number>
  /** For a new row: its id in the change set. */
  newId?: string
}

type Availability =
  | { status: 'unavailable'; reason: string }
  | { status: 'loading' }
  | {
      status: 'ready'
      table: TableDescription
      /** Positions of the primary key columns in the result. */
      pk: number[]
      /** The table's column behind each result column. */
      meta: (TableColumn | undefined)[]
    }

export interface RowEditing {
  status: Availability['status']
  /** The table the result reads from, once its keys are known and the result can be edited. */
  table: TableDescription | null
  /** Why the result can't be edited, when it can't. */
  reason: string | null
  /** False while the script is read-only. Editing is possible but writing is locked. */
  writable: boolean
  changeSet: ChangeSet
  changeCount: number
  totalRows: number
  /** The SQL that would run, one statement per change. */
  preview: string[]
  committing: boolean
  commitError: string | null
  /** `peek` leaves it be when the row is one the core holds, instead of asking for it. */
  effectiveRow: (row: number, peek?: boolean) => EffectiveRow | null
  /** Why a column can't be edited, or null when it can. */
  blocked: (col: number) => string | null
  /** The table's definition of a result column, once it is known. */
  columnMeta: (col: number) => TableColumn | undefined
  /** Stages a value. Returns a message when it can't be accepted, otherwise null. */
  stageCell: (row: number, col: number, value: Cell) => string | null
  toggleDelete: (rows: number[]) => void
  /** Adds a row of defaults and returns its index. */
  addRow: () => number
  discard: () => void
  commit: () => Promise<boolean>
  unlock: () => void
}

/**
 * Everything the grid needs to edit one result: whether it can be edited at all, the staged
 * changes, and saving them. A result is editable when it is a plain read of one table that
 * includes the table's whole primary key; otherwise the reason is spelled out.
 */
export function useRowEditing(
  scriptId: string,
  resultSet: ResultSet,
  statement: StatementRun,
): RowEditing {
  const { columns, store } = resultSet
  const script = useScripts((state) => state.scripts[scriptId])
  const connection = useData((state) =>
    state.connections.find((c) => c.id === script?.connectionId),
  )
  const dialect: SqlDialect = (connection && dialectOf(connection.engine)) || 'mysql'
  const changeSet = useEdits((state) => state.sets[resultSet.id]) ?? NO_CHANGES
  const [committing, setCommitting] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)

  const connectionId = script?.connectionId ?? ''
  const source = useMemo(() => singleSourceTable(columns), [columns])
  const sourceKey = 'reason' in source ? null : tableKey(connectionId, source.schema, source.table)
  const tableState = useTables((state) => (sourceKey ? state.tables[sourceKey] : undefined))

  const statementDone = statement.status === 'done' || statement.status === 'paused'
  useEffect(() => {
    if (!('reason' in source) && statementDone && connectionId) {
      useTables.getState().load(connectionId, source.schema, source.table)
    }
  }, [source, statementDone, connectionId])

  const availability = useMemo((): Availability => {
    if ('reason' in source) return { status: 'unavailable', reason: source.reason }
    // Rows the core holds can't be edited in place: they aren't here to change or to address by key.
    if (store.spilled > 0) {
      return {
        status: 'unavailable',
        reason: `It has more than ${RESIDENT_ROWS.toLocaleString()} rows, which is too many to edit in place. Narrow the query to edit rows.`,
      }
    }
    if (!statementDone) {
      return { status: 'unavailable', reason: 'Rows can be edited once the query has finished.' }
    }
    if (!tableState || tableState.status === 'loading') return { status: 'loading' }
    if (tableState.status === 'error') {
      return {
        status: 'unavailable',
        reason: `Couldn’t read the table’s keys. ${tableState.message}`,
      }
    }
    const { table } = tableState
    if (table.primaryKey.length === 0) {
      return {
        status: 'unavailable',
        reason: `${table.table} has no primary key, so its rows can’t be told apart.`,
      }
    }
    const pk = table.primaryKey.map((name) => columns.findIndex((c) => c.source?.column === name))
    const missing = table.primaryKey.find((_, i) => pk[i] === -1)
    if (missing) {
      return {
        status: 'unavailable',
        reason: `Include the primary key column “${missing}” in the query to edit rows.`,
      }
    }
    const meta = columns.map((c) => table.columns.find((t) => t.name === c.source?.column))
    return { status: 'ready', table, pk, meta }
    // The store changes outside React; the grid renders again whenever it does.
  }, [source, statementDone, tableState, columns, store.spilled])

  const writable = script?.writable ?? false
  const totalRows = store.length + changeSet.inserts.length

  const effectiveRow = useCallback(
    (row: number, peek = false): EffectiveRow | null => {
      const loaded = store.length
      if (row < loaded) {
        const base = peek ? store.peekRow(row) : store.getRow(row)
        if (!base) return null
        const update = changeSet.updates[row]
        return {
          cells: update ? base.map((v, c) => (c in update.values ? update.values[c] : v)) : base,
          state: row in changeSet.deletes ? 'deleted' : 'normal',
          changed: update ? new Set(Object.keys(update.values).map(Number)) : NO_COLUMNS,
        }
      }
      const added = changeSet.inserts[row - loaded]
      if (!added) return null
      return {
        cells: columns.map((_, c) => added.values[c]),
        state: 'new',
        changed: new Set(Object.keys(added.values).map(Number)),
        newId: added.id,
      }
    },
    [store, changeSet, columns],
  )

  const blocked = useCallback(
    (col: number): string | null => {
      if (availability.status !== 'ready') {
        return availability.status === 'loading'
          ? 'Still reading the table’s keys.'
          : availability.reason
      }
      const meta = availability.meta[col]
      if (!meta) return 'This column can’t be edited.'
      if (meta.generated) return 'The server computes this column.'
      return null
    },
    [availability],
  )

  const columnMeta = useCallback(
    (col: number): TableColumn | undefined =>
      availability.status === 'ready' ? availability.meta[col] : undefined,
    [availability],
  )

  const stageCell = useCallback(
    (row: number, col: number, value: Cell): string | null => {
      const reason = blocked(col)
      if (reason) return reason
      if (availability.status !== 'ready') return null
      const meta = availability.meta[col]!
      if (value === null && !meta.nullable) return 'This column doesn’t allow NULL.'

      const loaded = store.length
      if (row >= loaded) {
        const added = changeSet.inserts[row - loaded]
        if (added) edits.setNewCell(resultSet.id, added.id, col, value)
        return null
      }
      if (row in changeSet.deletes) return 'This row is marked for deletion.'
      const base = store.getRow(row)
      if (!base) return null
      const key = availability.pk.map((i) => base[i] as Cell)
      edits.setCell(resultSet.id, row, key, col, value, base[col] as Cell, columns[col]!.type)
      return null
    },
    [availability, blocked, store, changeSet, columns, resultSet.id],
  )

  const toggleDelete = useCallback(
    (rows: number[]): void => {
      if (availability.status !== 'ready') return
      const loaded = store.length
      const real: { row: number; key: Cell[] }[] = []
      for (const row of rows) {
        if (row >= loaded) {
          const added = changeSet.inserts[row - loaded]
          if (added) edits.removeRow(resultSet.id, added.id)
          continue
        }
        const base = store.getRow(row)
        if (base) real.push({ row, key: availability.pk.map((i) => base[i] as Cell) })
      }
      if (real.length > 0) edits.toggleDelete(resultSet.id, real)
    },
    [availability, store, changeSet, resultSet.id],
  )

  const addRow = useCallback((): number => {
    edits.addRow(resultSet.id, crypto.randomUUID())
    return store.length + changeSet.inserts.length
  }, [resultSet.id, store, changeSet])

  const discard = useCallback((): void => {
    edits.discard(resultSet.id)
    setCommitError(null)
  }, [resultSet.id])

  const preview = useMemo((): string[] => {
    if (availability.status !== 'ready' || countChanges(changeSet) === 0) return []
    const batch = toEditBatch(changeSet, { columns, table: availability.table })
    return buildEditStatements(batch, columnTypes(availability.table), dialect).map(
      (s) => s.preview,
    )
  }, [availability, changeSet, columns, dialect])

  const commit = useCallback(async (): Promise<boolean> => {
    if (availability.status !== 'ready' || !script || !connection || committing) return false
    if (countChanges(changeSet) === 0) return false
    setCommitError(null)

    const verdict = evaluateRun(preview, {
      environment: connection.environment,
      writable: script.writable,
    })
    if (verdict.action === 'block') {
      setCommitError(verdict.message)
      return false
    }
    if (verdict.action === 'confirm') {
      const confirmed = await useGuard.getState().ask({
        connectionName: connection.name,
        environment: connection.environment,
        statements: preview,
        reasons: verdict.reasons,
        typedName: verdict.typedName,
      })
      if (!confirmed) return false
    }

    setCommitting(true)
    try {
      const batch = toEditBatch(changeSet, { columns, table: availability.table })
      const result = await coreLink.call('edits.apply', {
        connectionId: script.connectionId,
        scriptId,
        batch,
      })
      if (!result.ok) {
        setCommitError(`Change ${result.failedIndex + 1} failed. ${result.message}`)
        return false
      }
      applySavedChanges(store, columns, availability.table, changeSet, result.results)
      edits.discard(resultSet.id)
      const count = countChanges(changeSet)
      notify(`Saved ${count} change${count === 1 ? '' : 's'}.`)
      return true
    } catch (error) {
      setCommitError(
        error instanceof RpcError || error instanceof Error ? error.message : String(error),
      )
      return false
    } finally {
      setCommitting(false)
    }
  }, [
    availability,
    script,
    connection,
    committing,
    changeSet,
    preview,
    columns,
    store,
    scriptId,
    resultSet.id,
  ])

  const unlock = useCallback((): void => void setWritable(scriptId, true), [scriptId])

  return {
    status: availability.status,
    table: availability.status === 'ready' ? availability.table : null,
    reason: availability.status === 'unavailable' ? availability.reason : null,
    writable,
    changeSet,
    changeCount: countChanges(changeSet),
    totalRows,
    preview,
    committing,
    commitError,
    effectiveRow,
    blocked,
    columnMeta,
    stageCell,
    toggleDelete,
    addRow,
    discard,
    commit,
    unlock,
  }
}
