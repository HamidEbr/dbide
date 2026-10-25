import { useEffect } from 'react'
import { commands } from '@/commands/commands'
import { Notices } from '@/components/Notices'
import { CommandPalette } from '@/features/palette/CommandPalette'
import { Inspector } from '@/features/inspector/Inspector'
import { ExportDialog } from '@/features/sql/export/ExportDialog'
import { LocalHistoryDialog } from '@/features/sql/local-history/LocalHistoryDialog'
import { RunGuardDialog } from '@/features/sql/RunGuardDialog'
import { useData } from '@/state/data'
import { useWorkbench } from '@/state/workbench'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'
import { Workbench } from './Workbench'

/** Routes key presses to the command registry, and native-menu clicks too. */
function useCommandInput(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      const command = commands.findByEvent(event, window.dbide.platform)
      if (!command) return
      event.preventDefault()
      // The editor and grid have their own handlers for some of these keys; ours wins.
      event.stopPropagation()
      void command.run()
    }
    window.addEventListener('keydown', onKeyDown, true)
    const offMenu = window.dbide.onCommand((id) => void commands.execute(id))
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      offMenu()
    }
  }, [])
}

export function AppShell() {
  useCommandInput()
  const settings = useData((state) => state.settings)
  const coreState = useData((state) => state.coreState)

  // A production connection tints the whole window, so it is never subtle.
  const environment = useData((state) => {
    const { tabs, activeId } = useWorkbench.getState()
    const connectionId = tabs.find((tab) => tab.id === activeId)?.connectionId
    return state.connections.find((c) => c.id === connectionId)?.environment ?? null
  })
  // Re-evaluate when the active tab changes, since the selector above reads it imperatively.
  useWorkbench((state) => state.activeId)
  // A broker or Redis tab has no cell or document to inspect, so the inspector gives its room back.
  const onBroker = useWorkbench((state) => {
    const kind = state.tabs.find((tab) => tab.id === state.activeId)?.kind
    return kind === 'broker' || kind === 'redis'
  })
  const inspectorOpen = settings.inspectorOpen && !onBroker

  return (
    <div className="app" data-testid="app-shell" data-env={environment ?? 'none'}>
      <TitleBar />
      {coreState === 'restarting' || coreState === 'failed' ? (
        <div className="banner" role="alert">
          {coreState === 'failed'
            ? 'The core process stopped and could not restart. Restart DBIDE to continue.'
            : 'The core process restarted. Reconnecting…'}
        </div>
      ) : null}
      <div className="body" data-navigator={settings.navigatorOpen} data-inspector={inspectorOpen}>
        {settings.navigatorOpen ? <Sidebar /> : null}
        <Workbench />
        {inspectorOpen ? <Inspector /> : null}
      </div>
      <StatusBar environment={environment} />
      <CommandPalette />
      <RunGuardDialog />
      <LocalHistoryDialog />
      <ExportDialog />
      <Notices />
    </div>
  )
}
