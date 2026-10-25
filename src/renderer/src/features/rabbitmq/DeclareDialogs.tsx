import { useState } from 'react'
import { Dialog } from '@/components/Dialog'
import { Button, Field, Segmented } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { changeData } from '@/state/writes'
import { parseJsonObject } from './widgets'

interface DialogProps {
  connectionId: string
  vhost: string
  onClose: () => void
  onDone: (name: string) => void
}

export function DeclareQueueDialog({ connectionId, vhost, onClose, onDone }: DialogProps) {
  const [form, setForm] = useState({
    name: '',
    type: 'classic' as 'classic' | 'quorum' | 'stream',
    durable: true,
    autoDelete: false,
    args: '',
  })
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<typeof form>): void => {
    setForm((current) => ({ ...current, ...patch }))
    setError(null)
  }
  // Quorum queues and streams are always durable and can't delete themselves.
  const fixed = form.type !== 'classic'

  const create = async (): Promise<void> => {
    if (form.name.trim() === '') return setError('Give the queue a name.')
    const args = parseJsonObject(form.args, 'Arguments')
    if (!args.ok) return setError(args.message)
    const ran = await changeData({
      connectionId,
      title: 'Create this queue?',
      confirmLabel: 'Create',
      lines: [`Create the ${form.type} queue “${form.name}” in vhost ${vhost}`],
      done: `Created the queue “${form.name}”.`,
      run: () =>
        coreLink.call('broker.declareQueue', {
          connectionId,
          vhost,
          writable: true,
          request: {
            name: form.name,
            type: form.type,
            durable: fixed ? true : form.durable,
            autoDelete: fixed ? false : form.autoDelete,
            arguments: args.value,
          },
        }),
    })
    if (ran) {
      onDone(form.name)
      onClose()
    }
  }

  return (
    <Dialog title="New queue" onClose={onClose}>
      <Field label="Name">
        {(id) => (
          <input
            id={id}
            className="mono"
            autoFocus
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            spellCheck={false}
          />
        )}
      </Field>
      <Segmented<'classic' | 'quorum' | 'stream'>
        label="Type"
        value={form.type}
        onChange={(type) => set({ type })}
        options={[
          { value: 'classic', label: 'Classic' },
          { value: 'quorum', label: 'Quorum' },
          { value: 'stream', label: 'Stream' },
        ]}
      />
      <label className="check">
        <input
          type="checkbox"
          checked={fixed ? true : form.durable}
          disabled={fixed}
          onChange={(e) => set({ durable: e.target.checked })}
        />
        Durable (survives a restart of the broker)
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={fixed ? false : form.autoDelete}
          disabled={fixed}
          onChange={(e) => set({ autoDelete: e.target.checked })}
        />
        Delete when the last consumer goes away
      </label>
      <Field label="Arguments" hint='Optional. A JSON object, such as { "x-message-ttl": 60000 }.'>
        {(id) => (
          <textarea
            id={id}
            className="mono"
            rows={3}
            value={form.args}
            spellCheck={false}
            onChange={(e) => set({ args: e.target.value })}
          />
        )}
      </Field>
      {error ? (
        <p className="note-error" role="alert">
          {error}
        </p>
      ) : null}
      <footer>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void create()}>
          Create
        </Button>
      </footer>
    </Dialog>
  )
}

const EXCHANGE_TYPES = ['direct', 'fanout', 'topic', 'headers'] as const

export function DeclareExchangeDialog({ connectionId, vhost, onClose, onDone }: DialogProps) {
  const [form, setForm] = useState({
    name: '',
    type: 'topic' as (typeof EXCHANGE_TYPES)[number],
    durable: true,
    autoDelete: false,
    internal: false,
    args: '',
  })
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<typeof form>): void => {
    setForm((current) => ({ ...current, ...patch }))
    setError(null)
  }

  const create = async (): Promise<void> => {
    if (form.name.trim() === '') return setError('Give the exchange a name.')
    if (form.name.startsWith('amq.'))
      return setError('Names that start with amq. are the broker’s own.')
    const args = parseJsonObject(form.args, 'Arguments')
    if (!args.ok) return setError(args.message)
    const ran = await changeData({
      connectionId,
      title: 'Create this exchange?',
      confirmLabel: 'Create',
      lines: [`Create the ${form.type} exchange “${form.name}” in vhost ${vhost}`],
      done: `Created the exchange “${form.name}”.`,
      run: () =>
        coreLink.call('broker.declareExchange', {
          connectionId,
          vhost,
          writable: true,
          request: { ...form, arguments: args.value },
        }),
    })
    if (ran) {
      onDone(form.name)
      onClose()
    }
  }

  return (
    <Dialog title="New exchange" onClose={onClose}>
      <Field label="Name">
        {(id) => (
          <input
            id={id}
            className="mono"
            autoFocus
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            spellCheck={false}
          />
        )}
      </Field>
      <Segmented<(typeof EXCHANGE_TYPES)[number]>
        label="Type"
        value={form.type}
        onChange={(type) => set({ type })}
        options={EXCHANGE_TYPES.map((type) => ({ value: type, label: type }))}
      />
      <label className="check">
        <input
          type="checkbox"
          checked={form.durable}
          onChange={(e) => set({ durable: e.target.checked })}
        />
        Durable
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={form.autoDelete}
          onChange={(e) => set({ autoDelete: e.target.checked })}
        />
        Delete when nothing is bound to it any more
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={form.internal}
          onChange={(e) => set({ internal: e.target.checked })}
        />
        Internal (only other exchanges can publish to it)
      </label>
      <Field
        label="Arguments"
        hint='Optional. A JSON object, such as { "alternate-exchange": "unrouted" }.'
      >
        {(id) => (
          <textarea
            id={id}
            className="mono"
            rows={3}
            value={form.args}
            spellCheck={false}
            onChange={(e) => set({ args: e.target.value })}
          />
        )}
      </Field>
      {error ? (
        <p className="note-error" role="alert">
          {error}
        </p>
      ) : null}
      <footer>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void create()}>
          Create
        </Button>
      </footer>
    </Dialog>
  )
}
