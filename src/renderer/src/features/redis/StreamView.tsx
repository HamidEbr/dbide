import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { printable } from '@shared/redis/bstring'
import type { StreamEntry } from '@shared/redis/types'
import { Button, IconButton } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { formatCount } from '@/lib/format'
import { useServerCall } from '@/lib/useServerCall'
import type { Change } from './KeyView'
import type { Elements } from './useElements'

/** A stream: its entries newest first, and its consumer groups with who has what pending. */
export function StreamView({
  elements,
  connectionId,
  keyName,
  db,
  change,
  active,
}: {
  elements: Elements
  connectionId: string
  keyName: string
  db: number
  change: Change
  active: boolean
}) {
  const [pairs, setPairs] = useState<[string, string][]>([['', '']])
  const [id, setId] = useState('')
  const [group, setGroup] = useState<string | null>(null)
  const entries = elements.items as StreamEntry[]

  const info = useServerCall(
    (signal) => coreLink.call('redis.streamInfo', { connectionId, db, key: keyName }, { signal }),
    { refreshMs: 5000, paused: !active },
  )
  const detail = useServerCall(
    (signal) =>
      group === null
        ? Promise.resolve(null)
        : coreLink.call('redis.streamGroup', { connectionId, db, key: keyName, group }, { signal }),
    { refreshMs: 5000, paused: !active || group === null },
  )

  const valid = pairs.every(([f]) => f !== '') && (id === '' || /^\d+(-\d+|-\*)?$/.test(id))
  const addEntry = async (): Promise<void> => {
    if (!valid) return
    const ran = await change(
      { op: 'stream.add', id: id === '' ? null : id, fields: pairs },
      {
        title: 'Add this entry?',
        confirmLabel: 'Add',
        lines: [`Append an entry to the stream ${keyName} in db${db}`],
      },
    )
    if (ran) {
      setPairs([['', '']])
      setId('')
      info.reload()
    }
  }

  return (
    <div className="redis-collection">
      <form
        className="redis-stream-add"
        onSubmit={(event) => {
          event.preventDefault()
          void addEntry()
        }}
      >
        <input
          className="mono redis-stream-id"
          placeholder="ID (blank: next)"
          aria-label="Entry ID"
          value={id}
          onChange={(event) => setId(event.target.value)}
          spellCheck={false}
        />
        {pairs.map(([field, value], i) => (
          <span key={i} className="redis-stream-pair">
            <input
              className="mono"
              placeholder="Field"
              aria-label={`Field ${i + 1}`}
              value={field}
              onChange={(event) =>
                setPairs((p) => p.map((x, j) => (j === i ? [event.target.value, x[1]] : x)))
              }
              spellCheck={false}
            />
            <input
              className="mono"
              placeholder="Value"
              aria-label={`Value ${i + 1}`}
              value={value}
              onChange={(event) =>
                setPairs((p) => p.map((x, j) => (j === i ? [x[0], event.target.value] : x)))
              }
              spellCheck={false}
            />
          </span>
        ))}
        <IconButton label="Another field" onClick={() => setPairs((p) => [...p, ['', '']])}>
          <Plus size={14} />
        </IconButton>
        <Button type="submit" disabled={!valid}>
          Add entry
        </Button>
      </form>

      {elements.error ? (
        <p className="note-error" role="alert">
          {elements.error}
        </p>
      ) : null}

      <table className="broker-table redis-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Fields</th>
            <th className="broker-actions" />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td className="mono">{entry.id}</td>
              <td className="mono redis-cell">
                {entry.fields.map(([f, v], i) => (
                  <span key={i} className="redis-pair">
                    <span className="muted">{printable(f)}</span> {printable(v)}
                  </span>
                ))}
              </td>
              <td className="broker-actions">
                <IconButton
                  label="Delete entry"
                  onClick={() =>
                    void change(
                      { op: 'stream.delete', ids: [entry.id] },
                      {
                        title: 'Delete this entry?',
                        confirmLabel: 'Delete',
                        destructive: true,
                        lines: [`Delete the entry ${entry.id} of ${keyName} in db${db}`],
                      },
                    )
                  }
                >
                  <Trash2 size={12} />
                </IconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="redis-status muted">
        {elements.loading
          ? 'Reading…'
          : `${formatCount(entries.length)} entries loaded, newest first`}
        {elements.hasMore ? (
          <>
            {' · '}
            <Button variant="ghost" disabled={elements.loadingMore} onClick={elements.loadMore}>
              {elements.loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </>
        ) : null}
      </p>

      <section className="broker-section">
        <h2>Consumer groups</h2>
        {info.error ? <p className="muted">{info.error}</p> : null}
        {info.data && info.data.groups.length === 0 ? (
          <p className="muted">This stream has no consumer groups.</p>
        ) : null}
        {info.data && info.data.groups.length > 0 ? (
          <table className="broker-table">
            <thead>
              <tr>
                <th>Group</th>
                <th>Consumers</th>
                <th>Pending</th>
                <th>Last delivered</th>
                <th>Lag</th>
              </tr>
            </thead>
            <tbody>
              {info.data.groups.map((g) => (
                <tr
                  key={g.name}
                  className={`broker-click ${group === g.name ? 'selected' : ''}`}
                  tabIndex={0}
                  onClick={() => setGroup(g.name)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') setGroup(g.name)
                  }}
                >
                  <td className="mono">{g.name}</td>
                  <td>{formatCount(g.consumers)}</td>
                  <td>{formatCount(g.pending)}</td>
                  <td className="mono">{g.lastDeliveredId}</td>
                  <td>{g.lag === null ? '–' : formatCount(g.lag)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {group !== null && detail.data ? (
          <>
            <h3>Consumers of {group}</h3>
            <table className="broker-table">
              <thead>
                <tr>
                  <th>Consumer</th>
                  <th>Pending</th>
                  <th>Idle</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.consumers.map((c) => (
                  <tr key={c.name}>
                    <td className="mono">{c.name}</td>
                    <td>{formatCount(c.pending)}</td>
                    <td>{(c.idleMs / 1000).toFixed(1)} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h3>
              Pending entries{' '}
              <span className="muted">
                {detail.data.pending.length < detail.data.pendingTotal
                  ? `the oldest ${formatCount(detail.data.pending.length)} of ${formatCount(detail.data.pendingTotal)}`
                  : formatCount(detail.data.pendingTotal)}
              </span>
            </h3>
            {detail.data.pending.length === 0 ? (
              <p className="muted">Nothing is waiting to be acknowledged.</p>
            ) : (
              <table className="broker-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Consumer</th>
                    <th>Idle</th>
                    <th>Deliveries</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.pending.map((p) => (
                    <tr key={p.id}>
                      <td className="mono">{p.id}</td>
                      <td className="mono">{p.consumer}</td>
                      <td>{(p.idleMs / 1000).toFixed(1)} s</td>
                      <td>{formatCount(p.deliveries)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : null}
      </section>
    </div>
  )
}
