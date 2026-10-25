import { ChevronDown, ChevronUp, Pencil } from 'lucide-react'
import { useState } from 'react'
import type { Cell } from '@shared/query'
import { cellToEditText } from '@shared/value'
import { IconButton } from '@/components/ui'
import { FieldEditor } from '@/features/sql/edit/FieldEditor'
import { displayCell } from '@/features/sql/grid/format'
import { useInspector, type InspectorTarget } from '@/state/inspector'

/** Long or multi-line values are edited in the Value tab, where there is room. */
const needsRoomToEdit = (value: Cell | undefined): boolean =>
  typeof value === 'string' && (value.includes('\n') || value.length > 160)

/** The current row as a form: every column on its own line. The transposed view of a row. */
export function RecordView({ target }: { target: InspectorTarget }) {
  const setTab = useInspector((state) => state.setTab)
  const setEditing = useInspector((state) => state.setEditing)
  const [editingCol, setEditingCol] = useState<number | null>(null)

  const edit = (col: number): void => {
    target.focusColumn(col)
    if (needsRoomToEdit(target.row[col])) {
      setTab('value')
      setEditing(true)
    } else {
      setEditingCol(col)
    }
  }

  return (
    <div className="record-view">
      <div className="record-nav">
        <span>
          Row {(target.rowIndex + 1).toLocaleString()} of {target.rowCount.toLocaleString()}
        </span>
        {target.isNewRow ? <span className="pill pill-new">New</span> : null}
        {target.isDeleted ? <span className="pill pill-deleted">Deleted</span> : null}
        <span className="spacer" />
        <IconButton
          label="Previous row"
          onClick={() => target.move(-1)}
          disabled={target.rowIndex === 0}
        >
          <ChevronUp size={14} />
        </IconButton>
        <IconButton
          label="Next row"
          onClick={() => target.move(1)}
          disabled={target.rowIndex >= target.rowCount - 1}
        >
          <ChevronDown size={14} />
        </IconButton>
      </div>

      {target.isNewRow ? (
        <p className="muted value-note">New row. Columns left unset use the table’s default.</p>
      ) : null}
      {target.isDeleted ? (
        <p className="muted value-note">Marked for deletion. Commit to remove it.</p>
      ) : null}

      <ul className="record-fields">
        {target.columns.map((column, c) => {
          const value = target.row[c]
          const display = displayCell(value === undefined ? null : value, column)
          const blocked = target.edit?.blocked(c) ?? null
          const editable = target.edit !== null && blocked === null && !target.isDeleted
          const isCurrent = c === target.colIndex
          return (
            <li
              key={c}
              className={`record-field ${isCurrent ? 'current' : ''} ${target.changed.has(c) ? 'changed' : ''}`}
            >
              <button type="button" className="record-name" onClick={() => target.focusColumn(c)}>
                <span className="mono">{column.name}</span>
                <span className="record-type">{column.type}</span>
              </button>

              {editingCol === c ? (
                <FieldEditor
                  column={column}
                  nullable={column.nullable !== false}
                  initial={cellToEditText(value)}
                  selectAll
                  compact
                  onCommit={(next) => {
                    const message = target.edit!.set(c, next)
                    if (!message) setEditingCol(null)
                    return message
                  }}
                  onCancel={() => setEditingCol(null)}
                />
              ) : (
                <div className="record-value" onDoubleClick={() => editable && edit(c)}>
                  <span
                    className={`record-text mono ${value === undefined ? 'cell-null' : `cell-${display.kind}`}`}
                    title={blocked ?? undefined}
                  >
                    {value === undefined ? 'DEFAULT' : display.text}
                  </span>
                  {editable ? (
                    <IconButton
                      label={`Edit ${column.name}`}
                      className="record-edit"
                      onClick={() => edit(c)}
                    >
                      <Pencil size={12} />
                    </IconButton>
                  ) : null}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
