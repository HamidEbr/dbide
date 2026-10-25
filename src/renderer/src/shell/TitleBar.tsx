import { FileCode, FileText, Plus, Settings, X } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { printable } from '@shared/redis/bstring'
import { EngineIcon, IconButton } from '@/components/ui'
import { useData } from '@/state/data'
import { extensionOf } from '@/features/sql/statements'
import { useScripts } from '@/state/scripts'
import { useWorkbench, workbench, type Tab } from '@/state/workbench'

/** A SQL tab is named after its script's file; the connection it runs on is shown beside it. */
function useTabSubtitle(): (tab: Tab) => string | null {
  const connections = useData((state) => state.connections)
  return (tab) =>
    tab.kind === 'sql' || tab.kind === 'broker' || tab.kind === 'redis'
      ? (connections.find((c) => c.id === tab.connectionId)?.name ?? null)
      : null
}

function useTabTitle(): (tab: Tab) => string {
  const connections = useData((state) => state.connections)
  const scripts = useScripts((state) => state.scripts)
  return (tab) => {
    const connection = connections.find((c) => c.id === tab.connectionId)
    switch (tab.kind) {
      case 'welcome':
        return 'Welcome'
      case 'settings':
        return 'Settings'
      case 'connection':
        return connection?.name ?? 'Connection'
      case 'connection-editor':
        return tab.connectionId ? `Edit ${connection?.name ?? 'connection'}` : 'New connection'
      case 'sql':
        return tab.scriptId ? (scripts[tab.scriptId]?.name ?? 'Script') : 'Script'
      case 'redis':
        switch (tab.redis?.view) {
          case 'key':
            return printable(tab.redis.key ?? '')
          case 'console':
            return tab.redis.db < 0 ? 'Console' : `Console db${tab.redis.db}`
          case 'info':
            return 'Server info'
          default:
            return tab.redis?.pattern
              ? `db${tab.redis.db} ${tab.redis.pattern}`
              : `db${tab.redis?.db ?? 0}`
        }
      case 'broker':
        return tab.broker?.view === 'vhost'
          ? `vhost ${tab.broker.vhost}`
          : tab.broker?.name === ''
            ? '(default)'
            : (tab.broker?.name ?? 'Broker')
    }
  }
}

function TabIcon({ tab }: { tab: Tab }) {
  const engine = useData(
    (state) => state.connections.find((c) => c.id === tab.connectionId)?.engine,
  )
  if (engine) return <EngineIcon engine={engine} />
  if (tab.kind === 'sql') return <FileCode size={14} aria-hidden />
  return tab.kind === 'settings' ? (
    <Settings size={14} aria-hidden />
  ) : (
    <FileText size={14} aria-hidden />
  )
}

/** Tabs live in the title bar to save a row of vertical space. The empty part drags the window. */
export function TitleBar() {
  const tabs = useWorkbench((state) => state.tabs)
  const activeId = useWorkbench((state) => state.activeId)
  const activate = useWorkbench((state) => state.activate)
  const closeTab = useWorkbench((state) => state.closeTab)
  const cycle = useWorkbench((state) => state.cycle)
  const scripts = useScripts((state) => state.scripts)
  const titleOf = useTabTitle()
  const subtitleOf = useTabSubtitle()

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowRight') cycle(1)
    else if (event.key === 'ArrowLeft') cycle(-1)
    else return
    event.preventDefault()
  }

  return (
    <header className="titlebar">
      <div className="titlebar-inner">
        <div className="tabs" role="tablist" aria-label="Open tabs" onKeyDown={onKeyDown}>
          {tabs.map((tab) => {
            const active = tab.id === activeId
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                className={`tab ${active ? 'active' : ''}`}
                title={
                  subtitleOf(tab)
                    ? `${titleOf(tab)}${tab.kind === 'sql' && tab.scriptId ? extensionOf(scripts[tab.scriptId]?.language ?? 'sql') : ''} — ${subtitleOf(tab)}`
                    : undefined
                }
                onClick={() => activate(tab.id)}
                onAuxClick={(event) => event.button === 1 && closeTab(tab.id)}
              >
                <TabIcon tab={tab} />
                <span className="tab-title">{titleOf(tab)}</span>
                {active && subtitleOf(tab) ? (
                  <span className="tab-sub">{subtitleOf(tab)}</span>
                ) : null}
                <button
                  type="button"
                  className="tab-close"
                  aria-label={`Close ${titleOf(tab)}`}
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation()
                    closeTab(tab.id)
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            )
          })}
          <IconButton
            label="New connection"
            className="tab-add"
            onClick={() => workbench.newConnection()}
          >
            <Plus size={14} />
          </IconButton>
        </div>
      </div>
    </header>
  )
}
