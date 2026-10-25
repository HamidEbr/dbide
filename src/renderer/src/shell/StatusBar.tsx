import { PanelLeft, PanelRight } from 'lucide-react'
import type { CoreState } from '@shared/bridge'
import { ENVIRONMENT_POLICIES, type Environment } from '@shared/environment'
import { EnvBadge, IconButton } from '@/components/ui'
import { commands } from '@/commands/commands'
import { useData } from '@/state/data'

const CORE_LABEL: Record<CoreState, string> = {
  starting: 'Starting core…',
  ready: 'Core ready',
  restarting: 'Core restarted, reconnecting…',
  failed: 'Core stopped',
}

export function StatusBar({ environment }: { environment: Environment | null }) {
  const coreState = useData((state) => state.coreState)
  const info = useData((state) => state.info)
  const settings = useData((state) => state.settings)

  return (
    <footer className="statusbar">
      <div className="status-left">
        <IconButton
          label="Toggle navigator"
          aria-pressed={settings.navigatorOpen}
          onClick={() => void commands.execute('view.toggleNavigator')}
        >
          <PanelLeft size={14} />
        </IconButton>
        {environment ? (
          <>
            <EnvBadge environment={environment} />
            {ENVIRONMENT_POLICIES[environment].readOnlyByDefault ? (
              <span className="status-readonly">Read-only</span>
            ) : null}
          </>
        ) : (
          <span className="muted">No connection selected</span>
        )}
      </div>
      <div className="status-right">
        <span className={`core-state core-${coreState}`} role="status">
          <span className="core-dot" aria-hidden />
          {CORE_LABEL[coreState]}
        </span>
        {info ? <span className="muted">v{info.version}</span> : null}
        <IconButton
          label="Toggle inspector"
          aria-pressed={settings.inspectorOpen}
          onClick={() => void commands.execute('view.toggleInspector')}
        >
          <PanelRight size={14} />
        </IconButton>
      </div>
    </footer>
  )
}
