import { Eraser, Send, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button, EnvBadge } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { useData } from '@/state/data'
import { useWorkbench, type Tab } from '@/state/workbench'
import { BindForm, BindingsTable } from './Bindings'
import { formatBytes, formatCount, formatRate } from './format'
import { changeData, useWritable } from '@/state/writes'
import { MessagesPanel } from './MessagesPanel'
import { PublishDialog } from './PublishDialog'
import { useServerCall } from '@/lib/useServerCall'
import { Chip, LockButton, RefreshControls, Stat } from '@/components/panel'
import { StateChip } from './widgets'

/** One queue: what it holds, who reads it, how it is bound, and a way to look inside. */
export function QueueView({ tab, active }: { tab: Tab; active: boolean }) {
  const connectionId = tab.connectionId!
  const { vhost, name } = tab.broker!
  const queueName = name!
  const connection = useData((state) => state.connections.find((c) => c.id === connectionId))
  const writable = useWritable(connectionId)
  const [auto, setAuto] = useState(true)
  const [publishing, setPublishing] = useState(false)

  const call = useServerCall(
    (signal) => coreLink.call('broker.queue', { connectionId, vhost, name: queueName }, { signal }),
    { refreshMs: 5000, paused: !active || !auto },
  )
  const queue = call.data
  const close = (): void => useWorkbench.getState().closeTab(tab.id)

  const purge = (): Promise<boolean> =>
    changeData({
      connectionId,
      title: `Purge “${queueName}”?`,
      confirmLabel: 'Purge',
      destructive: true,
      reasons: ['Purging removes every ready message, and it can’t be undone.'],
      lines: [
        `Remove ${formatCount(queue?.ready ?? 0)} ready messages from the queue “${queueName}” in vhost ${vhost}`,
      ],
      done: 'Purged the queue.',
      run: () =>
        coreLink
          .call('broker.purge', { connectionId, vhost, writable: true, queue: queueName })
          .then(call.reload),
    })

  const remove = async (): Promise<void> => {
    const ran = await changeData({
      connectionId,
      title: `Delete “${queueName}”?`,
      confirmLabel: 'Delete',
      destructive: true,
      reasons: [
        'Deleting the queue removes its messages and its bindings, and it can’t be undone.',
      ],
      lines: [
        `Delete the queue “${queueName}” in vhost ${vhost}, with ${formatCount(queue?.messages ?? 0)} messages`,
      ],
      done: `Deleted the queue “${queueName}”.`,
      run: () =>
        coreLink.call('broker.deleteQueue', {
          connectionId,
          vhost,
          writable: true,
          name: queueName,
        }),
    })
    if (ran) close()
  }

  return (
    <div className="broker-tab">
      <header className="broker-header">
        <div className="broker-title">
          <h1 className="mono">{queueName}</h1>
          <span className="muted">queue in vhost</span>
          <span className="mono">{vhost}</span>
          {connection ? <EnvBadge environment={connection.environment} /> : null}
          {queue ? (
            <>
              <Chip>{queue.type}</Chip>
              <StateChip state={queue.state} />
              {queue.durable ? <Chip>durable</Chip> : <Chip tone="warn">transient</Chip>}
              {queue.autoDelete ? <Chip>auto-delete</Chip> : null}
              {queue.exclusive ? <Chip>exclusive</Chip> : null}
            </>
          ) : null}
        </div>
        <div className="broker-toolbar">
          <Button icon={<Send size={14} />} onClick={() => setPublishing(true)}>
            Publish…
          </Button>
          <Button
            icon={<Eraser size={14} />}
            disabled={!writable && false}
            onClick={() => void purge()}
          >
            Purge
          </Button>
          <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => void remove()}>
            Delete
          </Button>
          <span className="spacer" />
          <RefreshControls
            onReload={call.reload}
            auto={auto}
            onAuto={setAuto}
            updatedAt={call.updatedAt}
          />
          <LockButton
            connectionId={connectionId}
            allows="publishing, purging, creating and deleting"
          />
        </div>
      </header>

      <div className="broker-body">
        {call.error ? (
          <p className="note-error" role="alert">
            {call.error}
          </p>
        ) : null}
        {call.loading ? <p className="muted">Reading the queue…</p> : null}

        {queue ? (
          <>
            <div className="broker-stats">
              <Stat label="Ready" value={formatCount(queue.ready)} />
              <Stat
                label="Unacked"
                value={formatCount(queue.unacked)}
                hint="Delivered to a consumer and not yet acknowledged"
              />
              <Stat label="Total" value={formatCount(queue.messages)} />
              <Stat label="Consumers" value={formatCount(queue.consumers)} />
              <Stat
                label="In / s"
                value={formatRate(queue.rateIn)}
                hint="Messages published to the queue per second"
              />
              <Stat
                label="Out / s"
                value={formatRate(queue.rateOut)}
                hint="Messages delivered from the queue per second"
              />
            </div>

            <MessagesPanel
              key={`${connectionId}:${vhost}:${queueName}`}
              connectionId={connectionId}
              vhost={vhost}
              queue={queueName}
              type={queue.type}
              ready={queue.ready}
            />

            <section className="broker-section">
              <h2>Bindings</h2>
              <BindingsTable
                bindings={queue.bindings}
                side="source"
                empty="Nothing is bound to this queue."
                locked={!writable}
                onRemove={(binding) =>
                  void changeData({
                    connectionId,
                    title: 'Remove this binding?',
                    confirmLabel: 'Remove',
                    lines: [
                      `Unbind ${binding.source === '' ? '(default)' : binding.source} from “${queueName}” (routing key “${binding.routingKey}”)`,
                    ],
                    done: 'Removed the binding.',
                    run: () =>
                      coreLink
                        .call('broker.unbind', {
                          connectionId,
                          vhost,
                          writable: true,
                          request: {
                            source: binding.source,
                            destination: queueName,
                            destinationType: 'queue',
                            propertiesKey: binding.propertiesKey,
                          },
                        })
                        .then(call.reload),
                  })
                }
              />
              <BindForm
                connectionId={connectionId}
                vhost={vhost}
                anchor={{ kind: 'queue', name: queueName }}
                onDone={call.reload}
              />
              <p className="muted broker-hint">
                Every queue is also bound to the default exchange by its own name, which is why a
                message published there with the queue’s name as the routing key arrives.
              </p>
            </section>

            <section className="broker-section">
              <h2>Consumers</h2>
              {queue.consumerDetails.length === 0 ? (
                <p className="muted">No consumer is attached.</p>
              ) : (
                <table className="broker-table">
                  <thead>
                    <tr>
                      <th>Tag</th>
                      <th>Channel</th>
                      <th>Acks</th>
                      <th>Prefetch</th>
                      <th>Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queue.consumerDetails.map((consumer) => (
                      <tr key={consumer.tag}>
                        <td className="mono">{consumer.tag}</td>
                        <td className="mono muted">{consumer.channel ?? ''}</td>
                        <td>{consumer.ackRequired ? 'required' : 'automatic'}</td>
                        <td>{consumer.prefetch ?? ''}</td>
                        <td>{consumer.active === null ? '' : consumer.active ? 'yes' : 'no'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="broker-section">
              <h2>Details</h2>
              <dl className="facts">
                <dt>Node</dt>
                <dd className="mono">{queue.node ?? '–'}</dd>
                {queue.members.length > 0 ? (
                  <>
                    <dt>Members</dt>
                    <dd className="mono">
                      {queue.members.join(', ')}
                      {queue.leader ? ` (leader ${queue.leader})` : ''}
                    </dd>
                  </>
                ) : null}
                <dt>Policy</dt>
                <dd>{queue.policy ?? 'none'}</dd>
                <dt>Memory</dt>
                <dd>{formatBytes(queue.memory)}</dd>
                <dt>Idle since</dt>
                <dd>{queue.idleSince ?? '–'}</dd>
                <dt>Arguments</dt>
                <dd className="mono selectable">
                  {Object.keys(queue.arguments).length > 0
                    ? JSON.stringify(queue.arguments)
                    : 'none'}
                </dd>
              </dl>
            </section>
          </>
        ) : null}
      </div>

      {publishing ? (
        <PublishDialog
          connectionId={connectionId}
          vhost={vhost}
          exchange=""
          routingKey={queueName}
          onClose={() => setPublishing(false)}
          onPublished={call.reload}
        />
      ) : null}
    </div>
  )
}
