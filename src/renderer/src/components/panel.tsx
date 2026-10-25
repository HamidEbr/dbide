import { Lock, LockOpen, RefreshCw } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button, IconButton } from '@/components/ui'
import { setWritable, useWritable } from '@/state/writes'

/** The lock beside a connection's tabs: changes are refused while it is closed. */
export function LockButton({
  connectionId,
  allows,
}: {
  connectionId: string
  /** What unlocking allows, in a few words: `publishing, purging, creating and deleting`. */
  allows: string
}) {
  const writable = useWritable(connectionId)
  return (
    <Button
      variant={writable ? 'default' : 'ghost'}
      className={writable ? 'writable-on' : 'writable-off'}
      icon={writable ? <LockOpen size={14} /> : <Lock size={14} />}
      aria-pressed={writable}
      title={
        writable ? 'Changes are allowed. Click to lock.' : `Read-only. Click to allow ${allows}.`
      }
      onClick={() => void setWritable(connectionId, !writable)}
    >
      {writable ? 'Writable' : 'Read-only'}
    </Button>
  )
}

/** Reloads, and says how long ago the numbers on screen were read. */
export function RefreshControls({
  onReload,
  auto,
  onAuto,
  updatedAt,
  every = 'Every 5 s',
}: {
  onReload: () => void
  auto: boolean
  onAuto: (on: boolean) => void
  updatedAt: number | null
  every?: string
}) {
  return (
    <span className="broker-refresh">
      <IconButton label="Refresh now" onClick={onReload}>
        <RefreshCw size={14} />
      </IconButton>
      <label className="check broker-auto">
        <input type="checkbox" checked={auto} onChange={(event) => onAuto(event.target.checked)} />
        {every}
      </label>
      {updatedAt ? (
        <span className="muted broker-updated" title="When these numbers were read">
          {new Date(updatedAt).toLocaleTimeString()}
        </span>
      ) : null}
    </span>
  )
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="broker-stat" title={hint}>
      <span className="broker-stat-value">{value}</span>
      <span className="broker-stat-label">{label}</span>
    </div>
  )
}

export function Chip({ children, tone }: { children: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return <span className={`broker-chip ${tone ? `broker-chip-${tone}` : ''}`}>{children}</span>
}

/** The rows of a long list, drawn only where the list is scrolled to. Rows are one height. */
export function VirtualRows({
  count,
  rowHeight,
  render,
  className,
}: {
  count: number
  rowHeight: number
  render: (index: number) => ReactNode
  className?: string
}) {
  const [scroll, setScroll] = useState({ top: 0, height: 600 })
  const first = Math.max(0, Math.floor(scroll.top / rowHeight) - 6)
  const last = Math.min(count, Math.ceil((scroll.top + scroll.height) / rowHeight) + 6)
  const rows: ReactNode[] = []
  for (let i = first; i < last; i++) rows.push(render(i))
  return (
    <div
      className={`broker-rows ${className ?? ''}`}
      ref={(element) => {
        if (element && element.clientHeight !== scroll.height && element.clientHeight > 0) {
          setScroll((s) => ({ ...s, height: element.clientHeight }))
        }
      }}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop
        setScroll((s) => ({ ...s, top }))
      }}
    >
      <div style={{ height: count * rowHeight, position: 'relative' }}>
        <div style={{ transform: `translateY(${first * rowHeight}px)` }}>{rows}</div>
      </div>
    </div>
  )
}
