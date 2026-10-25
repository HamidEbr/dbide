import { LockOpen, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { formatShortcut } from '@/commands/keybinding'
import { Button } from '@/components/ui'
import type { RowEditing } from './useRowEditing'

interface EditBarProps {
  editing: RowEditing
  onAddRow: () => void
  onDeleteSelected: () => void
  onCommit: () => void
}

/**
 * The strip above an editable result: add and delete rows, and when there are unsaved changes,
 * review the SQL, discard, or commit. For a result that can't be edited it says why, once.
 */
export function EditBar({ editing, onAddRow, onDeleteSelected, onCommit }: EditBarProps) {
  const [reviewing, setReviewing] = useState(false)

  if (editing.status === 'unavailable') {
    return (
      <div className="edit-bar edit-bar-quiet" title={editing.reason ?? undefined}>
        <span className="muted edit-reason">Read-only result. {editing.reason}</span>
      </div>
    )
  }
  if (editing.status === 'loading') {
    return (
      <div className="edit-bar edit-bar-quiet">
        <span className="muted">Reading the table’s keys…</span>
      </div>
    )
  }

  const changes = editing.changeCount
  return (
    <div className="edit-bar-wrap">
      <div className="edit-bar">
        {editing.writable ? (
          <>
            <Button variant="ghost" icon={<Plus size={13} />} onClick={onAddRow}>
              Add row
            </Button>
            <Button variant="ghost" icon={<Trash2 size={13} />} onClick={onDeleteSelected}>
              Delete
            </Button>
          </>
        ) : (
          <>
            <span className="muted">Editing is locked.</span>
            <Button variant="ghost" icon={<LockOpen size={13} />} onClick={editing.unlock}>
              Unlock writes
            </Button>
          </>
        )}

        <span className="spacer" />

        {changes > 0 ? (
          <>
            <span className="edit-count">
              {changes} unsaved change{changes === 1 ? '' : 's'}
            </span>
            <Button
              variant="ghost"
              onClick={() => setReviewing((open) => !open)}
              aria-expanded={reviewing}
            >
              {reviewing ? 'Hide SQL' : 'Review SQL'}
            </Button>
            <Button variant="ghost" onClick={editing.discard}>
              Discard
            </Button>
            <Button
              variant="primary"
              onClick={onCommit}
              title={`Save every staged change in one transaction (${formatShortcut('Mod+S', window.dbide.platform).join('')})`}
            >
              {editing.committing ? 'Saving…' : `Commit ${changes}`}
            </Button>
          </>
        ) : editing.writable ? (
          <span className="muted edit-hint">Double-click a cell, or press Enter, to edit.</span>
        ) : null}
      </div>

      {editing.commitError ? (
        <p className="note-error edit-error" role="alert">
          {editing.commitError}
        </p>
      ) : null}
      {reviewing && changes > 0 ? (
        <pre className="edit-preview mono selectable" aria-label="SQL that will run">
          {editing.preview.map((statement) => `${statement};`).join('\n')}
        </pre>
      ) : null}
    </div>
  )
}
