import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/vazirmatn'
import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CoreEvents } from '@shared/api'
import { commands, registerBuiltinCommands } from '@/commands/commands'
import { coreLink } from '@/ipc/link'
import { useDocumentEdits } from '@/features/mongo/edits'
import { cancelRun, initRuns, loadMore } from '@/features/sql/runs'
import { initPersistence, saveNow } from '@/features/sql/persistence'
import {
  createScript,
  initScriptLifecycle,
  openSavedScript,
  restoreWorkspace,
} from '@/features/sql/scripts'
import { useDialogs } from '@/state/dialogs'
import { useEdits } from '@/state/edits'
import { useGuard } from '@/state/guard'
import { useHistory } from '@/state/history'
import { useInspector } from '@/state/inspector'
import { useLibrary } from '@/state/library'
import { useScripts } from '@/state/scripts'
import { useTree } from '@/state/tree'
import { AppShell } from '@/shell/AppShell'
import { useData } from '@/state/data'
import { notify } from '@/state/notices'
import { useWorkbench, workbench } from '@/state/workbench'

const root = document.documentElement
root.dataset.platform = window.dbide.platform
root.dataset.boot = 'loading'

registerBuiltinCommands()
initRuns()
initPersistence()
initScriptLifecycle()

// Settings drive the document: density is a CSS attribute, the theme goes to the main process,
// which flips nativeTheme so `prefers-color-scheme` (and the title-bar overlay) follow.
let appliedTheme: string | null = null
useData.subscribe((state) => {
  root.dataset.density = state.settings.density
  if (state.loaded && state.settings.theme !== appliedTheme) {
    appliedTheme = state.settings.theme
    void window.dbide.setThemeSource(state.settings.theme)
  }
})

window.dbide.onCoreState((state) => useData.getState().setCoreState(state))

coreLink.on(CoreEvents.connectionsChanged, () => void useData.getState().refreshConnections())
coreLink.on(CoreEvents.scriptsChanged, () => void useLibrary.getState().refresh())
coreLink.on(CoreEvents.notice, (payload) =>
  notify((payload as { message: string }).message, 'warn'),
)
coreLink.onConnected(() => {
  useData.getState().setCoreState('ready')
  useData
    .getState()
    .load()
    // Scripts that had tabs when the app last ran come back, once connections are known.
    .then(() => restoreWorkspace())
    .then(() => {
      root.dataset.boot = 'ready'
    })
    .catch((error: unknown) => {
      root.dataset.boot = `error: ${error instanceof Error ? error.message : String(error)}`
    })
})
coreLink.start()

// The smoke test drives the core through the same link the UI uses.
if (window.dbide.smoke) {
  window.__dbide_call = (method, params) => coreLink.call(method, params)
  window.__dbide_ui = {
    createScript,
    cancelRun,
    loadMore,
    useScripts,
    useTree,
    useGuard,
    useEdits,
    useDocumentEdits,
    useInspector,
    useLibrary,
    useHistory,
    useDialogs,
    useWorkbench,
    workbench,
    openSavedScript,
    saveNow,
    commands,
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
)
