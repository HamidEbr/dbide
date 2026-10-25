import { Copy, Pencil } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ColumnInfo } from '@shared/driver'
import type { Cell } from '@shared/query'
import { cellToEditText, parseEditInput } from '@shared/value'
import { Button, Segmented } from '@/components/ui'
import { copyText, displayCell } from '@/features/sql/grid/format'
import { writeClipboard } from '@/lib/clipboard'
import { useInspector, type InspectorTarget } from '@/state/inspector'
import { notify } from '@/state/notices'
import {
  detectViews,
  encodeUtf8,
  formatByteCount,
  interpret,
  prettyJson,
  tryJson,
  type Interpretation,
  type ViewKind,
} from './decode'
import { decodedText, RenderedValue } from './RenderedValue'

/** Decodes a value off the main path, and keeps the last result on screen until the next arrives. */
function useInterpretation(
  value: Cell | undefined,
  column: ColumnInfo,
  forced: ViewKind | undefined,
): Interpretation | null {
  const [result, setResult] = useState<Interpretation | null>(null)
  useEffect(() => {
    if (value === undefined || value === null) return
    let cancelled = false
    void interpret(value, column, forced).then((next) => {
      if (!cancelled) setResult(next)
    })
    return () => {
      cancelled = true
    }
  }, [value, column, forced])
  return result
}

function describeSize(value: Cell): string {
  if (value instanceof Uint8Array) return formatByteCount(value.length)
  if (typeof value === 'string') {
    const bytes = encodeUtf8(value).length
    return `${value.length.toLocaleString()} characters${bytes !== value.length ? ` · ${formatByteCount(bytes)}` : ''}`
  }
  return typeof value
}

function ValueEditor({
  target,
  column,
  value,
}: {
  target: InspectorTarget
  column: ColumnInfo
  value: Cell | undefined
}) {
  const setEditing = useInspector((state) => state.setEditing)
  const [draft, setDraft] = useState(() => cellToEditText(value))
  const [error, setError] = useState<string | null>(null)

  const apply = (next: Cell): void => {
    const message = target.edit!.set(target.colIndex, next)
    if (message) setError(message)
    else setEditing(false)
  }

  const submit = (): void => {
    const parsed = parseEditInput(draft, column)
    if (!parsed.ok) return setError(parsed.message)
    apply(parsed.value)
  }

  const canFormat = column.type === 'json' || tryJson(draft) !== undefined
  return (
    <div className="value-editor">
      <textarea
        className="mono"
        autoFocus
        rows={9}
        value={draft}
        aria-label={`Value of ${column.name}`}
        aria-invalid={error !== null}
        spellCheck={false}
        onChange={(event) => {
          setDraft(event.target.value)
          setError(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            setEditing(false)
          }
        }}
      />
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="value-editor-actions">
        <Button variant="primary" onClick={submit}>
          Stage change
        </Button>
        <Button onClick={() => setEditing(false)}>Cancel</Button>
        <span className="spacer" />
        {canFormat ? (
          <Button
            variant="ghost"
            onClick={() => tryJson(draft) !== undefined && setDraft(prettyJson(draft.trim()))}
          >
            Format JSON
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => apply(null)}>
          Set NULL
        </Button>
      </div>
    </div>
  )
}

/** The selected cell, decoded: JSON, JWT, Base64, compressed data, images, times, and more. */
export function ValueView({ target }: { target: InspectorTarget }) {
  const column = target.columns[target.colIndex]!
  const value = target.row[target.colIndex]
  const editing = useInspector((state) => state.editing)
  const setEditing = useInspector((state) => state.setEditing)
  const [forced, setForced] = useState<ViewKind | undefined>(undefined)

  const result = useInterpretation(value, column, forced)
  const views = value === undefined || value === null ? [] : detectViews(value, column)
  const options = views.some((v) => v.kind === 'hex')
    ? views
    : [...views, { kind: 'hex' as const, label: 'Hex' }]
  const current = forced ?? result?.layers[0]?.kind ?? views[0]?.kind

  const blocked = target.edit?.blocked(target.colIndex) ?? null
  const canEdit = target.edit !== null && blocked === null && !target.isDeleted
  const decoded = result ? decodedText(result.rendered) : null
  const display = displayCell(value === undefined ? null : value, column)

  const copy = (text: string, what: string): void => {
    void writeClipboard(text).then(() => notify(`Copied ${what}.`))
  }

  return (
    <div className="value-view">
      <header className="value-header">
        <span className="mono value-name">{column.name}</span>
        <span className="pill">{column.type}</span>
        {target.changed.has(target.colIndex) ? (
          <span className="pill pill-changed">Changed</span>
        ) : null}
        <span className="spacer" />
        {canEdit && !editing ? (
          <Button variant="ghost" icon={<Pencil size={13} />} onClick={() => setEditing(true)}>
            Edit
          </Button>
        ) : null}
      </header>

      {value === undefined ? (
        <p className="muted value-note">
          Not set. The table fills this in with its default when the row is saved.
        </p>
      ) : value === null ? (
        <p className={`value-null ${display.kind === 'null' ? 'cell-null' : ''}`}>NULL</p>
      ) : (
        <>
          <p className="muted value-size">{describeSize(value)}</p>

          {editing ? (
            <ValueEditor target={target} column={column} value={value} />
          ) : (
            <>
              {options.length > 1 ? (
                <Segmented<ViewKind>
                  label="View as"
                  value={current ?? 'text'}
                  options={options.map((o) => ({ value: o.kind, label: o.label }))}
                  onChange={setForced}
                />
              ) : null}
              {result && result.layers.length > 1 ? (
                <p className="muted value-layers">
                  {result.layers.map((l) => l.label).join(' → ')}
                </p>
              ) : null}
              {result ? <RenderedValue rendered={result.rendered} /> : null}
              <div className="value-actions">
                <Button
                  variant="ghost"
                  icon={<Copy size={13} />}
                  onClick={() => copy(copyText(value), 'the value')}
                >
                  Copy
                </Button>
                {decoded !== null && decoded !== copyText(value) ? (
                  <Button
                    variant="ghost"
                    icon={<Copy size={13} />}
                    onClick={() => copy(decoded, 'the decoded value')}
                  >
                    Copy decoded
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </>
      )}

      {!canEdit && target.edit !== null && blocked ? (
        <p className="muted value-note">{blocked}</p>
      ) : null}
      {target.edit === null && target.readOnlyReason ? (
        <p className="muted value-note">Read-only: {target.readOnlyReason}</p>
      ) : null}
    </div>
  )
}
