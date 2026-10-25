import { ENVIRONMENT_POLICIES } from '@shared/environment'
import { coreLink } from '@/ipc/link'
import { useData } from '@/state/data'
import { useLibrary } from '@/state/library'
import { notify } from '@/state/notices'
import { useScripts } from '@/state/scripts'
import { useWorkbench } from '@/state/workbench'
import { discard, settled } from './persistence'
import { openSavedScript } from './scripts'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : '')

/** Renames the script's file. Returns whether it worked, so an editor can stay open on failure. */
export async function renameScript(id: string, name: string): Promise<boolean> {
  try {
    await settled(id)
    const info = await coreLink.call('scripts.rename', { id, name })
    useScripts.getState().patch(id, { name: info.name })
    return true
  } catch (error) {
    notify(messageOf(error) || 'Couldn’t rename the script.', 'error')
    return false
  }
}

export async function duplicateScript(id: string): Promise<void> {
  try {
    await settled(id)
    const copy = await coreLink.call('scripts.duplicate', { id })
    await openSavedScript(copy.id)
  } catch (error) {
    notify(`Couldn’t duplicate the script. ${messageOf(error)}`.trim(), 'error')
  }
}

/** Deletes the file (to the system trash) and closes its tab without saving it back. */
export async function deleteScript(id: string): Promise<void> {
  discard(id)
  const tab = useWorkbench.getState().tabs.find((t) => t.scriptId === id)
  if (tab) useWorkbench.getState().closeTab(tab.id)
  try {
    await coreLink.call('scripts.delete', { id })
    notify('Moved the script to the trash.')
  } catch (error) {
    notify(`Couldn’t delete the script. ${messageOf(error)}`.trim(), 'error')
  }
}

export async function importScripts(): Promise<void> {
  try {
    const { imported, failed } = await coreLink.call('scripts.import', undefined)
    if (imported.length > 0) {
      notify(`Imported ${imported.length} script${imported.length === 1 ? '' : 's'}.`)
      useWorkbench.getState().setSidebar('scripts')
    }
    for (const file of failed) notify(`Couldn’t import ${file.name}. ${file.message}`, 'error')
  } catch (error) {
    notify(`Couldn’t import. ${messageOf(error)}`.trim(), 'error')
  }
}

export function revealScripts(id: string | null): void {
  coreLink.call('scripts.reveal', { id }).catch((error: unknown) => {
    notify(`Couldn’t show it. ${messageOf(error)}`.trim(), 'error')
  })
}

/** Remembers the database choice with the script, so it comes back with it. */
export function setScriptDatabase(id: string, database: string | null): void {
  useScripts.getState().patch(id, { database })
  void settled(id)
    .then(() => coreLink.call('scripts.update', { id, database }))
    .catch(() => undefined)
}

/**
 * Runs the script on another connection. Its old connection is released, the lock starts at the new
 * connection's default, and what the old connection returned is no longer shown.
 */
export async function moveScriptToConnection(id: string, connectionId: string): Promise<void> {
  const script = useScripts.getState().scripts[id]
  const target = useData.getState().connections.find((c) => c.id === connectionId)
  if (!script || !target || script.connectionId === connectionId) return
  try {
    await settled(id)
    await coreLink.call('scripts.update', { id, connectionId, database: null })
    await coreLink.call('scripts.close', { scriptId: id })
  } catch (error) {
    notify(`Couldn’t change the connection. ${messageOf(error)}`.trim(), 'error')
    return
  }
  useScripts.getState().patch(id, {
    connectionId,
    database: null,
    run: null,
    writable: !ENVIRONMENT_POLICIES[target.environment].readOnlyByDefault,
  })
  useWorkbench.getState().retargetScript(id, connectionId)
  void useLibrary.getState().refresh()
}
