import { Plus, X, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { IconButton } from '@/components/ui'

/** A modal form: a title, a close button, and the form. Escape or a click outside closes it. */
export function Dialog({
  title,
  onClose,
  icon: Icon = Plus,
  children,
}: {
  title: string
  onClose: () => void
  icon?: LucideIcon
  children: ReactNode
}) {
  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div
        className="dialog broker-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }}
      >
        <header>
          <Icon size={18} className="dialog-icon neutral" aria-hidden />
          <h2>{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </header>
        {children}
      </div>
    </div>
  )
}
