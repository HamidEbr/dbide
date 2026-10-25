import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { BindingInfo, BindingTarget } from '@shared/rabbitmq'
import { Button, IconButton, Segmented } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { exchangeLabel } from './format'
import { changeData } from '@/state/writes'
import { useServerCall } from '@/lib/useServerCall'
import { Chip } from '@/components/panel'
import { parseJsonObject } from './widgets'

interface BindingsTableProps {
  bindings: BindingInfo[]
  /** What the first column shows: where a message comes from, or where it goes. */
  side: 'source' | 'destination'
  empty: string
  onRemove: (binding: BindingInfo) => void
  locked: boolean
}

export function BindingsTable({ bindings, side, empty, onRemove, locked }: BindingsTableProps) {
  if (bindings.length === 0) return <p className="muted">{empty}</p>
  return (
    <table className="broker-table">
      <thead>
        <tr>
          <th>{side === 'source' ? 'From exchange' : 'To'}</th>
          <th>Routing key</th>
          <th>Arguments</th>
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {bindings.map((binding) => (
          <tr
            key={`${binding.source}|${binding.destination}|${binding.destinationType}|${binding.propertiesKey}`}
          >
            <td className="mono">
              {side === 'source' ? exchangeLabel(binding.source) : binding.destination}
              {side === 'destination' ? (
                <span className="muted"> · {binding.destinationType}</span>
              ) : null}
            </td>
            <td className="mono">
              {binding.routingKey === '' ? (
                <span className="muted">(empty)</span>
              ) : (
                binding.routingKey
              )}
            </td>
            <td className="mono muted">
              {Object.keys(binding.arguments).length > 0 ? JSON.stringify(binding.arguments) : ''}
            </td>
            <td className="broker-actions">
              {binding.source === '' && side === 'source' ? (
                <Chip>implicit</Chip>
              ) : (
                <IconButton
                  label={locked ? 'Unlock writes to remove this binding' : 'Remove this binding'}
                  onClick={() => onRemove(binding)}
                >
                  <Trash2 size={13} />
                </IconButton>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

interface BindFormProps {
  connectionId: string
  vhost: string
  /** Fixed on one end: a queue's own tab binds exchanges to it; an exchange's binds it to others. */
  anchor: { kind: 'queue' | 'exchange'; name: string }
  onDone: () => void
}

/** Adds a binding. A queue's tab asks for the exchange; an exchange's tab asks for a queue or exchange to send to. */
export function BindForm({ connectionId, vhost, anchor, onDone }: BindFormProps) {
  const [other, setOther] = useState('')
  const [targetKind, setTargetKind] = useState<BindingTarget>('queue')
  const [routingKey, setRoutingKey] = useState('')
  const [args, setArgs] = useState('')
  const [error, setError] = useState<string | null>(null)
  // The names to suggest. A short wait for the listing is fine: the form works without it.
  const listing = useServerCall((signal) =>
    coreLink.call('broker.listing', { connectionId, vhost }, { signal }),
  )
  const sourceMode = anchor.kind === 'queue'

  const bind = async (): Promise<void> => {
    if (other.trim() === '')
      return setError(sourceMode ? 'Name the exchange.' : 'Name where it should send.')
    const parsed = parseJsonObject(args, 'Arguments')
    if (!parsed.ok) return setError(parsed.message)
    const request = sourceMode
      ? {
          source: other,
          destination: anchor.name,
          destinationType: 'queue' as const,
          routingKey,
          arguments: parsed.value,
        }
      : {
          source: anchor.name,
          destination: other,
          destinationType: targetKind,
          routingKey,
          arguments: parsed.value,
        }
    const ran = await changeData({
      connectionId,
      title: 'Add this binding?',
      confirmLabel: 'Bind',
      lines: [
        `Bind ${exchangeLabel(request.source)} to the ${request.destinationType} “${request.destination}” with routing key “${routingKey}”`,
      ],
      done: 'Bound.',
      run: () => coreLink.call('broker.bind', { connectionId, vhost, writable: true, request }),
    })
    if (ran) {
      setOther('')
      setRoutingKey('')
      setArgs('')
      setError(null)
      onDone()
    }
  }

  const suggestions = sourceMode
    ? (listing.data?.exchanges ?? []).filter((e) => e.name !== '').map((e) => e.name)
    : targetKind === 'queue'
      ? (listing.data?.queues ?? []).map((q) => q.name)
      : (listing.data?.exchanges ?? []).filter((e) => e.name !== '').map((e) => e.name)
  const listId = `bind-${anchor.kind}-${anchor.name}`

  return (
    <form
      className="broker-bind"
      onSubmit={(event) => {
        event.preventDefault()
        void bind()
      }}
    >
      {sourceMode ? null : (
        <Segmented<BindingTarget>
          label="Send to"
          value={targetKind}
          onChange={setTargetKind}
          options={[
            { value: 'queue', label: 'Queue' },
            { value: 'exchange', label: 'Exchange' },
          ]}
        />
      )}
      <input
        className="mono"
        aria-label={sourceMode ? 'Exchange' : 'Destination'}
        placeholder={sourceMode ? 'exchange' : targetKind === 'queue' ? 'queue' : 'exchange'}
        list={listId}
        value={other}
        onChange={(event) => {
          setOther(event.target.value)
          setError(null)
        }}
        spellCheck={false}
      />
      <datalist id={listId}>
        {suggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <input
        className="mono"
        aria-label="Routing key"
        placeholder="routing key"
        value={routingKey}
        onChange={(event) => setRoutingKey(event.target.value)}
        spellCheck={false}
      />
      <input
        className="mono"
        aria-label="Arguments"
        placeholder='arguments, such as { "x-match": "all" }'
        value={args}
        onChange={(event) => setArgs(event.target.value)}
        spellCheck={false}
      />
      <Button type="submit">Bind</Button>
      {error ? (
        <p className="note-error broker-bind-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}
