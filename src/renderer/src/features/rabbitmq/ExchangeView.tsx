import { Send, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { isBuiltInExchange } from '@shared/rabbitmq'
import { Button, EnvBadge } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { useData } from '@/state/data'
import { useWorkbench, type Tab } from '@/state/workbench'
import { BindForm, BindingsTable } from './Bindings'
import { exchangeLabel, formatRate } from './format'
import { changeData, useWritable } from '@/state/writes'
import { PublishDialog } from './PublishDialog'
import { useServerCall } from '@/lib/useServerCall'
import { Chip, LockButton, RefreshControls, Stat } from '@/components/panel'

/** One exchange: its type, where it sends what it receives, and what sends to it. */
export function ExchangeView({ tab, active }: { tab: Tab; active: boolean }) {
  const connectionId = tab.connectionId!
  const { vhost, name } = tab.broker!
  const exchangeName = name ?? ''
  const connection = useData((state) => state.connections.find((c) => c.id === connectionId))
  const writable = useWritable(connectionId)
  const [auto, setAuto] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const builtIn = isBuiltInExchange(exchangeName)

  const call = useServerCall(
    (signal) =>
      coreLink.call('broker.exchange', { connectionId, vhost, name: exchangeName }, { signal }),
    { refreshMs: 5000, paused: !active || !auto },
  )
  const exchange = call.data

  const remove = async (): Promise<void> => {
    const ran = await changeData({
      connectionId,
      title: `Delete “${exchangeName}”?`,
      confirmLabel: 'Delete',
      destructive: true,
      reasons: [
        'Deleting the exchange removes every binding to and from it, and it can’t be undone.',
      ],
      lines: [`Delete the exchange “${exchangeName}” in vhost ${vhost}`],
      done: `Deleted the exchange “${exchangeName}”.`,
      run: () =>
        coreLink.call('broker.deleteExchange', {
          connectionId,
          vhost,
          writable: true,
          name: exchangeName,
        }),
    })
    if (ran) useWorkbench.getState().closeTab(tab.id)
  }

  return (
    <div className="broker-tab">
      <header className="broker-header">
        <div className="broker-title">
          <h1 className="mono">{exchangeLabel(exchangeName)}</h1>
          <span className="muted">exchange in vhost</span>
          <span className="mono">{vhost}</span>
          {connection ? <EnvBadge environment={connection.environment} /> : null}
          {exchange ? (
            <>
              <Chip>{exchange.type}</Chip>
              {exchange.durable ? <Chip>durable</Chip> : <Chip tone="warn">transient</Chip>}
              {exchange.autoDelete ? <Chip>auto-delete</Chip> : null}
              {exchange.internal ? <Chip>internal</Chip> : null}
              {builtIn ? <Chip>built in</Chip> : null}
            </>
          ) : null}
        </div>
        <div className="broker-toolbar">
          <Button icon={<Send size={14} />} onClick={() => setPublishing(true)}>
            Publish…
          </Button>
          {builtIn ? null : (
            <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => void remove()}>
              Delete
            </Button>
          )}
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
        {call.loading ? <p className="muted">Reading the exchange…</p> : null}

        {exchange ? (
          <>
            <div className="broker-stats">
              <Stat
                label="In / s"
                value={formatRate(exchange.rateIn)}
                hint="Messages published to the exchange per second"
              />
              <Stat
                label="Out / s"
                value={formatRate(exchange.rateOut)}
                hint="Messages the exchange routed on per second"
              />
              <Stat label="Sends to" value={exchange.bindingsFrom.length} />
              <Stat label="Fed by exchanges" value={exchange.bindingsTo.length} />
            </div>

            <section className="broker-section">
              <h2>Sends to</h2>
              {exchangeName === '' ? (
                <p className="muted">
                  The default exchange sends a message to the queue whose name is the routing key.
                </p>
              ) : (
                <>
                  <BindingsTable
                    bindings={exchange.bindingsFrom}
                    side="destination"
                    empty="Nothing is bound to this exchange, so messages published to it go nowhere."
                    locked={!writable}
                    onRemove={(binding) =>
                      void changeData({
                        connectionId,
                        title: 'Remove this binding?',
                        confirmLabel: 'Remove',
                        lines: [
                          `Unbind “${exchangeName}” from the ${binding.destinationType} “${binding.destination}” (routing key “${binding.routingKey}”)`,
                        ],
                        done: 'Removed the binding.',
                        run: () =>
                          coreLink
                            .call('broker.unbind', {
                              connectionId,
                              vhost,
                              writable: true,
                              request: {
                                source: exchangeName,
                                destination: binding.destination,
                                destinationType: binding.destinationType,
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
                    anchor={{ kind: 'exchange', name: exchangeName }}
                    onDone={call.reload}
                  />
                </>
              )}
            </section>

            {exchange.bindingsTo.length > 0 ? (
              <section className="broker-section">
                <h2>Fed by exchanges</h2>
                <BindingsTable
                  bindings={exchange.bindingsTo}
                  side="source"
                  empty=""
                  locked={!writable}
                  onRemove={(binding) =>
                    void changeData({
                      connectionId,
                      title: 'Remove this binding?',
                      confirmLabel: 'Remove',
                      lines: [`Unbind “${binding.source}” from the exchange “${exchangeName}”`],
                      done: 'Removed the binding.',
                      run: () =>
                        coreLink
                          .call('broker.unbind', {
                            connectionId,
                            vhost,
                            writable: true,
                            request: {
                              source: binding.source,
                              destination: exchangeName,
                              destinationType: 'exchange',
                              propertiesKey: binding.propertiesKey,
                            },
                          })
                          .then(call.reload),
                    })
                  }
                />
              </section>
            ) : null}

            <section className="broker-section">
              <h2>Details</h2>
              <dl className="facts">
                <dt>Policy</dt>
                <dd>{exchange.policy ?? 'none'}</dd>
                <dt>Arguments</dt>
                <dd className="mono selectable">
                  {Object.keys(exchange.arguments).length > 0
                    ? JSON.stringify(exchange.arguments)
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
          exchange={exchangeName}
          routingKey=""
          onClose={() => setPublishing(false)}
          onPublished={call.reload}
        />
      ) : null}
    </div>
  )
}
