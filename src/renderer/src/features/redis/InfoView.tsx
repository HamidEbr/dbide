import { useEffect, useState } from 'react'
import type { RedisInfo } from '@shared/redis/types'
import { Chip, RefreshControls, Stat } from '@/components/panel'
import { EnvBadge } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { formatBytes, formatCount, formatUptime, messageOf } from '@/lib/format'
import { useData } from '@/state/data'
import { workbench, type Tab } from '@/state/workbench'
import { Sparkline } from './Sparkline'

interface Sample {
  at: number
  ops: number
  memory: number
  clients: number
}

const SAMPLES = 60
const INTERVAL_MS = 2000

/** Reads the server's INFO every couple of seconds while the view is on screen, and keeps the last minute or two. */
function useInfoStream(connectionId: string, paused: boolean) {
  const [state, setState] = useState<{
    info: RedisInfo | null
    samples: Sample[]
    error: string | null
    at: number | null
  }>({ info: null, samples: [], error: null, at: null })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (paused && tick === 0 && state.at !== null) return
    let stopped = false
    const controller = new AbortController()
    const read = (): void => {
      coreLink
        .call('redis.info', { connectionId }, { signal: controller.signal })
        .then((info) => {
          if (stopped) return
          const sample: Sample = {
            at: Date.now(),
            ops: info.opsPerSec,
            memory: info.usedMemory,
            clients: info.connectedClients,
          }
          setState((s) => ({
            info,
            samples: [...s.samples.slice(-(SAMPLES - 1)), sample],
            error: null,
            at: sample.at,
          }))
        })
        .catch((error: unknown) => {
          if (!stopped) setState((s) => ({ ...s, error: messageOf(error), at: Date.now() }))
        })
    }
    read()
    const timer = paused ? undefined : setInterval(read, INTERVAL_MS)
    return () => {
      stopped = true
      controller.abort()
      if (timer) clearInterval(timer)
    }
    // `state.at` is only read to avoid re-reading a paused view that already has an answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, paused, tick])

  return { ...state, reload: () => setTick((n) => n + 1) }
}

