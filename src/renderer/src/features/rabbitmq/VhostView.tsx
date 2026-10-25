import { ArrowDown, ArrowUp, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { QueueSummary } from '@shared/rabbitmq'
import { Button, EnvBadge } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { useData } from '@/state/data'
import { workbench, type Tab } from '@/state/workbench'
import { DeclareExchangeDialog, DeclareQueueDialog } from './DeclareDialogs'
import { exchangeLabel, formatCount, formatRate } from './format'
import { useServerCall } from '@/lib/useServerCall'
import { Chip, LockButton, RefreshControls, VirtualRows } from '@/components/panel'
import { StateChip } from './widgets'

type SortKey = 'name' | 'type' | 'state' | 'ready' | 'unacked' | 'consumers' | 'rateIn' | 'rateOut'

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: 'name', label: 'Name' },
  { key: 'type', label: 'Type' },
  { key: 'state', label: 'State' },
  { key: 'ready', label: 'Ready', numeric: true },
  { key: 'unacked', label: 'Unacked', numeric: true },
  { key: 'consumers', label: 'Consumers', numeric: true },
  { key: 'rateIn', label: 'In / s', numeric: true },
  { key: 'rateOut', label: 'Out / s', numeric: true },
]

const ROW_HEIGHT = 30

function compare(a: QueueSummary, b: QueueSummary, key: SortKey): number {
  const left = a[key]
  const right = b[key]
  return typeof left === 'number' && typeof right === 'number'
    ? left - right
    : String(left).localeCompare(String(right), undefined, { numeric: true })
}

