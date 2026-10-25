import {
  ChevronDown,
  ChevronUp,
  Copy,
  CopyPlus,
  LockOpen,
  Pencil,
  Trash2,
  Undo2,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { formatRelaxedJson, formatShell, idOf, typeOf, type Json } from '@shared/mongo/ejson'
import { evaluate } from '@shared/mongo/eval'
import { MongoSyntaxError, lineAndColumn, parseMongoValue } from '@shared/mongo/lang'
import { Button, IconButton } from '@/components/ui'
import { writeClipboard } from '@/lib/clipboard'
import { notify } from '@/state/notices'
import type { DocumentTarget } from '@/state/inspector'
import { diffDocuments, touchedFields } from './diff'
import { highlightShell } from './highlight'
import { ShellEditor } from './ShellEditor'

type Analysis =
  { ok: false; message: string } | { ok: true; next: Json; touched: string[]; unchanged: boolean }

/** Reads the editor's text as a document and works out what saving it would change. */
function analyze(text: string, target: DocumentTarget): Analysis {
  let next: Json
  try {
    next = evaluate(parseMongoValue(text))
  } catch (error) {
    if (!(error instanceof MongoSyntaxError)) throw error
    const { line, column } = lineAndColumn(text, error.at)
    return { ok: false, message: `${error.message} (line ${line}, column ${column})` }
  }
  if (typeOf(next) !== 'object') return { ok: false, message: 'A document is written { ... }.' }
  if (target.state === 'new') return { ok: true, next, touched: [], unchanged: false }

  const diff = diffDocuments(target.original, next)
  if (!diff.ok) return { ok: false, message: diff.message }
  const touched = touchedFields(diff.changes)
  return { ok: true, next, touched, unchanged: touched.length === 0 }
}

const STATE_LABEL: Record<DocumentTarget['state'], string | null> = {
  clean: null,
  changed: 'Edited',
  deleted: 'Marked for deletion',
  new: 'New, not saved yet',
}

/**
 * The inspector for a MongoDB result: the selected document as text in the shell's notation, ready to
 * paste into a script, with the actions that make sense for it. Edit opens it in an editor; staging
 * the edit doesn't touch the server, the result's Save does.
 */
export function DocumentInspector({ target }: { target: DocumentTarget }) {
  const canEdit = target.blockedReason === null && target.state !== 'deleted'
  const [editing, setEditing] = useState(target.editOnOpen && canEdit && !target.locked)
  const shown = useMemo(() => formatShell(target.document, { indent: 2 }), [target.document])
  const [text, setText] = useState(shown)
  const analysis = useMemo(() => (editing ? analyze(text, target) : null), [editing, text, target])
  const [error, setError] = useState<string | null>(null)

  const id = idOf(target.document)
  const label = STATE_LABEL[target.state]

  const startEditing = (): void => {
    if (target.blockedReason) return notify(target.blockedReason)
    if (target.locked) return notify('Editing is locked. Unlock writes first.')
    setText(shown)
    setError(null)
    setEditing(true)
  }

  const stage = (): void => {
    if (!analysis?.ok) return
    if (analysis.unchanged) {
      setEditing(false)
      return
    }
    const problem = target.stage(analysis.next)
    if (problem) {
      setError(problem)
      return
    }
    setEditing(false)
  }

  const copy = (what: 'shell' | 'json'): void => {
    void writeClipboard(
      what === 'shell'
        ? formatShell(target.document, { indent: 2 })
        : formatRelaxedJson(target.document, 2),
    ).then(() => notify(what === 'shell' ? 'Copied the document.' : 'Copied the document as JSON.'))
  }

  return (
    <div className="doc-inspector">
      <div className="doc-inspector-head">
        <div className="doc-inspector-title">
          <span>
            Document {(target.rowIndex + 1).toLocaleString()} of {target.rowCount.toLocaleString()}
          </span>
          {label ? <span className={`doc-badge doc-badge-${target.state}`}>{label}</span> : null}
        </div>
        <div className="doc-inspector-actions">
          <IconButton label="Previous document" onClick={() => target.move(-1)}>
            <ChevronUp size={14} />
          </IconButton>
          <IconButton label="Next document" onClick={() => target.move(1)}>
            <ChevronDown size={14} />
          </IconButton>
        </div>
      </div>

      {id !== undefined ? (
        <p className="doc-inspector-id mono selectable" title="_id">
          {formatShell(id)}
        </p>
      ) : null}

      <div className="doc-inspector-bar">
        {editing ? null : (
          <>
            {target.locked && target.blockedReason === null ? (
              <Button variant="ghost" icon={<LockOpen size={13} />} onClick={target.unlock}>
                Unlock writes
              </Button>
            ) : (
              <Button
                variant="ghost"
                icon={<Pencil size={13} />}
                disabled={!canEdit}
                title={
                  target.blockedReason ??
                  (target.state === 'deleted' ? 'Marked for deletion' : 'Edit this document')
                }
                onClick={startEditing}
              >
                Edit
              </Button>
            )}
            <Button variant="ghost" icon={<Copy size={13} />} onClick={() => copy('shell')}>
              Copy
            </Button>
            <Button
              variant="ghost"
              onClick={() => copy('json')}
              title="Relaxed Extended JSON, as other tools read it"
            >
              Copy JSON
            </Button>
            {canEdit && !target.locked ? (
              <Button
                variant="ghost"
                icon={<CopyPlus size={13} />}
                onClick={target.clone}
                title="Add a copy of this document"
              >
                Clone
              </Button>
            ) : null}
            {target.blockedReason === null && !target.locked ? (
              <Button
                variant="ghost"
                icon={<Trash2 size={13} />}
                onClick={target.toggleDelete}
                title={
                  target.state === 'deleted'
                    ? 'Keep this document'
                    : 'Mark this document for deletion'
                }
              >
                {target.state === 'deleted'
                  ? 'Keep'
                  : target.state === 'new'
                    ? 'Discard'
                    : 'Delete'}
              </Button>
            ) : null}
            {target.state === 'changed' ? (
              <Button variant="ghost" icon={<Undo2 size={13} />} onClick={target.revert}>
                Revert
              </Button>
            ) : null}
          </>
        )}
      </div>

      {editing ? (
        <div className="doc-editor">
          <ShellEditor
            initial={text}
            label="Document"
            autoFocus
            onChange={(next) => {
              setText(next)
              setError(null)
            }}
            onSubmit={stage}
            onCancel={() => setEditing(false)}
          />
          <div className="doc-editor-status" role="status">
            {analysis && !analysis.ok ? (
              <p className="note-error">{analysis.message}</p>
            ) : error ? (
              <p className="note-error">{error}</p>
            ) : analysis?.ok && analysis.unchanged ? (
              <p className="muted">
                {target.state === 'new' ? 'An empty document gets only an _id.' : 'No changes yet.'}
              </p>
            ) : analysis?.ok && target.state !== 'new' ? (
              <p className="muted">Changes: {analysis.touched.join(', ')}</p>
            ) : (
              <p className="muted">Ready to add.</p>
            )}
          </div>
          <div className="doc-editor-actions">
            <Button onClick={() => setEditing(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!analysis?.ok || (analysis.unchanged && target.state !== 'new')}
              onClick={stage}
              title="Keep this edit with the others. Nothing is saved until you Save the result."
            >
              Stage change
            </Button>
          </div>
        </div>
      ) : (
        <pre
          className={`doc-json mono selectable ${target.state === 'deleted' ? 'doc-json-deleted' : ''}`}
          aria-label="Document"
        >
          {highlightShell(shown)}
        </pre>
      )}
    </div>
  )
}
