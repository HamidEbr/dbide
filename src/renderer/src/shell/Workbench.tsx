import { ConnectionEditor } from '@/features/connections/ConnectionEditor'
import { ConnectionView } from '@/features/connections/ConnectionView'
import { lazy, Suspense } from 'react'
import { SettingsView } from '@/features/settings/SettingsView'
import { Welcome } from '@/features/welcome/Welcome'
import { useWorkbench, type Tab } from '@/state/workbench'

// The editor and grid are the heaviest part of the app; load them when the first script opens.
const SqlTab = lazy(() => import('@/features/sql/SqlTab').then((m) => ({ default: m.SqlTab })))
const BrokerTab = lazy(() =>
  import('@/features/rabbitmq/BrokerTab').then((m) => ({ default: m.BrokerTab })),
)

const RedisTab = lazy(() =>
  import('@/features/redis/RedisTab').then((m) => ({ default: m.RedisTab })),
)

function TabContent({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case 'welcome':
      return <Welcome />
    case 'settings':
      return <SettingsView />
    case 'connection':
      return <ConnectionView tab={tab} />
    case 'connection-editor':
      return <ConnectionEditor tab={tab} />
    case 'sql':
    case 'broker':
    case 'redis':
      return null
  }
}

export function Workbench() {
  const tabs = useWorkbench((state) => state.tabs)
  const activeId = useWorkbench((state) => state.activeId)
  const active = tabs.find((tab) => tab.id === activeId)

  return (
    <main className="workbench" role="tabpanel">
      {/* SQL tabs stay mounted while hidden, so editor history, scroll position, and streaming
          results survive a switch. Other tabs are cheap and mount on demand. */}
      {tabs
        .filter((tab) => tab.kind === 'sql')
        .map((tab) => (
          <div key={tab.id} className="workbench-sql" hidden={tab.id !== activeId}>
            <Suspense fallback={<p className="muted pad">Loading editor…</p>}>
              <SqlTab tab={tab} active={tab.id === activeId} />
            </Suspense>
          </div>
        ))}
      {/* A broker tab keeps what it was showing too, but stops asking the broker while it is hidden. */}
      {tabs
        .filter((tab) => tab.kind === 'broker')
        .map((tab) => (
          <div key={tab.id} className="workbench-broker" hidden={tab.id !== activeId}>
            <Suspense fallback={<p className="muted pad">Loading…</p>}>
              <BrokerTab tab={tab} active={tab.id === activeId} />
            </Suspense>
          </div>
        ))}
      {/* A Redis tab keeps its filters, its console history and what it was editing the same way. */}
      {tabs
        .filter((tab) => tab.kind === 'redis')
        .map((tab) => (
          <div key={tab.id} className="workbench-broker" hidden={tab.id !== activeId}>
            <Suspense fallback={<p className="muted pad">Loading…</p>}>
              <RedisTab tab={tab} active={tab.id === activeId} />
            </Suspense>
          </div>
        ))}
      {/* Keyed by tab id so every tab keeps its own form state while it is open. */}
      {active && active.kind !== 'sql' && active.kind !== 'broker' && active.kind !== 'redis' ? (
        <TabContent key={active.id} tab={active} />
      ) : null}
      {!active ? <Welcome /> : null}
    </main>
  )
}
