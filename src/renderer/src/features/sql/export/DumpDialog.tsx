import { CircleCheck, Database, FolderOpen, LoaderCircle, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CoreEvents, type ExportProgress } from '@shared/api'
import type { SchemaTable } from '@shared/driver'
import { RpcError } from '@shared/rpc'
import { Button, Field, IconButton } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { useDialogs, type DumpRequest } from '@/state/dialogs'
import { notify } from '@/state/notices'

const formatBytes = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`

type Phase = 'loading' | 'options' | 'running' | 'done' | 'failed'

interface Saved {
  path: string
  rows: number
  bytes: number
  durationMs: number
  tables: number
}

export function DumpDialog() {
  const request = useDialogs((state) => state.dump)
  if (!request) return null
  return <DumpBody request={request} />
}

function Check({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  hint?: string
}) {
  return (
    <label className="check" title={hint}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

function DumpBody({ request }: { request: DumpRequest }) {
  const close = useDialogs((state) => state.closeDump)
  const [phase, setPhase] = useState<Phase>('loading')
  const [tables, setTables] = useState<SchemaTable[]>([])
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [structure, setStructure] = useState(true)
  const [data, setData] = useState(true)
  const [drop, setDrop] = useState(true)
  const [compress, setCompress] = useState(false)
  const [rowsPerInsert, setRowsPerInsert] = useState(100)
  const [progress, setProgress] = useState({ rows: 0, bytes: 0 })
  const [saved, setSaved] = useState<Saved | null>(null)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    let alive = true
    coreLink
      .call('schema.detail', { connectionId: request.connectionId, database: request.database })
      .then((detail) => {
        if (!alive) return
        setTables(detail.tables)
        setChosen(new Set(detail.tables.map((t) => t.name)))
        setPhase('options')
      })
      .catch((e: unknown) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setPhase('failed')
      })
    return () => {
      alive = false
      controller.current?.abort()
    }
  }, [request.connectionId, request.database])

  const shown = useMemo(
    () => tables.filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase())),
    [tables, filter],
  )
  const running = phase === 'running'

  const toggle = (name: string, on: boolean): void =>
    setChosen((current) => {
      const next = new Set(current)
      if (on) next.add(name)
      else next.delete(name)
      return next
    })
  const setShown = (on: boolean): void =>
    setChosen((current) => {
      const next = new Set(current)
      for (const t of shown) {
        if (on) next.add(t.name)
        else next.delete(t.name)
      }
      return next
    })

  const start = async (): Promise<void> => {
    const exportId = crypto.randomUUID()
    const abort = new AbortController()
    controller.current = abort
    setPhase('running')
    setProgress({ rows: 0, bytes: 0 })
    setError(null)
    const off = coreLink.on(CoreEvents.exportProgress, (payload) => {
      const update = payload as ExportProgress
      if (update.exportId === exportId) setProgress({ rows: update.rows, bytes: update.bytes })
    })
    try {
      const everything = chosen.size === tables.length
      const result = await coreLink.call(
        'export.dump',
        {
          exportId,
          connectionId: request.connectionId,
          database: request.database,
          tables: everything ? null : [...chosen],
          structure,
          data,
          drop: structure && drop,
          rowsPerInsert,
          compress,
          fileName: `${request.database.replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.sql`,
        },
        { signal: abort.signal },
      )
      if (result.status === 'dismissed') {
        setPhase('options')
      } else {
        setSaved(result)
        setPhase('done')
      }
    } catch (e) {
      if (abort.signal.aborted || (e instanceof RpcError && e.code === 'ABORTED')) {
        setPhase('options')
        notify('Export cancelled. Nothing was written.')
      } else {
        setError(e instanceof Error ? e.message : String(e))
        setPhase('failed')
      }
    } finally {
      off()
      controller.current = null
    }
  }

  return (
    <div className="dialog-overlay" onMouseDown={() => !running && close()}>
      <div
        className="dialog dialog-export"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dump-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          if (running) controller.current?.abort()
          else close()
        }}
      >
        <header>
          <Database size={18} className="dialog-icon neutral" aria-hidden />
          <h2 id="dump-title">Export {request.database} as SQL</h2>
          {!running ? (
            <IconButton label="Close" onClick={close}>
              <X size={14} />
            </IconButton>
          ) : null}
        </header>

        {phase === 'done' && saved ? (
          <div className="export-done" role="status">
            <p>
              <CircleCheck size={16} className="step-ok" aria-hidden />{' '}
              <strong>{saved.tables.toLocaleString()}</strong> table
              {saved.tables === 1 ? '' : 's'}, <strong>{saved.rows.toLocaleString()}</strong> row
              {saved.rows === 1 ? '' : 's'} ({formatBytes(saved.bytes)}) in{' '}
              {(saved.durationMs / 1000).toFixed(1)} s
            </p>
            <p className="mono selectable export-path">{saved.path}</p>
            <footer>
              <Button
                variant="ghost"
                icon={<FolderOpen size={13} />}
                onClick={() =>
                  void coreLink.call('export.reveal', { path: saved.path }).catch(() => undefined)
                }
              >
                Show in folder
              </Button>
              <Button variant="primary" onClick={close} autoFocus>
                Done
              </Button>
            </footer>
          </div>
        ) : (
          <>
            <p className="muted export-note">
              One SQL file that recreates the tables, and fills them. It is read on its own
              connection, which can’t write. Run the file in a script on the database it should go
              to.
            </p>

            {phase === 'loading' ? (
              <p className="export-progress" role="status">
                <LoaderCircle size={14} className="spin" aria-hidden /> Reading the tables…
              </p>
            ) : null}

            {tables.length > 0 ? (
              <fieldset className="export-fields" disabled={running}>
                <div className="export-columns-head">
                  <span>
                    Tables ({chosen.size} of {tables.length})
                  </span>
                  <Button variant="ghost" onClick={() => setShown(true)}>
                    All
                  </Button>
                  <Button variant="ghost" onClick={() => setShown(false)}>
                    None
                  </Button>
                </div>
                <Field label="Filter">
                  {(id) => (
                    <input
                      id={id}
                      value={filter}
                      spellCheck={false}
                      placeholder="Part of a name"
                      onChange={(event) => setFilter(event.target.value)}
                    />
                  )}
                </Field>
                <div className="export-columns" role="group" aria-label="Tables">
                  {shown.map((t) => (
                    <Check
                      key={t.name}
                      label={t.view ? `${t.name} (view)` : t.name}
                      checked={chosen.has(t.name)}
                      onChange={(on) => toggle(t.name, on)}
                    />
                  ))}
                </div>
              </fieldset>
            ) : null}

            {phase !== 'loading' && tables.length > 0 ? (
              <fieldset className="export-fields" disabled={running}>
                <div className="export-checks">
                  <Check
                    label="Structure (CREATE statements)"
                    checked={structure}
                    onChange={setStructure}
                  />
                  <Check label="Data (INSERT statements)" checked={data} onChange={setData} />
                  <Check
                    label="Drop each table first"
                    checked={structure && drop}
                    onChange={setDrop}
                    hint="Adds DROP TABLE IF EXISTS before each CREATE, so the file can run over an existing copy. Running it replaces what is there."
                  />
                  <Check
                    label="Compress with gzip (.gz)"
                    checked={compress}
                    onChange={setCompress}
                  />
                </div>
                <Field label="Rows per INSERT">
                  {(id) => (
                    <select
                      id={id}
                      value={rowsPerInsert}
                      onChange={(event) => setRowsPerInsert(Number(event.target.value))}
                    >
                      {[1, 10, 100, 1000].map((n) => (
                        <option key={n} value={n}>
                          {n === 1 ? 'One statement per row' : `${n} rows`}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              </fieldset>
            ) : null}

            {running ? (
              <p className="export-progress" role="status">
                <LoaderCircle size={14} className="spin" aria-hidden />
                {progress.rows === 0 && progress.bytes === 0
                  ? ' Waiting for a file name, then starting…'
                  : ` ${progress.rows.toLocaleString()} rows · ${formatBytes(progress.bytes)}`}
              </p>
            ) : null}
            {phase === 'failed' && error ? (
              <p className="note-error" role="alert">
                {error}
              </p>
            ) : null}

            <footer>
              {running ? (
                <Button variant="danger" onClick={() => controller.current?.abort()}>
                  Cancel export
                </Button>
              ) : (
                <>
                  <Button variant="ghost" onClick={close}>
                    Close
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => void start()}
                    autoFocus
                    disabled={
                      phase === 'loading' ||
                      tables.length === 0 ||
                      chosen.size === 0 ||
                      (!structure && !data)
                    }
                  >
                    Export…
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
