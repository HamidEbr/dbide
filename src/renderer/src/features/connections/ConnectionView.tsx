import { Activity, FileCode, Pencil, Plug, Search, Terminal } from 'lucide-react'
import { useState } from 'react'
import type { TestStep } from '@shared/connection'
import { ENVIRONMENT_POLICIES } from '@shared/environment'
import { RpcError } from '@shared/rpc'
import { Button, EngineIcon, EnvBadge } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { createScript } from '@/features/sql/scripts'
import { useData } from '@/state/data'
import { workbench, type Tab } from '@/state/workbench'
import { OverviewPanel } from '@/features/rabbitmq/OverviewPanel'
import { ServerOverview } from '@/features/redis/ServerOverview'
import { TestResults } from './TestResults'

/**
 * What opens when you pick a saved connection. Browsing and querying arrive with each engine's
 * driver; until then this page shows what the connection is and lets you verify it.
 */
export function ConnectionView({ tab }: { tab: Tab }) {
  const summary = useData((state) => state.connections.find((c) => c.id === tab.connectionId))
  const descriptor = useData((state) => state.engines.find((d) => d.engine === summary?.engine))
  const [steps, setSteps] = useState<TestStep[] | null>(null)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!summary || !tab.connectionId) {
    return (
      <div className="view">
        <p className="muted">This connection no longer exists.</p>
      </div>
    )
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setError(null)
    try {
      const stored = await coreLink.call('connections.get', { id: summary.id })
      if (!stored) throw new Error('This connection no longer exists.')
      setSteps(await coreLink.call('connections.test', { config: stored.config }))
    } catch (cause) {
      setError(cause instanceof RpcError || cause instanceof Error ? cause.message : String(cause))
    } finally {
      setTesting(false)
    }
  }

  const policy = ENVIRONMENT_POLICIES[summary.environment]

  return (
    <div className="view">
      <header className="view-header">
        <EngineIcon engine={summary.engine} size={20} />
        <h1>{summary.name}</h1>
        <EnvBadge environment={summary.environment} />
        <span className="spacer" />
        {descriptor?.implemented && summary.engine === 'redis' ? (
          <>
            <Button
              variant="primary"
              icon={<Search size={14} />}
              onClick={() => workbench.openRedis(summary.id, { view: 'keys', db: 0 })}
            >
              Browse keys
            </Button>
            <Button
              icon={<Terminal size={14} />}
              onClick={() => workbench.openRedis(summary.id, { view: 'console', db: -1 })}
            >
              Console
            </Button>
            <Button
              icon={<Activity size={14} />}
              onClick={() => workbench.openRedis(summary.id, { view: 'info', db: 0 })}
            >
              Server info
            </Button>
          </>
        ) : null}
        {descriptor?.implemented && summary.engine !== 'rabbitmq' && summary.engine !== 'redis' ? (
          <Button
            variant="primary"
            icon={<FileCode size={14} />}
            onClick={() => createScript({ connectionId: summary.id })}
          >
            {summary.engine === 'mongodb' ? 'New MongoDB script' : 'New SQL script'}
          </Button>
        ) : null}
        <Button icon={<Pencil size={14} />} onClick={() => workbench.editConnection(summary.id)}>
          Edit
        </Button>
        <Button icon={<Plug size={14} />} onClick={() => void test()} disabled={testing}>
          Test connection
        </Button>
      </header>

      <dl className="facts">
        <dt>Server</dt>
        <dd className="mono selectable">
          {summary.host}:{summary.port}
        </dd>
        <dt>Engine</dt>
        <dd>{descriptor?.displayName ?? summary.engine}</dd>
        <dt>Safeguards</dt>
        <dd>
          {[
            policy.readOnlyByDefault ? 'Read-only by default' : null,
            policy.confirmDestructive ? 'Confirms destructive actions' : null,
          ]
            .filter(Boolean)
            .join(' · ') || 'None'}
        </dd>
      </dl>

      {summary.engine === 'rabbitmq' && descriptor?.implemented ? (
        <>
          <OverviewPanel connectionId={summary.id} active />
          <p className="muted broker-hint">
            Open a vhost, queue or exchange from the navigator to look inside it.
          </p>
        </>
      ) : null}

      {summary.engine === 'redis' && descriptor?.implemented ? (
        <>
          <ServerOverview connectionId={summary.id} active />
          <p className="muted broker-hint">
            Open a database or a key from the navigator, or browse the keys here. A key opens in a
            tab where its value can be edited.
          </p>
        </>
      ) : null}

      {descriptor && !descriptor.implemented ? (
        <div className="empty-state">
          <h2>Browsing arrives with the {descriptor.displayName} driver</h2>
          <p>
            Your connection is saved. Once the driver lands you can open it here to browse and
            query. For now you can test that the server is reachable.
          </p>
        </div>
      ) : null}

      <TestResults steps={steps} testing={testing} />
      {error ? (
        <p className="note-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
