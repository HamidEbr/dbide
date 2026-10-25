import { ENVIRONMENT_POLICIES } from '@shared/environment'
import { coreLink } from '@/ipc/link'
import { useData } from '@/state/data'
import { useGuard } from '@/state/guard'
import { notify } from '@/state/notices'
import { useScripts } from '@/state/scripts'
import { useWorkbench } from '@/state/workbench'
import { editorFor } from './editor/handles'
import { cancelRun, isBusy, requestRun } from './runs'

/** The script of the SQL tab the user is looking at, if any. */
export function activeScriptId(): string | null {
  const { tabs, activeId } = useWorkbench.getState()
  return tabs.find((tab) => tab.id === activeId && tab.kind === 'sql')?.scriptId ?? null
}

export function runFromEditor(scriptId: string, mode: 'cursor' | 'all'): void {
  if (isBusy(useScripts.getState().scripts[scriptId]?.run ?? null)) {
    notify('Something is already running here. Cancel it first.')
    return
  }
  const statements = editorFor(scriptId)?.statements(mode) ?? []
  if (statements.length === 0) {
    notify('Nothing to run. Write a statement first.')
    return
  }
  void requestRun(scriptId, statements)
}

export function cancelFromEditor(scriptId: string): void {
  if (isBusy(useScripts.getState().scripts[scriptId]?.run ?? null)) cancelRun(scriptId)
}

/**
 * Switches a script between read-only and writable. Unlocking a connection that starts locked
 * (production) asks first, so one stray click can't open it up.
 */
export async function setWritable(scriptId: string, writable: boolean): Promise<void> {
  const script = useScripts.getState().scripts[scriptId]
  const connection = useData.getState().connections.find((c) => c.id === script?.connectionId)
  if (!script || !connection || script.writable === writable) return

  if (writable && ENVIRONMENT_POLICIES[connection.environment].readOnlyByDefault) {
    const confirmed = await useGuard.getState().ask({
      action: 'unlock',
      connectionName: connection.name,
      environment: connection.environment,
      statements: [],
      reasons: [
        `${connection.name} is a ${ENVIRONMENT_POLICIES[connection.environment].label.toLowerCase()} connection. Unlocking lets this script change its data.`,
      ],
      typedName: false,
    })
    if (!confirmed) return
  }

  // The server session must agree before the UI says writes are allowed, or the first save
  // after unlocking would still be refused.
  try {
    await coreLink.call('scripts.setReadOnly', { scriptId, readOnly: !writable })
  } catch (error) {
    notify(
      `Couldn’t change the lock. ${error instanceof Error ? error.message : ''}`.trim(),
      'error',
    )
    return
  }
  useScripts.getState().patch(scriptId, { writable })
}
