import { ENVIRONMENT_POLICIES } from '@shared/environment'
import { collectionRef } from '@shared/mongo/documents'
import { dialectOf, selectRows, type SqlDialect } from '@shared/dialect'
import { scriptLanguageOf, type ScriptInfo } from '@shared/scripts'
import { coreLink } from '@/ipc/link'
import { useData } from '@/state/data'
import { notify } from '@/state/notices'
import { useScripts } from '@/state/scripts'
import { useWorkbench, workbench } from '@/state/workbench'
import { createInCore, forget, pullLiveText, saveNow, settled, trackOpened } from './persistence'
import { cancelRun, requestRun } from './runs'
import { statementsOf } from './statements'
import { defaultConnectionId } from './target'

export interface NewScript {
  connectionId: string
  database?: string | null
  text?: string
  /** The file name. Defaults to "Script". */
  name?: string
  /** Run the text as soon as the tab opens. Used to open a table's data. */
  run?: boolean
}

const isWritableByDefault = (connectionId: string): boolean => {
  const connection = useData.getState().connections.find((c) => c.id === connectionId)
  return connection ? !ENVIRONMENT_POLICIES[connection.environment].readOnlyByDefault : false
}

/**
 * Opens a SQL tab on a connection. The tab opens at once; its file is created right behind it.
 * Production connections start read-only.
 */
export function createScript(options: NewScript): string | null {
  const connection = useData.getState().connections.find((c) => c.id === options.connectionId)
  if (!connection) return null
  if (connection.engine === 'rabbitmq') {
    notify('RabbitMQ has no scripts. Open a vhost, a queue or an exchange from the navigator.')
    return null
  }

  const id = crypto.randomUUID()
  const text = options.text ?? ''
  const database = options.database ?? null
  useScripts.getState().add({
    id,
    name: options.name ?? 'Script',
    language: scriptLanguageOf(connection.engine),
    connectionId: connection.id,
    database,
    text,
    writable: isWritableByDefault(connection.id),
    run: null,
    saveState: 'saved',
    saveError: null,
  })
  workbench.openScript(id, connection.id)
  createInCore(id, {
    connectionId: connection.id,
    database,
    text,
    ...(options.name ? { name: options.name } : {}),
  })

  if (options.run) {
    void requestRun(
      id,
      statementsOf(
        scriptLanguageOf(connection.engine),
        text,
        dialectOf(connection.engine) ?? 'mysql',
      ).map((s) => s.text),
    )
  }
  return id
}

/** `SELECT *` from a table with a row limit, quoted safely. */
export function selectAllSql(
  database: string,
  table: string,
  limit = 1000,
  dialect: SqlDialect = 'mysql',
): string {
  return selectRows(dialect, database, table, limit)
}

/** The first documents of a collection, as a script that runs at once. */
export function findAllMongo(collection: string, limit = 100): string {
  return `${collectionRef(collection)}.find({}).limit(${limit})`
}

/**
 * Opens a script that already exists as a file. It runs on the connection it belongs to; a script
 * with none (imported, or its connection was deleted) is given the one the user has selected.
 */
export async function openSavedScript(
  id: string,
  options: { quiet?: boolean } = {},
): Promise<boolean> {
  const existing = useScripts.getState().scripts[id]
  if (existing) {
    workbench.openScript(id, existing.connectionId)
    return true
  }

  // A save that is still on its way would otherwise be read before it lands.
  await settled(id)
  let result
  try {
    result = await coreLink.call('scripts.read', { id })
  } catch (error) {
    notify(
      `Couldn’t open the script. ${error instanceof Error ? error.message : ''}`.trim(),
      'error',
    )
    return false
  }
  const { info, content, recovered } = result

  const { connections } = useData.getState()
  const own = info.connectionId && connections.some((c) => c.id === info.connectionId)
  const connectionId = own ? info.connectionId : options.quiet ? null : defaultConnectionId()
  if (!connectionId) {
    if (!options.quiet) {
      notify(
        `“${info.name}” has no connection. Select one in the navigator, then open the script again.`,
      )
    }
    return false
  }
  if (connectionId !== info.connectionId) {
    void coreLink.call('scripts.update', { id, connectionId }).catch(() => undefined)
  }

  // Another click may have opened it while the file was being read.
  if (useScripts.getState().scripts[id]) {
    workbench.openScript(id, connectionId)
    return true
  }
  trackOpened(id, content)
  useScripts.getState().add({
    id,
    name: info.name,
    language: info.language,
    connectionId,
    database: info.database,
    text: content,
    writable: isWritableByDefault(connectionId),
    run: null,
    saveState: 'saved',
    saveError: null,
  })
  workbench.openScript(id, connectionId)
  if (recovered) notify(`“${info.name}” was missing from its folder. Restored from Local History.`)
  return true
}

let restored = false
let workspaceReady = false

/** Reopens the scripts that had tabs when the app last ran. Once per launch, after connections load. */
export async function restoreWorkspace(): Promise<void> {
  if (restored) return
  restored = true
  try {
    const all: ScriptInfo[] = await coreLink.call('scripts.list', undefined)
    const open = all.filter((s) => s.openOrder !== null).sort((a, b) => a.openOrder! - b.openOrder!)
    for (const info of open) await openSavedScript(info.id, { quiet: true })
    const front = open.find((s) => s.active)
    if (front && useScripts.getState().scripts[front.id]) {
      useWorkbench.getState().activate(`sql:${front.id}`)
    }
  } catch {
    // The scripts are all still in their folder; the library lists them.
  } finally {
    workspaceReady = true
  }
}

/** Closing a tab saves the script, cancels what it was running, and closes its connection. */
async function closeScript(id: string): Promise<void> {
  cancelRun(id)
  // The editor is about to be torn down; take what it holds before it goes.
  const text = pullLiveText(id)
  const save = saveNow(id, text === undefined ? {} : { text })
  useScripts.getState().remove(id)
  void coreLink.call('scripts.close', { scriptId: id }).catch(() => undefined)
  await save
  if (!useScripts.getState().scripts[id]) forget(id)
}

/**
 * Keeps scripts in step with their tabs: closing a tab saves the script and releases the private
 * database connection it held, and the set of open tabs is remembered for the next launch.
 */
export function initScriptLifecycle(): void {
  useWorkbench.subscribe((state, previous) => {
    const open = new Set(state.tabs.map((tab) => tab.scriptId).filter(Boolean))
    for (const tab of previous.tabs) {
      if (!tab.scriptId || open.has(tab.scriptId)) continue
      void closeScript(tab.scriptId)
    }
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  let lastSent = ''
  const sync = (): void => {
    if (!workspaceReady) return
    const { tabs, activeId } = useWorkbench.getState()
    const ids = tabs.flatMap((tab) => (tab.kind === 'sql' && tab.scriptId ? [tab.scriptId] : []))
    const active = tabs.find((tab) => tab.id === activeId)?.scriptId ?? null
    const key = JSON.stringify([ids, active])
    if (key === lastSent) return
    lastSent = key
    void coreLink.call('scripts.setOpen', { ids, active }).catch(() => undefined)
  }
  useWorkbench.subscribe(() => {
    clearTimeout(timer)
    timer = setTimeout(sync, 300)
  })
  window.addEventListener('pagehide', () => {
    clearTimeout(timer)
    sync()
  })
}
