import { CircleCheck, Download, FolderOpen, LoaderCircle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CoreEvents, type ExportProgress } from '@shared/api'
import {
  DEFAULT_EXPORT_OPTIONS,
  DELIMITERS,
  EXPORT_FORMATS,
  exportFileName,
  type Delimiter,
  type ExportFormat,
  type ExportOptions,
} from '@shared/export'
import { RpcError } from '@shared/rpc'
import { Button, Field, IconButton, Segmented } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { useDialogs, type ExportRequest } from '@/state/dialogs'
import { notify } from '@/state/notices'
import { singleSourceName } from './open'

const STORAGE_KEY = 'dbide.export'

interface Remembered {
  format: ExportFormat
  options: ExportOptions
}

/** The last format and options, so a second export starts where the first left off. */
function remembered(): Remembered {
  const fallback: Remembered = { format: 'csv', options: DEFAULT_EXPORT_OPTIONS }
  try {
    const stored = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? 'null',
    ) as Partial<Remembered> | null
    if (!stored) return fallback
    const format = EXPORT_FORMATS.some((f) => f.value === stored.format) ? stored.format! : 'csv'
    return { format, options: { ...DEFAULT_EXPORT_OPTIONS, ...stored.options } }
  } catch {
    return fallback
  }
}

function remember(value: Remembered): void {
  try {
    // The table name belongs to one result, not to the next export.
    const { tableName: _tableName, ...options } = value.options
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ format: value.format, options }))
  } catch {
    // Nothing to do: it just starts from the defaults next time.
  }
}

const DELIMITER_LABELS: Record<Delimiter, string> = {
  ',': 'Comma  ,',
  ';': 'Semicolon  ;',
  '\t': 'Tab',
  '|': 'Pipe  |',
}

