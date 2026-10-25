import { Database, FileCode, History, type LucideIcon } from 'lucide-react'
import { HistoryPanel } from '@/features/history/HistoryPanel'
import { ScriptsPanel } from '@/features/scripts/ScriptsPanel'
import { useWorkbench, type SidebarView } from '@/state/workbench'
import { Navigator } from './Navigator'

const VIEWS: { id: SidebarView; label: string; icon: LucideIcon }[] = [
  { id: 'connections', label: 'Connections', icon: Database },
  { id: 'scripts', label: 'Scripts', icon: FileCode },
  { id: 'history', label: 'History', icon: History },
]

/** The left side: connections, the script library, and the query history, one at a time. */
export function Sidebar() {
  const view = useWorkbench((state) => state.sidebar)
  const setSidebar = useWorkbench((state) => state.setSidebar)

  return (
    <aside className="navigator" aria-label="Sidebar">
      <div className="sidebar-tabs" role="tablist" aria-label="Sidebar view">
        {VIEWS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`sidebar-tab-${id}`}
            aria-selected={view === id}
            aria-controls="sidebar-panel"
            className={`sidebar-tab ${view === id ? 'active' : ''}`}
            title={label}
            onClick={() => setSidebar(id)}
          >
            <Icon size={14} aria-hidden />
            <span className="sidebar-tab-label">{label}</span>
          </button>
        ))}
      </div>
      <div
        className="side-view"
        id="sidebar-panel"
        role="tabpanel"
        aria-labelledby={`sidebar-tab-${view}`}
      >
        {view === 'connections' ? (
          <Navigator />
        ) : view === 'scripts' ? (
          <ScriptsPanel />
        ) : (
          <HistoryPanel />
        )}
      </div>
    </aside>
  )
}
