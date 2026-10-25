/// <reference types="vite/client" />
import type { DbideApi } from '@shared/bridge'
import type { CoreApi } from '@shared/api'
import type { commands } from '@/commands/commands'
import type { useDocumentEdits } from '@/features/mongo/edits'
import type { saveNow } from '@/features/sql/persistence'
import type { cancelRun, loadMore } from '@/features/sql/runs'
import type { createScript, openSavedScript } from '@/features/sql/scripts'
import type { useDialogs } from '@/state/dialogs'
import type { useEdits } from '@/state/edits'
import type { useGuard } from '@/state/guard'
import type { useHistory } from '@/state/history'
import type { useInspector } from '@/state/inspector'
import type { useLibrary } from '@/state/library'
import type { useScripts } from '@/state/scripts'
import type { useTree } from '@/state/tree'
import type { useWorkbench, workbench } from '@/state/workbench'

declare global {
  interface Window {
    dbide: DbideApi
    /** Only present when the app runs under the smoke test. */
    __dbide_call?: <M extends keyof CoreApi & string>(
      method: M,
      params: CoreApi[M]['params'],
    ) => Promise<CoreApi[M]['result']>
    /** Under the smoke test, what the app last copied, in place of the real clipboard. */
    __dbide_clipboard?: string
    /** Only present under the smoke test: lets it drive the UI the way a user would. */
    __dbide_ui?: {
      createScript: typeof createScript
      cancelRun: typeof cancelRun
      loadMore: typeof loadMore
      useScripts: typeof useScripts
      useTree: typeof useTree
      useGuard: typeof useGuard
      useEdits: typeof useEdits
      useDocumentEdits: typeof useDocumentEdits
      useInspector: typeof useInspector
      useLibrary: typeof useLibrary
      useHistory: typeof useHistory
      useDialogs: typeof useDialogs
      useWorkbench: typeof useWorkbench
      workbench: typeof workbench
      openSavedScript: typeof openSavedScript
      saveNow: typeof saveNow
      commands: typeof commands
    }
  }
}