const formatBytes = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`

type Phase = 'options' | 'running' | 'done' | 'failed'

interface Saved {
  path: string
  rows: number
  bytes: number
  durationMs: number
}

export function ExportDialog() {
  const request = useDialogs((state) => state.export)
  if (!request) return null
  return <ExportBody request={request} />
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

function ExportBody({ request }: { request: ExportRequest }) {
  const close = useDialogs((state) => state.closeExport)
  const source = singleSourceName(request.columns)
  const [initial] = useState(remembered)
  const [format, setFormat] = useState<ExportFormat>(initial.format)
  const [options, setOptions] = useState<ExportOptions>({
    ...initial.options,
    tableName: source ? `${source.schema}.${source.table}` : 'table_name',
  })
  const [phase, setPhase] = useState<Phase>('options')
  const [progress, setProgress] = useState({ rows: 0, bytes: 0 })
  const [saved, setSaved] = useState<Saved | null>(null)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)

  const set = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]): void =>
    setOptions((current) => ({ ...current, [key]: value }))

  // Closing while an export runs cancels it, so nothing is left running in the background.
  useEffect(() => () => controller.current?.abort(), [])

  const start = async (): Promise<void> => {
    remember({ format, options })
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
      const result = await coreLink.call(
        'export.run',
        {
          exportId,
          connectionId: request.connectionId,
          database: request.database,
          sql: request.sql,
          format,
          options,
          fileName: exportFileName(source?.table ?? 'result', format),
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

  const csvLike = format === 'csv' || format === 'tsv'
  const running = phase === 'running'

  return (
    <div className="dialog-overlay" onMouseDown={() => !running && close()}>
      <div
        className="dialog dialog-export"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          if (running) controller.current?.abort()
          else close()
        }}
      >
        <header>
          <Download size={18} className="dialog-icon neutral" aria-hidden />
          <h2 id="export-title">Export result</h2>
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
              <strong>{saved.rows.toLocaleString()}</strong> row{saved.rows === 1 ? '' : 's'}{' '}
              written ({formatBytes(saved.bytes)}) in {(saved.durationMs / 1000).toFixed(1)} s
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
              The query runs again on its own connection and every row goes to the file, not only
              the rows loaded in the grid.
            </p>
            <pre className="dialog-sql mono selectable export-sql" tabIndex={0}>
              {request.sql}
            </pre>

            <fieldset className="export-fields" disabled={running}>
              <Segmented<ExportFormat>
                label="Format"
                value={format}
                options={EXPORT_FORMATS.map((f) => ({ value: f.value, label: f.label }))}
                onChange={setFormat}
              />

              {csvLike ? (
                <div className="export-grid">
                  {format === 'csv' ? (
                    <Field label="Separator">
                      {(id) => (
                        <select
                          id={id}
                          value={options.delimiter}
                          onChange={(event) => set('delimiter', event.target.value as Delimiter)}
                        >
                          {DELIMITERS.map((d) => (
                            <option key={d} value={d}>
                              {DELIMITER_LABELS[d]}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                  ) : null}
                  <Field
                    label="NULL is written as"
                    hint="Empty by default. An empty string is then quoted."
                  >
                    {(id) => (
                      <input
                        id={id}
                        className="mono"
                        value={options.nullText}
                        placeholder="(empty)"
                        spellCheck={false}
                        onChange={(event) => set('nullText', event.target.value)}
                      />
                    )}
                  </Field>
                </div>
              ) : null}

              {csvLike ? (
                <div className="export-checks">
                  <Check
                    label="Column names in the first row"
                    checked={options.header}
                    onChange={(v) => set('header', v)}
                  />
                  {format === 'csv' ? (
                    <Check
                      label="Quote every value"
                      checked={options.quoteAll}
                      onChange={(v) => set('quoteAll', v)}
                    />
                  ) : null}
                  <Check
                    label="Excel-friendly (UTF-8 byte order mark)"
                    checked={options.bom}
                    onChange={(v) => set('bom', v)}
                    hint="Older versions of Excel need this to read accents and non-Latin text correctly."
                  />
                  <Check
                    label="Windows line endings"
                    checked={options.crlf}
                    onChange={(v) => set('crlf', v)}
                  />
                  <Check
                    label="Stop spreadsheets running text as formulas"
                    checked={options.neutralizeFormulas}
                    onChange={(v) => set('neutralizeFormulas', v)}
                    hint="Text that starts with = + - or @ gets a leading apostrophe. Numbers are left alone."
                  />
                </div>
              ) : null}

              {format === 'sql' ? (
                <div className="export-grid">
                  <Field label="Table name">
                    {(id) => (
                      <input
                        id={id}
                        className="mono"
                        value={options.tableName}
                        spellCheck={false}
                        onChange={(event) => set('tableName', event.target.value)}
                      />
                    )}
                  </Field>
                  <Field label="Rows per INSERT">
                    {(id) => (
                      <select
                        id={id}
                        value={options.rowsPerInsert}
                        onChange={(event) => set('rowsPerInsert', Number(event.target.value))}
                      >
                        {[1, 10, 100, 1000].map((n) => (
                          <option key={n} value={n}>
                            {n === 1 ? 'One statement per row' : `${n} rows`}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                </div>
              ) : null}

              {format === 'json' || format === 'ndjson' ? (
                <p className="muted">
                  Numbers stay numbers, with every digit. Binary values are written as 0x… text.
                  {format === 'json'
                    ? ' One object per row, in a single array.'
                    : ' One object per line.'}
                </p>
              ) : null}
              {format === 'xlsx' ? (
                <>
                  <div className="export-checks">
                    <Check
                      label="Column names in the first row"
                      checked={options.header}
                      onChange={(v) => set('header', v)}
                    />
                  </div>
                  <p className="muted">
                    An Excel workbook. Numbers stay numbers while Excel can hold every digit (15);
                    longer ones stay text so none is lost. Text is never turned into a formula. A
                    sheet holds 1,048,576 rows, so a longer result continues on the next sheet.
                  </p>
                </>
              ) : null}
              {format === 'markdown' ? (
                <p className="muted">A table you can paste into a README, a ticket or a chat.</p>
              ) : null}
            </fieldset>

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
                    icon={<Download size={13} />}
                    onClick={() => void start()}
                    autoFocus
                    disabled={format === 'sql' && options.tableName.trim() === ''}
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
