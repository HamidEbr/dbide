import { CircleCheck, FileUp, LoaderCircle, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CoreEvents, type ImportProgress } from '@shared/api'
import { dialectOf, type SqlDialect } from '@shared/dialect'
import { ENVIRONMENT_POLICIES } from '@shared/environment'
import {
  formatOfFile,
  typeFor,
  tableNameOfFile,
  type ImportDelimiter,
  type ImportFormat,
  type ImportPreview,
  type ImportSource,
} from '@shared/import'
import { RpcError } from '@shared/rpc'
import { Button, Field, IconButton, Segmented } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { useData } from '@/state/data'
import { useDialogs, type ImportRequest } from '@/state/dialogs'
import { notify } from '@/state/notices'

const NEW_TABLE = '\u0000new'
const SKIP = ''

const DELIMITERS: { value: ImportDelimiter; label: string }[] = [
  { value: ',', label: 'Comma  ,' },
  { value: ';', label: 'Semicolon  ;' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe  |' },
]

type Phase = 'file' | 'options' | 'running' | 'done' | 'failed'

export function ImportDialog() {
  const request = useDialogs((state) => state.importData)
  if (!request) return null
  return <ImportBody request={request} />
}

function ImportBody({ request }: { request: ImportRequest }) {
  const close = useDialogs((state) => state.closeImportData)
  const connection = useData((state) =>
    state.connections.find((c) => c.id === request.connectionId),
  )
  const dialect: SqlDialect = (connection && dialectOf(connection.engine)) || 'mysql'
  const protectedConnection = connection
    ? ENVIRONMENT_POLICIES[connection.environment].readOnlyByDefault
    : false

  const [phase, setPhase] = useState<Phase>('file')
  const [file, setFile] = useState<{ path: string; name: string; size: number } | null>(null)
  const [source, setSource] = useState<ImportSource>({
    format: 'csv',
    delimiter: ',',
    header: true,
  })
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [tables, setTables] = useState<string[]>([])
  const [table, setTable] = useState<string>(request.table ?? NEW_TABLE)
  const [newName, setNewName] = useState('')
  const [targetColumns, setTargetColumns] = useState<string[]>([])
  /** For each column of the file: the table column it goes to, or SKIP. */
  const [mapping, setMapping] = useState<string[]>([])
  /** For a new table: the name and type of each column of the file. */
  const [created, setCreated] = useState<{ name: string; type: string; use: boolean }[]>([])
  const [emptyAsNull, setEmptyAsNull] = useState(true)
  const [skipDuplicates, setSkipDuplicates] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [rows, setRows] = useState(0)
  const [done, setDone] = useState<{ rows: number; durationMs: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    coreLink
      .call('schema.detail', { connectionId: request.connectionId, database: request.database })
      .then((detail) => setTables(detail.tables.filter((t) => !t.view).map((t) => t.name)))
      .catch(() => undefined)
    return () => controller.current?.abort()
  }, [request.connectionId, request.database])

  const isNew = table === NEW_TABLE

  const loadPreview = async (path: string, next: ImportSource): Promise<void> => {
    setError(null)
    try {
      const result = await coreLink.call('import.preview', { path, source: next })
      setPreview(result)
      setCreated(
        result.columns.map((name, i) => ({
          name,
          type: typeFor(result.types[i]!, dialect),
          use: true,
        })),
      )
      setPhase('options')
    } catch (e) {
      setPreview(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const choose = async (): Promise<void> => {
    const picked = await coreLink.call('import.choose', undefined)
    if (!picked) return
    const next: ImportSource = { ...source, format: formatOfFile(picked.name) }
    setFile(picked)
    setSource(next)
    setNewName(tableNameOfFile(picked.name))
    await loadPreview(picked.path, next)
  }

  // Columns of the table the rows go into, and a first match by name.
  useEffect(() => {
    if (isNew || !preview) return
    let alive = true
    coreLink
      .call('tables.describe', {
        connectionId: request.connectionId,
        schema: request.database,
        table,
      })
      .then((description) => {
        if (!alive) return
        const names = description.columns.filter((c) => !c.generated).map((c) => c.name)
        setTargetColumns(names)
        setMapping(
          preview.columns.map(
            (name) => names.find((n) => n.toLowerCase() === name.toLowerCase()) ?? SKIP,
          ),
        )
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [isNew, table, preview, request.connectionId, request.database])

  const setFormat = (format: ImportFormat): void => {
    const next = { ...source, format }
    setSource(next)
    if (file) void loadPreview(file.path, next)
  }
  const setOption = (patch: Partial<ImportSource>): void => {
    const next = { ...source, ...patch }
    setSource(next)
    if (file) void loadPreview(file.path, next)
  }

  const plan = useMemo(() => {
    if (!preview) return null
    if (isNew) {
      const used = created
        .map((c, index) => ({ ...c, index }))
        .filter((c) => c.use && c.name.trim() !== '')
      return {
        create: used.map((c) => ({ name: c.name.trim(), type: c.type.trim() })),
        mapping: used.map((c) => ({ source: c.index, target: c.name.trim() })),
      }
    }
    return {
      create: null,
      mapping: mapping.flatMap((target, index) =>
        target === SKIP ? [] : [{ source: index, target }],
      ),
    }
  }, [preview, isNew, created, mapping])

  const tableName = isNew ? newName.trim() : table
  const duplicateNew = isNew && tables.some((t) => t.toLowerCase() === tableName.toLowerCase())
  const mappedTwice =
    plan !== null &&
    new Set(plan.mapping.map((m) => m.target.toLowerCase())).size !== plan.mapping.length
  const problem =
    tableName === ''
      ? 'Name the table.'
      : duplicateNew
        ? 'A table with that name is already there. Pick it from the list instead.'
        : plan === null || plan.mapping.length === 0
          ? 'Match at least one column.'
          : mappedTwice
            ? 'Two columns go to the same column of the table.'
            : protectedConnection && !confirmed
              ? 'Confirm that rows may be added to this connection.'
              : null

  const start = async (): Promise<void> => {
    if (!file || !plan) return
    const importId = crypto.randomUUID()
    const abort = new AbortController()
    controller.current = abort
    setPhase('running')
    setRows(0)
    setError(null)
    const off = coreLink.on(CoreEvents.importProgress, (payload) => {
      const update = payload as ImportProgress
      if (update.importId === importId) setRows(update.rows)
    })
    try {
      const result = await coreLink.call(
        'import.run',
        {
          importId,
          connectionId: request.connectionId,
          database: request.database,
          path: file.path,
          source,
          table: tableName,
          create: plan.create,
          mapping: plan.mapping,
          emptyAsNull,
          skipDuplicates,
          confirmed,
        },
        { signal: abort.signal },
      )
      setDone(result)
      setPhase('done')
    } catch (e) {
      if (abort.signal.aborted || (e instanceof RpcError && e.code === 'ABORTED')) {
        setPhase('options')
        notify('Import cancelled. No rows were added.')
      } else {
        setError(e instanceof Error ? e.message : String(e))
        setPhase('failed')
      }
    } finally {
      off()
      controller.current = null
    }
  }

  const running = phase === 'running'
  const textual = source.format === 'csv' || source.format === 'tsv'
  const patchCreated = (
    i: number,
    patch: Partial<{ name: string; type: string; use: boolean }>,
  ): void => setCreated((list) => list.map((c, j) => (j === i ? { ...c, ...patch } : c)))

  return (
    <div className="dialog-overlay" onMouseDown={() => !running && close()}>
      <div
        className="dialog dialog-explain"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          if (running) controller.current?.abort()
          else close()
        }}
      >
        <header>
          <FileUp size={18} className="dialog-icon neutral" aria-hidden />
          <h2 id="import-title">Import into {request.database}</h2>
          {!running ? (
            <IconButton label="Close" onClick={close}>
              <X size={14} />
            </IconButton>
          ) : null}
        </header>

        {phase === 'done' && done ? (
          <div className="export-done" role="status">
            <p>
              <CircleCheck size={16} className="step-ok" aria-hidden />{' '}
              <strong>{done.rows.toLocaleString()}</strong> row{done.rows === 1 ? '' : 's'} added to{' '}
              <span className="mono">{tableName}</span> in {(done.durationMs / 1000).toFixed(1)} s
            </p>
            <footer>
              <Button variant="primary" onClick={close} autoFocus>
                Done
              </Button>
            </footer>
          </div>
        ) : (
          <>
            <p className="muted export-note">
              Rows go in one transaction: if anything fails, or you cancel, none are added.
            </p>
            <div className="export-checks">
              <Button icon={<FileUp size={13} />} onClick={() => void choose()} disabled={running}>
                {file ? 'Choose another file…' : 'Choose a file…'}
              </Button>
              {file ? (
                <span className="muted mono">
                  {file.name} · {(file.size / 1024).toFixed(file.size < 10240 ? 1 : 0)} KB
                </span>
              ) : (
                <span className="muted">CSV, TSV, JSON or JSON Lines</span>
              )}
            </div>

            {file ? (
              <fieldset className="export-fields" disabled={running}>
                <Segmented<ImportFormat>
                  label="Format"
                  value={source.format}
                  options={[
                    { value: 'csv', label: 'CSV' },
                    { value: 'tsv', label: 'TSV' },
                    { value: 'json', label: 'JSON' },
                    { value: 'ndjson', label: 'JSON Lines' },
                  ]}
                  onChange={setFormat}
                />
                {textual ? (
                  <div className="export-grid">
                    {source.format === 'csv' ? (
                      <Field label="Separator">
                        {(id) => (
                          <select
                            id={id}
                            value={source.delimiter}
                            onChange={(event) =>
                              setOption({ delimiter: event.target.value as ImportDelimiter })
                            }
                          >
                            {DELIMITERS.map((d) => (
                              <option key={d.value} value={d.value}>
                                {d.label}
                              </option>
                            ))}
                          </select>
                        )}
                      </Field>
                    ) : null}
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={source.header}
                        onChange={(event) => setOption({ header: event.target.checked })}
                      />
                      <span>The first row holds the column names</span>
                    </label>
                  </div>
                ) : null}
              </fieldset>
            ) : null}

            {error && phase !== 'failed' ? (
              <p className="note-error" role="alert">
                {error}
              </p>
            ) : null}

            {preview ? (
              <>
                <div className="import-preview">
                  <table>
                    <thead>
                      <tr>
                        {preview.columns.map((c, i) => (
                          <th key={i} className="mono">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.slice(0, 5).map((row, r) => (
                        <tr key={r}>
                          {row.map((v, i) => (
                            <td key={i} className={v === null ? 'muted' : ''}>
                              {v === null ? 'NULL' : v}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <fieldset className="export-fields" disabled={running}>
                  <Field label="Into">
                    {(id) => (
                      <select
                        id={id}
                        value={table}
                        onChange={(event) => setTable(event.target.value)}
                      >
                        <option value={NEW_TABLE}>A new table…</option>
                        {tables.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  {isNew ? (
                    <Field label="New table name">
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
                  ) : null}

                  <div className="import-map" role="group" aria-label="Columns">
                    {preview.columns.map((column, i) =>
                      isNew ? (
                        <div className="import-map-row" key={i}>
                          <label className="check">
                            <input
                              type="checkbox"
                              checked={created[i]?.use ?? true}
                              onChange={(event) => patchCreated(i, { use: event.target.checked })}
                            />
                            <span className="mono">{column}</span>
                          </label>
                          <input
                            className="mono"
                            aria-label={`Name of ${column}`}
                            value={created[i]?.name ?? ''}
                            spellCheck={false}
                            onChange={(event) => patchCreated(i, { name: event.target.value })}
                          />
                          <input
                            className="mono"
                            aria-label={`Type of ${column}`}
                            value={created[i]?.type ?? ''}
                            spellCheck={false}
                            onChange={(event) => patchCreated(i, { type: event.target.value })}
                          />
                        </div>
                      ) : (
                        <div className="import-map-row" key={i}>
                          <span className="mono">{column}</span>
                          <span className="muted">→</span>
                          <select
                            aria-label={`Column for ${column}`}
                            value={mapping[i] ?? SKIP}
                            onChange={(event) =>
                              setMapping((list) =>
                                list.map((m, j) => (j === i ? event.target.value : m)),
                              )
                            }
                          >
                            <option value={SKIP}>(skip)</option>
                            {targetColumns.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </div>
                      ),
                    )}
                  </div>
                  {isNew ? (
                    <p className="muted">
                      Types are guessed from the first {preview.sampled.toLocaleString()} rows;
                      change one if it is wrong. All columns allow NULL.
                    </p>
                  ) : null}

                  <div className="export-checks">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={emptyAsNull}
                        onChange={(event) => setEmptyAsNull(event.target.checked)}
                      />
                      <span>Empty values become NULL</span>
                    </label>
                    {isNew || dialect === 'mssql' ? null : (
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={skipDuplicates}
                          onChange={(event) => setSkipDuplicates(event.target.checked)}
                        />
                        <span>Leave out rows that repeat a key already in the table</span>
                      </label>
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
                          {ENVIRONMENT_POLICIES[connection!.environment].label.toLowerCase()}{' '}
                          connection: I want to add rows to it
                        </span>
                      </label>
                    ) : null}
                  </div>
                </fieldset>
              </>
            ) : null}

            {running ? (
              <p className="export-progress" role="status">
                <LoaderCircle size={14} className="spin" aria-hidden /> {rows.toLocaleString()} rows
                added…
              </p>
            ) : null}
            {phase === 'failed' && error ? (
              <p className="note-error" role="alert">
                {error} No rows were added.
              </p>
            ) : null}
            {phase === 'options' && problem ? <p className="muted">{problem}</p> : null}

            <footer>
              {running ? (
                <Button variant="danger" onClick={() => controller.current?.abort()}>
                  Cancel import
                </Button>
              ) : (
                <>
                  <Button variant="ghost" onClick={close}>
                    Close
                  </Button>
                  <Button
                    variant="primary"
                    disabled={!preview || problem !== null}
                    onClick={() => void start()}
                  >
                    Import
                  </Button>
                </>
              )}
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