/** The server's own numbers: memory, traffic, clients, hit ratio and every database. */
export function InfoView({ tab, active }: { tab: Tab; active: boolean }) {
  const connectionId = tab.connectionId!
  const connection = useData((state) => state.connections.find((c) => c.id === connectionId))
  const [auto, setAuto] = useState(true)
  const [filter, setFilter] = useState('')
  const { info, samples, error, at, reload } = useInfoStream(connectionId, !active || !auto)

  const totalKeys = info?.keyspace.reduce((n, k) => n + k.keys, 0) ?? 0
  const lookups = (info?.keyspaceHits ?? 0) + (info?.keyspaceMisses ?? 0)
  const hitRatio = lookups === 0 ? null : (info!.keyspaceHits / lookups) * 100
  const needle = filter.trim().toLowerCase()

  return (
    <div className="broker-tab">
      <header className="broker-header">
        <div className="broker-title">
          <h1>Server</h1>
          {connection ? <span className="mono">{connection.name}</span> : null}
          {connection ? <EnvBadge environment={connection.environment} /> : null}
          {info ? (
            <>
              <Chip>
                {info.flavor} {info.version}
              </Chip>
              <Chip>{info.mode}</Chip>
              <Chip tone={info.role === 'master' ? 'ok' : 'warn'}>{info.role}</Chip>
              <Chip>up {formatUptime(info.uptimeSeconds * 1000)}</Chip>
              {info.os ? <span className="muted">{info.os}</span> : null}
            </>
          ) : null}
        </div>
        <div className="broker-toolbar">
          <span className="spacer" />
          <RefreshControls
            onReload={reload}
            auto={auto}
            onAuto={setAuto}
            updatedAt={at}
            every="Every 2 s"
          />
        </div>
      </header>

      <div className="broker-body">
        {error ? (
          <p className="note-error" role="alert">
            {error}
          </p>
        ) : null}
        {info === null && !error ? <p className="muted">Reading the server…</p> : null}

        {info ? (
          <>
            <div className="broker-stats">
              <Stat
                label="Memory used"
                value={formatBytes(info.usedMemory)}
                hint={
                  info.maxMemory > 0
                    ? `${((info.usedMemory / info.maxMemory) * 100).toFixed(0)}% of the ${formatBytes(info.maxMemory)} limit`
                    : 'The server has no memory limit'
                }
              />
              <Stat label="Peak memory" value={formatBytes(info.usedMemoryPeak)} />
              {info.fragmentationRatio !== null ? (
                <Stat
                  label="Fragmentation"
                  value={info.fragmentationRatio.toFixed(2)}
                  hint="Memory the operating system gave the server, divided by memory it uses. Far from 1 means waste."
                />
              ) : null}
              <Stat
                label="Clients"
                value={formatCount(info.connectedClients)}
                hint={`${info.blockedClients} blocked`}
              />
              <Stat label="Commands / s" value={formatCount(info.opsPerSec)} />
              <Stat
                label="Hit ratio"
                value={hitRatio === null ? '–' : `${hitRatio.toFixed(1)}%`}
                hint={`${formatCount(info.keyspaceHits)} hits, ${formatCount(info.keyspaceMisses)} misses since the server started`}
              />
              <Stat label="Keys" value={formatCount(totalKeys)} />
              <Stat
                label="Expired"
                value={formatCount(info.expiredKeys)}
                hint="Keys removed because their TTL ran out"
              />
              <Stat
                label="Evicted"
                value={formatCount(info.evictedKeys)}
                hint="Keys removed to stay under the memory limit"
              />
              <Stat
                label="Net in / out"
                value={`${info.inputKbps.toFixed(1)} / ${info.outputKbps.toFixed(1)} KB/s`}
              />
            </div>

            <section className="broker-section redis-sparks" aria-label="Recent readings">
              <Sparkline
                label="Commands / s"
                values={samples.map((s) => s.ops)}
                format={(v) => formatCount(v)}
              />
              <Sparkline
                label="Memory"
                values={samples.map((s) => s.memory)}
                format={(v) => formatBytes(v)}
              />
              <Sparkline
                label="Clients"
                values={samples.map((s) => s.clients)}
                format={(v) => formatCount(v)}
              />
            </section>

            <section className="broker-section">
              <h2>Databases</h2>
              {info.keyspace.length === 0 ? (
                <p className="muted">Every database is empty.</p>
              ) : (
                <table className="broker-table">
                  <thead>
                    <tr>
                      <th>Database</th>
                      <th>Keys</th>
                      <th>With a TTL</th>
                      <th>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {info.keyspace.map((entry) => (
                      <tr
                        key={entry.db}
                        tabIndex={0}
                        className="broker-click"
                        onDoubleClick={() =>
                          workbench.openRedis(connectionId, { view: 'keys', db: entry.db })
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter')
                            workbench.openRedis(connectionId, { view: 'keys', db: entry.db })
                        }}
                      >
                        <td className="mono">db{entry.db}</td>
                        <td>{formatCount(entry.keys)}</td>
                        <td>{formatCount(entry.expires)}</td>
                        <td>
                          <span
                            className="redis-share"
                            style={{
                              width: `${totalKeys === 0 ? 0 : (entry.keys / totalKeys) * 100}%`,
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {info.replication.role !== 'master' || info.replication.connectedReplicas > 0 ? (
              <section className="broker-section">
                <h2>Replication</h2>
                <p>
                  {info.replication.role === 'master'
                    ? `A primary with ${info.replication.connectedReplicas} connected replica${info.replication.connectedReplicas === 1 ? '' : 's'}.`
                    : `A replica of ${info.replication.masterHost ?? 'another server'}.`}
                </p>
              </section>
            ) : null}

            <section className="broker-section">
              <h2>All fields</h2>
              <input
                type="search"
                className="broker-filter"
                placeholder="Filter fields"
                aria-label="Filter fields"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              {Object.entries(info.sections).map(([section, fields]) => {
                const rows = Object.entries(fields).filter(
                  ([name, value]) =>
                    needle === '' ||
                    name.toLowerCase().includes(needle) ||
                    value.toLowerCase().includes(needle),
                )
                if (rows.length === 0) return null
                return (
                  <details key={section} className="broker-more" open={needle !== ''}>
                    <summary>
                      {section} <span className="muted">{rows.length}</span>
                    </summary>
                    <table className="broker-table">
                      <tbody>
                        {rows.map(([name, value]) => (
                          <tr key={name}>
                            <td className="mono">{name}</td>
                            <td className="mono selectable">{value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )
              })}
            </section>
          </>
        ) : null}
      </div>
    </div>
  )
}
