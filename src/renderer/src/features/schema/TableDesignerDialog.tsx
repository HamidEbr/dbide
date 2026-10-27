import { LoaderCircle, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { dropTable, renameTable } from '@shared/ddl'
import { dialectOf, type SqlDialect } from '@shared/dialect'
import { ENVIRONMENT_POLICIES } from '@shared/environment'
import type { TableDescription } from '@shared/edit'
import {
  buildDesignerStatements,
  COMMON_TYPES,
  draftFrom,
  isChanged,
  newColumn,
  problemWith,
  type DraftColumn,
} from '@shared/table-designer'
import { Button, Field, IconButton } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { schemaCache } from '@/features/sql/completion/schema-cache'
import { useData } from '@/state/data'
import { useDialogs, type TableDesignerRequest } from '@/state/dialogs'
import { notify } from '@/state/notices'
import { useTables } from '@/state/tables'
import { useTree } from '@/state/tree'

export function TableDesignerDialog() {
  const request = useDialogs((state) => state.tableDesigner)
  if (!request) return null
  return <DesignerBody request={request} />
}

function DesignerBody({ request }: { request: TableDesignerRequest }) {
  const close = useDialogs((state) => state.closeTableDesigner)
  const { connectionId, schema, table } = request
  const connection = useData((state) => state.connections.find((c) => c.id === connectionId))
  const dialect: SqlDialect = (connection && dialectOf(connection.engine)) || 'mysql'
  const protectedConnection = connection
    ? ENVIRONMENT_POLICIES[connection.environment].readOnlyByDefault
    : false

  const [description, setDescription] = useState<TableDescription | null>(null)
  const [draft, setDraft] = useState<DraftColumn[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [confirmed, setConfirmed] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState(0)
  const [newName, setNewName] = useState(table)
  const [typedName, setTypedName] = useState('')

  useEffect(() => {
    let alive = true
    coreLink
      .call('tables.describe', { connectionId, schema, table })
      .then((d) => {
        if (!alive) return
        setDescription(d)
        setDraft(draftFrom(d.columns, d.primaryKey))
      })
      .catch((e: unknown) => alive && setLoadError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [connectionId, schema, table, version])

  const statements = useMemo(
    () => buildDesignerStatements(dialect, schema, table, draft),
    [dialect, schema, table, draft],
  )
  const problem = problemWith(draft)
  const changed = isChanged(draft)

  const patch = (id: string, change: Partial<DraftColumn>): void =>
    setDraft((list) => list.map((c) => (c.id === id ? { ...c, ...change } : c)))

  /** After a change that reached the server: what was cached about it is out of date. */
  const refresh = (): void => {
    schemaCache.invalidate(connectionId)
    useTables.getState().forget(connectionId, schema, table)
    useTree.getState().reset(connectionId)
  }

  const apply = async (list: string[], afterwards: 'reload' | 'close'): Promise<void> => {
    setRunning(true)
    setError(null)
    try {
      const result = await coreLink.call('ddl.run', {
        connectionId,
        database: schema,
        statements: list,
        confirmed,
      })
      notify(`${result.ran} change${result.ran === 1 ? '' : 's'} made.`)
      refresh()
      if (afterwards === 'close') close()
      else {
        setAdded(0)
        setVersion((v) => v + 1)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      // Some may have been made before one failed.
      refresh()
    } finally {
      setRunning(false)
    }
  }

  const renameStatement =
    newName.trim() !== '' && newName.trim() !== table
      ? renameTable(dialect, schema, table, newName.trim())
      : null
  const dropStatement = dropTable(dialect, schema, table, request.view === true)
  const guarded = protectedConnection && !confirmed

  return (
    <div className="dialog-overlay" onMouseDown={() => !running && close()}>
      <div
        className="dialog dialog-designer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="designer-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          if (!running) close()
        }}
      >
        <header>
          <h2 id="designer-title">
            {schema}.{table}
          </h2>
          <IconButton label="Close" onClick={close}>
            <X size={14} />
          </IconButton>
        </header>

        {loadError ? (
          <p className="note-error" role="alert">
            {loadError}
          </p>
        ) : !description ? (
          <p className="export-progress" role="status">
            <LoaderCircle size={14} className="spin" aria-hidden /> Reading the table…
          </p>
        ) : (
          <>
            <div className="tool-scroll designer-columns">
              <table className="pivot">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>NULL</th>
                    <th>Notes</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {draft.map((c) => (
                    <tr
                      key={c.id}
                      className={
                        c.removed ? 'compare-removed' : c.original === null ? 'compare-added' : ''
                      }
                    >
                      <td>
                        <input
                          className="mono"
                          aria-label={`Name of ${c.original?.name ?? 'the new column'}`}
                          value={c.name}
                          disabled={c.removed || c.locked}
                          spellCheck={false}
                          onChange={(event) => patch(c.id, { name: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="mono"
                          list={`types-${dialect}`}
                          aria-label={`Type of ${c.original?.name ?? 'the new column'}`}
                          value={c.type}
                          disabled={c.removed || c.locked}
                          spellCheck={false}
                          onChange={(event) => patch(c.id, { type: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${c.original?.name ?? 'The new column'} allows NULL`}
                          checked={c.nullable}
                          disabled={c.removed || c.locked}
                          onChange={(event) => patch(c.id, { nullable: event.target.checked })}
                        />
                      </td>
                      <td className="muted">{c.note}</td>
                      <td>
                        {c.original === null ? (
                          <IconButton
                            label="Remove this new column"
                            onClick={() => setDraft((list) => list.filter((x) => x.id !== c.id))}
                          >
                            <X size={13} />
                          </IconButton>
                        ) : c.removed ? (
                          <IconButton
                            label={`Keep ${c.original.name}`}
                            onClick={() => patch(c.id, { removed: false })}
                          >
                            <RotateCcw size={13} />
                          </IconButton>
                        ) : (
                          <IconButton
                            label={`Drop column ${c.original.name}`}
                            disabled={c.locked}
                            onClick={() => patch(c.id, { removed: true })}
                          >
                            <Trash2 size={13} />
                          </IconButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <datalist id={`types-${dialect}`}>
                {COMMON_TYPES[dialect].map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>
            <div className="export-checks">
              <Button
                icon={<Plus size={13} />}
                onClick={() => {
                  setDraft((list) => [...list, newColumn(added + 1)])
                  setAdded((n) => n + 1)
                }}
              >
                Add a column
              </Button>
            </div>

            {(description.foreignKeys ?? []).length > 0 ||
            (description.referencedBy?.length ?? 0) > 0 ? (
              <p className="muted">
                {(description.foreignKeys ?? [])
                  .map((k) => `${k.columns.join(', ')} → ${k.refTable}(${k.refColumns.join(', ')})`)
                  .join(' · ')}
                {(description.foreignKeys ?? []).length > 0 &&
                (description.referencedBy?.length ?? 0) > 0
                  ? ' · '
                  : ''}
                {(description.referencedBy ?? [])
                  .map((k) => `${k.table}(${k.columns.join(', ')}) → here`)
                  .join(' · ')}
              </p>
            ) : null}

            {changed ? (
              <>
                <pre className="dialog-sql mono selectable export-sql" tabIndex={0}>
                  {problem ? `-- ${problem}` : statements.join('\n')}
                </pre>
              </>
            ) : (
              <p className="muted">
                Change a name, a type or NULL, add or drop a column, and the SQL appears here.
              </p>
            )}

            {protectedConnection ? (
              <label className="check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>
                  {connection?.name} is a{' '}
                  {ENVIRONMENT_POLICIES[connection!.environment].label.toLowerCase()} connection: I
                  want to change its schema
                </span>
              </label>
            ) : null}
            {error ? (
              <p className="note-error" role="alert">
                {error}
              </p>
            ) : null}

            <details className="designer-table-actions">
              <summary>Rename or drop the table</summary>
              <div className="tool-controls">
                <Field label="New name">
                  {(id) => (
                    <input
                      id={id}
                      className="mono"
                      value={newName}
                      spellCheck={false}
                      onChange={(event) => setNewName(event.target.value)}
                    />
                  )}
                </Field>
                <Button
                  disabled={!renameStatement || running || guarded}
                  onClick={() => void apply([renameStatement!], 'close')}
                >
                  Rename
                </Button>
              </div>
              <div className="tool-controls">
                <Field
                  label={`Type ${table} to drop it`}
                  hint="Dropping removes the table and all its rows."
                >
                  {(id) => (
                    <input
                      id={id}
                      className="mono"
                      value={typedName}
                      spellCheck={false}
                      onChange={(event) => setTypedName(event.target.value)}
                    />
                  )}
                </Field>
                <Button
                  variant="danger"
                  icon={<Trash2 size={13} />}
                  disabled={typedName !== table || running || guarded}
                  onClick={() => void apply([dropStatement], 'close')}
                >
                  Drop {request.view ? 'view' : 'table'}
                </Button>
              </div>
            </details>

            <footer>
              <Button variant="ghost" onClick={close}>
                Close
              </Button>
              <Button variant="ghost" disabled={!changed} onClick={() => setVersion((v) => v + 1)}>
                Discard changes
              </Button>
              <Button
                variant="primary"
                disabled={!changed || problem !== null || running || guarded}
                onClick={() => void apply(statements, 'reload')}
              >
                {running ? 'Applying…' : 'Apply changes'}
              </Button>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
