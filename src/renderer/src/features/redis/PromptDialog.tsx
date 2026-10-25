import { useState, type ReactNode } from 'react'
import { Dialog } from '@/components/Dialog'
import { Button } from '@/components/ui'

/** A small form in a dialog: the fields, a way out, and a button that works only when the fields are valid. */
export function FormDialog({
  title,
  confirmLabel,
  onClose,
  onSubmit,
  disabled = false,
  error,
  children,
}: {
  title: string
  confirmLabel: string
  onClose: () => void
  /** Return true when it worked and the dialog should close. */
  onSubmit: () => Promise<boolean>
  disabled?: boolean
  error?: string | null
  children: ReactNode
}) {
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    if (disabled || busy) return
    setBusy(true)
    try {
      if (await onSubmit()) onClose()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="redis-form"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {children}
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={disabled || busy}>
            {confirmLabel}
          </Button>
        </footer>
      </form>
    </Dialog>
  )
}
