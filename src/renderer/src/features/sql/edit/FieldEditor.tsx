import { useRef, useState, type KeyboardEvent } from 'react'
import type { ColumnInfo } from '@shared/driver'
import type { Cell } from '@shared/query'
import { parseEditInput } from '@shared/value'

export type Move = 'down' | 'up' | 'right' | 'left' | 'none'

interface FieldEditorProps {
  column: ColumnInfo
  nullable: boolean
  /** The text to start with. */
  initial: string
  /** Select everything on open (Enter, F2) instead of placing the caret at the end (typing). */
  selectAll: boolean
  /** Returns a message when the value can't be accepted, which keeps the editor open. */
  onCommit: (value: Cell, move: Move) => string | null
  onCancel: () => void
  /** Smaller and flush with its row, for use inside the grid. */
  compact?: boolean
}

/**
 * A one-line editor for a single value. Enter saves and moves down, Tab saves and moves right,
 * Escape discards, and ⌘⇧0 (Ctrl+Shift+0) sets NULL. Leaving the field saves a valid value and
 * drops an invalid one with its message.
 */
export function FieldEditor({
  column,
  nullable,
  initial,
  selectAll,
  onCommit,
  onCancel,
  compact,
}: FieldEditorProps) {
  const [text, setText] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const finished = useRef(false)

  const finish = (value: Cell, move: Move): void => {
    const message = onCommit(value, move)
    if (message) setError(message)
    else finished.current = true
  }

  const commitText = (move: Move): void => {
    const parsed = parseEditInput(text, column)
    if (!parsed.ok) return setError(parsed.message)
    finish(parsed.value, move)
  }

  const setNull = (): void => {
    if (!nullable) return setError('This column doesn’t allow NULL.')
    finish(null, 'none')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const mod = event.metaKey || event.ctrlKey
    if (event.key === 'Enter') commitText(event.shiftKey ? 'up' : 'down')
    else if (event.key === 'Tab') commitText(event.shiftKey ? 'left' : 'right')
    else if (event.key === 'Escape') {
      finished.current = true
      onCancel()
    } else if (mod && event.shiftKey && event.code === 'Digit0') setNull()
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <span className={`field-editor ${compact ? 'compact' : ''}`}>
      <input
        className="mono"
        autoFocus
        value={text}
        aria-label={`Value of ${column.name}`}
        aria-invalid={error !== null}
        spellCheck={false}
        autoComplete="off"
        onFocus={(event) => {
          if (selectAll) event.currentTarget.select()
          else event.currentTarget.setSelectionRange(text.length, text.length)
        }}
        onChange={(event) => {
          setText(event.target.value)
          setError(null)
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (finished.current) return
          const parsed = parseEditInput(text, column)
          if (parsed.ok && text !== initial) finish(parsed.value, 'none')
          else onCancel()
        }}
      />
      {nullable ? (
        // mousedown would blur the input and save it before the click lands.
        <button
          type="button"
          className="field-null"
          tabIndex={-1}
          title="Set NULL"
          onMouseDown={(event) => event.preventDefault()}
          onClick={setNull}
        >
          NULL
        </button>
      ) : null}
      {error ? (
        <span className="field-error-tip" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  )
}
