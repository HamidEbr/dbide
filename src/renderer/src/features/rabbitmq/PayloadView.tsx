import { Copy } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { PeekedMessage } from '@shared/rabbitmq'
import type { Cell } from '@shared/query'
import { Button, Segmented } from '@/components/ui'
import { writeClipboard } from '@/lib/clipboard'
import { notify } from '@/state/notices'
import {
  decodeBase64,
  detectViews,
  formatByteCount,
  interpret,
  type Interpretation,
  type ViewKind,
} from '@/features/inspector/decode'
import { decodedText, RenderedValue } from '@/features/inspector/RenderedValue'

/**
 * A message's payload, decoded the way the inspector decodes a cell: JSON laid out, Base64 and
 * compression unwrapped, a JWT read, an image shown, or a hex dump when it is plain bytes.
 */
export function PayloadView({ message }: { message: PeekedMessage }) {
  const value: Cell = useMemo(
    () =>
      message.payloadEncoding === 'base64'
        ? (decodeBase64(message.payload) ?? message.payload)
        : message.payload,
    [message.payload, message.payloadEncoding],
  )
  const column = useMemo(
    () => ({
      name: 'payload',
      type: /json/i.test(message.properties.contentType ?? '') ? 'json' : 'text',
    }),
    [message.properties.contentType],
  )
  const [forced, setForced] = useState<ViewKind | undefined>(undefined)
  const [result, setResult] = useState<Interpretation | null>(null)

  useEffect(() => {
    let cancelled = false
    void interpret(value, column, forced).then((next) => {
      if (!cancelled) setResult(next)
    })
    return () => {
      cancelled = true
    }
  }, [value, column, forced])

  const views = detectViews(value, column)
  const options = views.some((v) => v.kind === 'hex')
    ? views
    : [...views, { kind: 'hex' as const, label: 'Hex' }]
  const current = forced ?? result?.layers[0]?.kind ?? views[0]?.kind
  const decoded = result ? decodedText(result.rendered) : null

  const copy = (text: string, what: string): void => {
    void writeClipboard(text).then(() => notify(`Copied ${what}.`))
  }

  return (
    <div className="broker-payload">
      <p className="muted value-size">
        {formatByteCount(message.payloadBytes)}
        {message.payloadEncoding === 'base64' ? ' · binary, shown as base64' : ''}
      </p>
      {message.truncated ? (
        <p className="note-warn-inline">
          Only the first part of this payload was read ({formatByteCount(message.payload.length)} of{' '}
          {formatByteCount(message.payloadBytes)}).
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
        <Button
          variant="ghost"
          icon={<Copy size={13} />}
          onClick={() => copy(message.payload, 'the payload')}
        >
          Copy
        </Button>
        {decoded !== null && decoded !== message.payload ? (
          <Button variant="ghost" onClick={() => copy(decoded, 'the decoded payload')}>
            Copy decoded
          </Button>
        ) : null}
      </div>
    </div>
  )
}
