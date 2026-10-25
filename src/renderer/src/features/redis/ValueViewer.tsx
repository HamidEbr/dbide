import { Copy } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { isBinary, printable, toBytes } from '@shared/redis/bstring'
import type { Cell } from '@shared/query'
import { Button, Segmented } from '@/components/ui'
import { writeClipboard } from '@/lib/clipboard'
import { notify } from '@/state/notices'
import {
  detectViews,
  formatByteCount,
  interpret,
  type Interpretation,
  type ViewKind,
} from '@/features/inspector/decode'
import { decodedText, RenderedValue } from '@/features/inspector/RenderedValue'

/**
 * A Redis value, decoded the way the inspector decodes a cell: JSON laid out, Base64 and compression
 * unwrapped, a JWT read, PHP serialize read, an image shown, or a hex dump when it is plain bytes.
 */
export function ValueViewer({
  value,
  bytes,
  truncated = false,
}: {
  /** The value in the binary-safe form. */
  value: string
  /** How long the whole value is, which may be more than `value` holds. */
  bytes: number
  truncated?: boolean
}) {
  const cell: Cell = useMemo(() => (isBinary(value) ? toBytes(value) : value), [value])
  const column = useMemo(() => ({ name: 'value', type: 'text' }), [])
  const [forced, setForced] = useState<ViewKind | undefined>(undefined)
  const [result, setResult] = useState<Interpretation | null>(null)

  useEffect(() => {
    let cancelled = false
    void interpret(cell, column, forced).then((next) => {
      if (!cancelled) setResult(next)
    })
    return () => {
      cancelled = true
    }
  }, [cell, column, forced])

  const views = detectViews(cell, column)
  const options = views.some((v) => v.kind === 'hex')
    ? views
    : [...views, { kind: 'hex' as const, label: 'Hex' }]
  const current = forced ?? result?.layers[0]?.kind ?? views[0]?.kind
  const decoded = result ? decodedText(result.rendered) : null
  const text = isBinary(value) ? printable(value) : value

  const copy = (what: string, content: string): void => {
    void writeClipboard(content).then(() => notify(`Copied ${what}.`))
  }

  return (
    <div className="broker-payload">
      <p className="muted value-size">
        {formatByteCount(bytes)}
        {isBinary(value) ? ' · not text' : ''}
      </p>
      {truncated ? (
        <p className="note-warn-inline">
          Only the first part of this value was read ({formatByteCount(toBytes(value).length)} of{' '}
          {formatByteCount(bytes)}).
        </p>
      ) : null}
      {options.length > 1 ? (
        <Segmented<ViewKind>
          label="View as"
          value={current ?? 'text'}
          options={options.map((o) => ({ value: o.kind, label: o.label }))}
          onChange={setForced}
        />
      ) : null}
      {result && result.layers.length > 1 ? (
        <p className="muted value-layers">{result.layers.map((l) => l.label).join(' → ')}</p>
      ) : null}
      {result ? <RenderedValue rendered={result.rendered} /> : null}
      <div className="value-actions">
        <Button variant="ghost" icon={<Copy size={13} />} onClick={() => copy('the value', text)}>
          Copy
        </Button>
        {decoded !== null && decoded !== text ? (
          <Button variant="ghost" onClick={() => copy('the decoded value', decoded)}>
            Copy decoded
          </Button>
        ) : null}
      </div>
    </div>
  )
}
