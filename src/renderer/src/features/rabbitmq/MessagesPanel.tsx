import { Eye, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { DEFAULT_PEEK_MESSAGES, type PeekedMessage } from '@shared/rabbitmq'
import { Button } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { exchangeLabel, formatBytes, messageOf } from './format'
import { PayloadView } from './PayloadView'
import { Chip, VirtualRows } from '@/components/panel'

const COUNTS = [1, 10, 50, 100, 500]
const ROW_HEIGHT = 30

function preview(message: PeekedMessage): string {
  if (message.payloadEncoding === 'base64') return `(binary, ${formatBytes(message.payloadBytes)})`
  return message.payload.replace(/\s+/g, ' ').slice(0, 160)
}

function Properties({ message }: { message: PeekedMessage }) {
  const { properties } = message
  const rows: [string, string][] = [
    ['Exchange', exchangeLabel(message.exchange)],
    ['Routing key', message.routingKey || '(empty)'],
    ['Redelivered', message.redelivered ? 'yes' : 'no'],
    ['Content type', properties.contentType ?? ''],
    ['Content encoding', properties.contentEncoding ?? ''],
    [
      'Delivery mode',
      properties.deliveryMode === 2
        ? 'persistent'
        : properties.deliveryMode === 1
          ? 'transient'
          : '',
    ],
    ['Priority', properties.priority === undefined ? '' : String(properties.priority)],
    ['Message id', properties.messageId ?? ''],
    ['Correlation id', properties.correlationId ?? ''],
    ['Reply to', properties.replyTo ?? ''],
    ['Expiration', properties.expiration ?? ''],
    [
      'Timestamp',
      properties.timestamp === undefined
        ? ''
        : new Date(properties.timestamp * 1000).toLocaleString(),
    ],
    ['Type', properties.type ?? ''],
    ['User id', properties.userId ?? ''],
    ['App id', properties.appId ?? ''],
  ]
  return (
    <dl className="facts broker-props">
      {rows
        .filter(([, value]) => value !== '')
        .map(([label, value]) => (
          <div key={label} className="broker-prop">
            <dt>{label}</dt>
            <dd className="mono selectable">{value}</dd>
          </div>
        ))}
    </dl>
  )
}

interface MessagesPanelProps {
  connectionId: string
  vhost: string
  queue: string
  type: string
  ready: number
}

/**
 * Looking at what is in a queue. A peek takes the first messages and puts them straight back, which is the
 * only way the broker offers to read without consuming; it marks them redelivered, and on a quorum queue
 * each look counts toward the delivery limit. The panel says so before anything is asked.
 */
export function MessagesPanel({ connectionId, vhost, queue, type, ready }: MessagesPanelProps) {
  const [count, setCount] = useState(DEFAULT_PEEK_MESSAGES)
  const [messages, setMessages] = useState<PeekedMessage[] | null>(null)
  const [selected, setSelected] = useState(0)
  const [state, setState] = useState<'idle' | 'peeking'>('idle')
  const [error, setError] = useState<string | null>(null)
  const stream = type === 'stream'

  const peek = async (): Promise<void> => {
    setState('peeking')
    setError(null)
    try {
      const found = await coreLink.call('broker.peek', { connectionId, vhost, queue, count })
      setMessages(found)
      setSelected(0)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setState('idle')
    }
  }

  const current = messages?.[selected]

  return (
    <section className="broker-section broker-messages">
      <h2>Messages</h2>
      <div className="broker-peek-bar">
        <label className="broker-peek-count">
          Look at the first
          <select
            value={count}
            onChange={(event) => setCount(Number(event.target.value))}
            aria-label="How many messages"
          >
            {COUNTS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="primary"
          icon={<Eye size={14} />}
          disabled={state === 'peeking' || stream}
          onClick={() => void peek()}
          title={stream ? 'Streams can’t be read this way' : undefined}
        >
          {state === 'peeking' ? 'Looking…' : 'Peek'}
        </Button>
        <span className="muted">
          {ready > 0 ? `${ready.toLocaleString()} ready` : 'No messages are ready'}
        </span>
      </div>

      <p className="broker-note">
        <TriangleAlert size={13} aria-hidden /> Peeking takes each message and puts it straight back
        where it was. RabbitMQ marks them <em>redelivered</em>
        {type === 'quorum'
          ? ', and on a quorum queue each look counts as a delivery attempt, so a message looked at too often can reach the queue’s delivery limit and be dead-lettered'
          : ''}
        .
      </p>
      {stream ? (
        <p className="note-warn-inline">
          This is a stream. The management API can’t read a stream; use a stream client.
        </p>
      ) : null}
      {error ? (
        <p className="note-error" role="alert">
          {error}
        </p>
      ) : null}

      {messages === null ? null : messages.length === 0 ? (
        <p className="muted">The queue had no messages to look at.</p>
      ) : (
        <div className="broker-peek">
          <div className="broker-peek-list" role="listbox" aria-label="Messages">
            <div className="broker-peek-head" aria-hidden>
              <span>#</span>
              <span>Routing key</span>
              <span>Size</span>
              <span>Payload</span>
            </div>
            <VirtualRows
              count={messages.length}
              rowHeight={ROW_HEIGHT}
              render={(index) => {
                const message = messages[index]!
                return (
                  <div
                    key={index}
                    role="option"
                    aria-selected={index === selected}
                    className={`broker-peek-row ${index === selected ? 'selected' : ''}`}
                    style={{ height: ROW_HEIGHT }}
                    onClick={() => setSelected(index)}
                  >
                    <span className="muted">{message.index}</span>
                    <span className="mono">{message.routingKey || '—'}</span>
                    <span className="muted">{formatBytes(message.payloadBytes)}</span>
                    <span className="mono broker-peek-payload">
                      {message.redelivered ? <Chip tone="warn">redelivered</Chip> : null}{' '}
                      {preview(message)}
                    </span>
                  </div>
                )
              }}
            />
          </div>
          {current ? (
            <div className="broker-peek-detail">
              <Properties message={current} />
              {current.properties.headers ? (
                <>
                  <h3>Headers</h3>
                  <pre className="value-block mono selectable">
                    {JSON.stringify(current.properties.headers, null, 2)}
                  </pre>
                </>
              ) : null}
              <h3>Payload</h3>
              <PayloadView key={`${current.index}:${current.payload.length}`} message={current} />
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}
