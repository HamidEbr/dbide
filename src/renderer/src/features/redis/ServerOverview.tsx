import { coreLink } from '@/ipc/link'
import { formatBytes, formatCount, formatUptime } from '@/lib/format'
import { useServerCall } from '@/lib/useServerCall'
import { Chip, RefreshControls, Stat } from '@/components/panel'
import { useState } from 'react'

/** The server on a connection's own tab: its version, how full it is, and how busy. */
export function ServerOverview({
  connectionId,
  active,
}: {
  connectionId: string
  active: boolean
}) {
  const [auto, setAuto] = useState(true)
  const call = useServerCall(
    (signal) => coreLink.call('redis.info', { connectionId }, { signal }),
    { refreshMs: 5000, paused: !active || !auto },
  )
  const info = call.data
  const keys = info?.keyspace.reduce((n, k) => n + k.keys, 0) ?? 0

  return (
    <section className="broker-overview">
      <div className="broker-overview-head">
        <h2>Server</h2>
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
      {call.loading ? <p className="muted">Reading the server…</p> : null}
      {info ? (
        <>
          <p className="broker-versions">
            <Chip>
              {info.flavor} {info.version}
            </Chip>
            <Chip>{info.mode}</Chip>
            <Chip tone={info.role === 'master' ? 'ok' : 'warn'}>{info.role}</Chip>
            <span className="muted">up {formatUptime(info.uptimeSeconds * 1000)}</span>
          </p>
          <div className="broker-stats">
            <Stat label="Keys" value={formatCount(keys)} />
            <Stat label="Memory" value={formatBytes(info.usedMemory)} />
            <Stat label="Clients" value={formatCount(info.connectedClients)} />
            <Stat label="Commands / s" value={formatCount(info.opsPerSec)} />
          </div>
        </>
      ) : null}
    </section>
  )
}
