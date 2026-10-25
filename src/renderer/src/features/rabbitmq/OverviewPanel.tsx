import { coreLink } from '@/ipc/link'
import { formatBytes, formatCount, formatRate, formatUptime } from './format'
import { useServerCall } from '@/lib/useServerCall'
import { Chip, RefreshControls, Stat } from '@/components/panel'
import { useState } from 'react'

/** The broker as a whole: its version, how busy it is, its nodes and what it listens on. */
export function OverviewPanel({ connectionId, active }: { connectionId: string; active: boolean }) {
  const [auto, setAuto] = useState(true)
  const call = useServerCall(
    (signal) => coreLink.call('broker.overview', { connectionId }, { signal }),
    {
      refreshMs: 5000,
      paused: !active || !auto,
    },
  )
  const overview = call.data

  return (
    <section className="broker-overview">
      <div className="broker-overview-head">
        <h2>Broker</h2>
        <span className="spacer" />
        <RefreshControls
          onReload={call.reload}
          auto={auto}
          onAuto={setAuto}
          updatedAt={call.updatedAt}
        />
      </div>
      {call.error ? (
        <p className="note-error" role="alert">
          {call.error}
        </p>
      ) : null}
      {call.loading ? <p className="muted">Reading the broker…</p> : null}
      {overview ? (
        <>
          <p className="broker-versions">
            <Chip>RabbitMQ {overview.version}</Chip>
            {overview.erlangVersion ? <Chip>Erlang {overview.erlangVersion}</Chip> : null}
            {overview.clusterName ? <Chip>{overview.clusterName}</Chip> : null}
            <span className="muted">
              signed in as <span className="mono">{overview.user.name}</span>
              {overview.user.tags.length > 0 ? ` (${overview.user.tags.join(', ')})` : ''}
            </span>
          </p>
          <div className="broker-stats">
            <Stat label="Queues" value={formatCount(overview.totals.queues)} />
            <Stat label="Exchanges" value={formatCount(overview.totals.exchanges)} />
            <Stat label="Connections" value={formatCount(overview.totals.connections)} />
            <Stat label="Channels" value={formatCount(overview.totals.channels)} />
            <Stat label="Consumers" value={formatCount(overview.totals.consumers)} />
            <Stat
              label="Messages"
              value={formatCount(overview.totals.messages)}
              hint={`${formatCount(overview.totals.ready)} ready · ${formatCount(overview.totals.unacked)} unacked`}
            />
            <Stat label="Publish / s" value={formatRate(overview.rates.publish)} />
            <Stat label="Deliver / s" value={formatRate(overview.rates.deliver)} />
          </div>
          {overview.nodes.length > 0 ? (
            <table className="broker-table">
              <thead>
                <tr>
                  <th>Node</th>
                  <th>State</th>
                  <th>Memory</th>
                  <th>Disk free</th>
                  <th>File descriptors</th>
                  <th>Up for</th>
                </tr>
              </thead>
              <tbody>
                {overview.nodes.map((node) => (
                  <tr key={node.name}>
                    <td className="mono">{node.name}</td>
                    <td>
                      {node.running ? <Chip tone="ok">running</Chip> : <Chip tone="bad">down</Chip>}
                    </td>
                    <td>
                      {formatBytes(node.memoryUsed)}
                      {node.memoryLimit ? (
                        <span className="muted"> of {formatBytes(node.memoryLimit)}</span>
                      ) : null}
                    </td>
                    <td>{formatBytes(node.diskFree)}</td>
                    <td>
                      {node.fileDescriptorsUsed ?? '–'}
                      {node.fileDescriptorsTotal ? (
                        <span className="muted"> of {node.fileDescriptorsTotal}</span>
                      ) : null}
                    </td>
                    <td>{formatUptime(node.uptime)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {overview.listeners.length > 0 ? (
            <p className="muted broker-listeners">
              Listening: {overview.listeners.map((l) => `${l.protocol} ${l.port}`).join(' · ')}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
