import { Send, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MessageProperties, PublishRequest } from '@shared/rabbitmq'
import { Button, Field, IconButton, Segmented } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { useServerCall } from '@/lib/useServerCall'
import { notify } from '@/state/notices'
import { exchangeLabel } from './format'
import { changeData } from '@/state/writes'
import { parseJsonObject } from './widgets'

const CONTENT_TYPES = [
  'text/plain',
  'application/json',
  'application/xml',
  'application/octet-stream',
]

interface PublishDialogProps {
  connectionId: string
  vhost: string
  /** Where the message starts out. A queue's own tab sends through the default exchange to that queue. */
  exchange: string
  routingKey: string
  onClose: () => void
  onPublished: () => void
}

/** The form for sending one message. It publishes through the management API, like the broker's own UI. */
export function PublishDialog({
  connectionId,
  vhost,
  exchange,
  routingKey,
  onClose,
  onPublished,
}: PublishDialogProps) {
  const [form, setForm] = useState({
    exchange,
    routingKey,
    payload: '',
    encoding: 'string' as 'string' | 'base64',
    contentType: 'text/plain',
    persistent: true,
    headers: '',
    priority: '',
    expiration: '',
    messageId: '',
    correlationId: '',
    replyTo: '',
    type: '',
    appId: '',
  })
  // Names to suggest: the exchanges, and then the routing keys that exchange is bound with (or the queues, for the
  // default exchange). The form works without them, so a failed read just leaves the lists empty.
  const listing = useServerCall((signal) =>
    coreLink.call('broker.listing', { connectionId, vhost }, { signal }),
  )
  const [boundKeys, setBoundKeys] = useState<string[]>([])
  const exchangeNames = (listing.data?.exchanges ?? [])
    .filter((e) => e.name !== '')
    .map((e) => e.name)
  const known = exchangeNames.includes(form.exchange)
  useEffect(() => {
    if (!known) return
    const controller = new AbortController()
    coreLink
      .call(
        'broker.exchange',
        { connectionId, vhost, name: form.exchange },
        { signal: controller.signal },
      )
      .then((detail) =>
        setBoundKeys([
          ...new Set(detail.bindingsFrom.map((b) => b.routingKey).filter((k) => k !== '')),
        ]),
      )
      .catch(() => setBoundKeys([]))
    return () => controller.abort()
  }, [known, form.exchange, connectionId, vhost])
  const routingKeys =
    form.exchange === '' ? (listing.data?.queues ?? []).map((q) => q.name) : known ? boundKeys : []
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const set = (patch: Partial<typeof form>): void => {
    setForm((current) => ({ ...current, ...patch }))
    setError(null)
  }

  const send = async (): Promise<void> => {
    const headers = parseJsonObject(form.headers, 'Headers')
    if (!headers.ok) return setError(headers.message)
    if (form.priority !== '' && !/^\d{1,3}$/.test(form.priority)) {
      return setError('Priority is a whole number.')
    }
    if (
      form.encoding === 'base64' &&
      form.payload.trim() !== '' &&
      !/^[A-Za-z0-9+/=\s]*$/.test(form.payload)
    ) {
      return setError('The payload isn’t valid base64.')
    }

    const properties: MessageProperties = {
      ...(form.contentType ? { contentType: form.contentType } : {}),
      deliveryMode: form.persistent ? 2 : 1,
      ...(form.priority !== '' ? { priority: Number(form.priority) } : {}),
      ...(form.expiration ? { expiration: form.expiration } : {}),
      ...(form.messageId ? { messageId: form.messageId } : {}),
      ...(form.correlationId ? { correlationId: form.correlationId } : {}),
      ...(form.replyTo ? { replyTo: form.replyTo } : {}),
      ...(form.type ? { type: form.type } : {}),
      ...(form.appId ? { appId: form.appId } : {}),
      ...(Object.keys(headers.value).length > 0 ? { headers: headers.value } : {}),
    }
    const request: PublishRequest = {
      exchange: form.exchange,
      routingKey: form.routingKey,
      payload: form.encoding === 'base64' ? form.payload.replace(/\s+/g, '') : form.payload,
      payloadEncoding: form.encoding,
      properties,
    }

    setSending(true)
    let routed: boolean | null = null
    const ran = await changeData({
      connectionId,
      title: 'Publish this message?',
      confirmLabel: 'Publish',
      lines: [
        `Publish to ${exchangeLabel(form.exchange)} with routing key “${form.routingKey}” in vhost ${vhost}`,
        `${request.payload.length.toLocaleString()} characters of ${form.contentType || 'no content type'}`,
      ],
      run: async () => {
        routed = (
          await coreLink.call('broker.publish', { connectionId, vhost, writable: true, request })
        ).routed
      },
    })
    setSending(false)
    if (!ran) return
    if (routed === false) {
      notify(
        'The broker accepted the message but no queue took it: nothing is bound for that routing key.',
        'warn',
      )
    } else {
      notify('Published.')
    }
    onPublished()
    onClose()
  }

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div
        className="dialog dialog-wide broker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }}
      >
        <header>
          <Send size={18} className="dialog-icon neutral" aria-hidden />
          <h2 id="publish-title">Publish a message</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </header>

        <div className="form-grid">
          <Field
            label="Exchange"
            hint="Leave empty for the default exchange, which sends to the queue named by the routing key."
          >
            {(id) => (
              <input
                id={id}
                className="mono"
                value={form.exchange}
                list="publish-exchanges"
                placeholder="(default)"
                onChange={(e) => set({ exchange: e.target.value })}
                spellCheck={false}
              />
            )}
          </Field>
          <Field label="Routing key">
            {(id) => (
              <input
                id={id}
                className="mono"
                value={form.routingKey}
                list="publish-routing-keys"
                onChange={(e) => set({ routingKey: e.target.value })}
                spellCheck={false}
              />
            )}
          </Field>
        </div>

        <Field label="Payload">
          {(id) => (
            <textarea
              id={id}
              className="mono broker-payload-input"
              rows={8}
              value={form.payload}
              spellCheck={false}
              autoFocus
              onChange={(e) => set({ payload: e.target.value })}
            />
          )}
        </Field>
        <div className="broker-inline">
          <Segmented<'string' | 'base64'>
            label="Payload is"
            value={form.encoding}
            onChange={(encoding) => set({ encoding })}
            options={[
              { value: 'string', label: 'Text' },
              { value: 'base64', label: 'Base64' },
            ]}
          />
          <Field label="Content type">
            {(id) => (
              <input
                id={id}
                className="mono"
                list="content-types"
                value={form.contentType}
                onChange={(e) => set({ contentType: e.target.value })}
                spellCheck={false}
              />
            )}
          </Field>
          <datalist id="publish-exchanges">
            {exchangeNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <datalist id="publish-routing-keys">
            {routingKeys.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <datalist id="content-types">
            {CONTENT_TYPES.map((type) => (
              <option key={type} value={type} />
            ))}
          </datalist>
          <label className="check">
            <input
              type="checkbox"
              checked={form.persistent}
              onChange={(e) => set({ persistent: e.target.checked })}
            />
            Persistent
          </label>
        </div>

        <Field label="Headers" hint='Optional. A JSON object, such as { "attempt": 1 }.'>
          {(id) => (
            <textarea
              id={id}
              className="mono"
              rows={2}
              value={form.headers}
              spellCheck={false}
              onChange={(e) => set({ headers: e.target.value })}
            />
          )}
        </Field>

        <details className="broker-more">
          <summary>More properties</summary>
          <div className="form-grid">
            {(
              [
                ['priority', 'Priority'],
                ['expiration', 'Expiration (ms)'],
                ['messageId', 'Message id'],
                ['correlationId', 'Correlation id'],
                ['replyTo', 'Reply to'],
                ['type', 'Type'],
                ['appId', 'App id'],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                {(id) => (
                  <input
                    id={id}
                    className="mono"
                    value={form[key]}
                    onChange={(e) => set({ [key]: e.target.value })}
                    spellCheck={false}
                  />
                )}
              </Field>
            ))}
          </div>
        </details>

        {error ? (
          <p className="note-error" role="alert">
            {error}
          </p>
        ) : null}

        <footer>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={<Send size={13} />}
            disabled={sending}
            onClick={() => void send()}
          >
            {sending ? 'Publishing…' : 'Publish'}
          </Button>
        </footer>
      </div>
    </div>
  )
}