/** Every queue and exchange of a vhost, as a list that can be filtered and sorted, with a way to make more. */
export function VhostView({ tab, active }: { tab: Tab; active: boolean }) {
  const connectionId = tab.connectionId!
  const { vhost } = tab.broker!
  const connection = useData((state) => state.connections.find((c) => c.id === connectionId))
  const [auto, setAuto] = useState(true)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: 'name',
    descending: false,
  })
  const [selected, setSelected] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'queue' | 'exchange' | null>(null)

  const call = useServerCall(
    (signal) => coreLink.call('broker.listing', { connectionId, vhost }, { signal }),
    {
      refreshMs: 5000,
      paused: !active || !auto,
    },
  )
  const listing = call.data

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const queues = (listing?.queues ?? []).filter(
      (q) => needle === '' || q.name.toLowerCase().includes(needle),
    )
    queues.sort(
      (a, b) =>
        compare(a, b, sort.key) * (sort.descending ? -1 : 1) || a.name.localeCompare(b.name),
    )
    return queues
  }, [listing, filter, sort])

  const open = (name: string): void =>
    workbench.openBroker(connectionId, { view: 'queue', vhost, name })
  const changed = (): void => call.reload()

  return (
    <div className="broker-tab">
      <header className="broker-header">
        <div className="broker-title">
          <h1 className="mono">{vhost}</h1>
          <span className="muted">vhost</span>
          {connection ? <EnvBadge environment={connection.environment} /> : null}
          {listing ? (
            <>
              <Chip>{formatCount(listing.queuesTotal)} queues</Chip>
              <Chip>{formatCount(listing.exchanges.length)} exchanges</Chip>
            </>
          ) : null}
        </div>
        <div className="broker-toolbar">
          <Button icon={<Plus size={14} />} onClick={() => setDialog('queue')}>
            New queue
          </Button>
          <Button icon={<Plus size={14} />} onClick={() => setDialog('exchange')}>
            New exchange
          </Button>
          <input
            type="search"
            className="broker-filter"
            placeholder="Filter queues"
            aria-label="Filter queues"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
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

      <div className="broker-body broker-body-fill">
        {call.error ? (
          <p className="note-error" role="alert">
            {call.error}
          </p>
        ) : null}
        {call.loading ? <p className="muted">Reading the vhost…</p> : null}

        {listing ? (
          <>
            <section className="broker-section broker-queues">
              <h2>
                Queues{' '}
                <span className="muted">
                  {filter.trim() !== ''
                    ? `${formatCount(rows.length)} of ${formatCount(listing.queues.length)}`
                    : ''}
                </span>
              </h2>
              {listing.queuesTotal > listing.queues.length ? (
                <p className="note-warn-inline">
                  This vhost has {formatCount(listing.queuesTotal)} queues; the first{' '}
                  {formatCount(listing.queues.length)} are listed.
                </p>
              ) : null}
              {listing.queues.length === 0 ? (
                <p className="muted">This vhost has no queues yet.</p>
              ) : (
                <div className="broker-grid" role="table" aria-label="Queues">
                  <div className="broker-qrow broker-qhead" role="row">
                    {COLUMNS.map((column) => (
                      <button
                        key={column.key}
                        type="button"
                        role="columnheader"
                        className={column.numeric ? 'broker-num' : ''}
                        aria-sort={
                          sort.key === column.key
                            ? sort.descending
                              ? 'descending'
                              : 'ascending'
                            : 'none'
                        }
                        onClick={() =>
                          setSort((s) => ({
                            key: column.key,
                            descending:
                              s.key === column.key ? !s.descending : column.numeric === true,
                          }))
                        }
                      >
                        {column.label}
                        {sort.key === column.key ? (
                          sort.descending ? (
                            <ArrowDown size={11} />
                          ) : (
                            <ArrowUp size={11} />
                          )
                        ) : null}
                      </button>
                    ))}
                  </div>
                  <VirtualRows
                    count={rows.length}
                    rowHeight={ROW_HEIGHT}
                    render={(index) => {
                      const queue = rows[index]!
                      return (
                        <div
                          key={queue.name}
                          role="row"
                          tabIndex={0}
                          aria-selected={selected === queue.name}
                          className={`broker-qrow ${selected === queue.name ? 'selected' : ''}`}
                          style={{ height: ROW_HEIGHT }}
                          onClick={() => setSelected(queue.name)}
                          onDoubleClick={() => open(queue.name)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') open(queue.name)
                          }}
                        >
                          <span className="mono broker-name" title={queue.name}>
                            {queue.name}
                          </span>
                          <span>{queue.type}</span>
                          <span>
                            <StateChip state={queue.state} />
                          </span>
                          <span className="broker-num">{formatCount(queue.ready)}</span>
                          <span className="broker-num">{formatCount(queue.unacked)}</span>
                          <span className="broker-num">{formatCount(queue.consumers)}</span>
                          <span className="broker-num muted">{formatRate(queue.rateIn)}</span>
                          <span className="broker-num muted">{formatRate(queue.rateOut)}</span>
                        </div>
                      )
                    }}
                  />
                </div>
              )}
            </section>

            <section className="broker-section">
              <h2>Exchanges</h2>
              <table className="broker-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Durable</th>
                    <th>Internal</th>
                    <th>Policy</th>
                  </tr>
                </thead>
                <tbody>
                  {[...listing.exchanges]
                    .sort(
                      (a, b) =>
                        Number(a.name === '' || a.name.startsWith('amq.')) -
                          Number(b.name === '' || b.name.startsWith('amq.')) ||
                        a.name.localeCompare(b.name),
                    )
                    .map((exchange) => (
                      <tr
                        key={exchange.name}
                        tabIndex={0}
                        className="broker-click"
                        onDoubleClick={() =>
                          workbench.openBroker(connectionId, {
                            view: 'exchange',
                            vhost,
                            name: exchange.name,
                          })
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter')
                            workbench.openBroker(connectionId, {
                              view: 'exchange',
                              vhost,
                              name: exchange.name,
                            })
                        }}
                      >
                        <td className="mono">{exchangeLabel(exchange.name)}</td>
                        <td>{exchange.type}</td>
                        <td>{exchange.durable ? 'yes' : 'no'}</td>
                        <td>{exchange.internal ? 'yes' : ''}</td>
                        <td className="muted">{exchange.policy ?? ''}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </section>
          </>
        ) : null}
      </div>

      {dialog === 'queue' ? (
        <DeclareQueueDialog
          connectionId={connectionId}
          vhost={vhost}
          onClose={() => setDialog(null)}
          onDone={(name) => {
            changed()
            open(name)
          }}
        />
      ) : null}
      {dialog === 'exchange' ? (
        <DeclareExchangeDialog
          connectionId={connectionId}
          vhost={vhost}
          onClose={() => setDialog(null)}
          onDone={(name) => {
            changed()
            workbench.openBroker(connectionId, { view: 'exchange', vhost, name })
          }}
        />
      ) : null}
    </div>
  )
}
