import type { RevisionLabel } from '@shared/scripts'
import { coreLink } from '@/ipc/link'
import { notify } from '@/state/notices'
import { useScripts } from '@/state/scripts'
import { editorFor } from './editor/handles'

/**
 * Keeps every open script's file in step with its editor. Typing saves a moment after the last
 * key; running, restoring a version, and closing a tab save at once. Each script saves one
 * request at a time and in order, so a slow disk can't make an older text overwrite a newer one.
 */

const SAVE_DELAY_MS = 700

interface Tracker {
  timer: ReturnType<typeof setTimeout> | undefined
  /** The last request in flight. The next one waits for it. */
  chain: Promise<unknown>
  /** The text that is in the file, as far as this window knows. */
  saved: string | null
}

const trackers = new Map<string, Tracker>()

function trackerFor(id: string): Tracker {
  let tracker = trackers.get(id)
  if (!tracker) {
    tracker = { timer: undefined, chain: Promise.resolve(), saved: null }
    trackers.set(id, tracker)
  }
  return tracker
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** A script that was read from its file: the file holds exactly this text. */
export function trackOpened(id: string, text: string): void {
  trackerFor(id).saved = text
}

/** Creates the script's file. Saves and reads of the same script wait for it. */
export function createInCore(
  id: string,
  params: { connectionId: string; database: string | null; name?: string; text: string },
): void {
  const tracker = trackerFor(id)
  tracker.saved = params.text
  tracker.chain = tracker.chain.then(async () => {
    try {
      const info = await coreLink.call('scripts.create', {
        id,
        connectionId: params.connectionId,
        database: params.database,
        content: params.text,
        ...(params.name ? { name: params.name } : {}),
      })
      useScripts.getState().patch(id, { name: info.name })
    } catch (error) {
      useScripts.getState().patch(id, { saveState: 'error', saveError: messageOf(error) })
      notify(`Couldn’t create the script file. ${messageOf(error)}`, 'error')
    }
  })
}

/**
 * The editor's text, with what was typed in the last instant. The store trails the editor by a
 * short delay, so anything that is about to leave the screen asks the editor itself.
 */
export function pullLiveText(id: string): string | undefined {
  const live = editorFor(id)?.getText()
  const script = useScripts.getState().scripts[id]
  if (live !== undefined && script && script.text !== live) {
    useScripts.getState().patch(id, { text: live })
  }
  return live ?? script?.text
}

/** Resolves once everything queued for this script has finished. */
export const settled = (id: string): Promise<unknown> => trackerFor(id).chain

/** Saves a moment from now, unless another change comes first. */
export function scheduleSave(id: string): void {
  const tracker = trackerFor(id)
  clearTimeout(tracker.timer)
  tracker.timer = setTimeout(() => void saveNow(id), SAVE_DELAY_MS)
}

export interface SaveOptions {
  /** Keep this exact text in local history. */
  label?: RevisionLabel
  /** Save this text instead of the store's. Used when a tab is closing and the store is about to go. */
  text?: string
}

/** Writes the script's file now. Does nothing when the file already holds the text and no label is wanted. */
export function saveNow(id: string, options: SaveOptions = {}): Promise<void> {
  const tracker = trackerFor(id)
  clearTimeout(tracker.timer)
  tracker.timer = undefined

  const run = async (): Promise<void> => {
    if (discarded.has(id)) return
    const script = useScripts.getState().scripts[id]
    const text = options.text ?? script?.text
    if (text === undefined) return
    if (text === tracker.saved && !options.label) {
      if (script && script.saveState !== 'saved') {
        useScripts.getState().patch(id, { saveState: 'saved', saveError: null })
      }
      return
    }

    useScripts.getState().patch(id, { saveState: 'saving' })
    try {
      const result = await coreLink.call('scripts.save', {
        id,
        content: text,
        ...(options.label ? { label: options.label } : {}),
      })
      tracker.saved = text
      useScripts.getState().patch(id, { saveState: 'saved', saveError: null })
      if (result.externalChange) {
        const name = useScripts.getState().scripts[id]?.name ?? 'This script'
        notify(
          `“${name}” was changed outside DBIDE. The other version is kept in Local History.`,
          'info',
        )
      }
    } catch (error) {
      useScripts.getState().patch(id, { saveState: 'error', saveError: messageOf(error) })
      notify(`Couldn’t save the script. ${messageOf(error)}`, 'error')
    }
  }

  const next = tracker.chain.then(run, run)
  tracker.chain = next
  return next
}

/** Saves every script that has a save waiting. For when the window is about to lose focus or close. */
export function flushPending(): void {
  for (const id of Object.keys(useScripts.getState().scripts)) {
    pullLiveText(id)
    if (trackers.get(id)?.timer !== undefined) void saveNow(id)
  }
}

/** Scripts that were deleted: nothing more is ever written for them. */
const discarded = new Set<string>()

export function forget(id: string): void {
  const tracker = trackers.get(id)
  if (tracker) clearTimeout(tracker.timer)
  trackers.delete(id)
  discarded.delete(id)
}

/** The script is being deleted. Stops any save that would bring its file back. */
export function discard(id: string): void {
  forget(id)
  discarded.add(id)
}

/** Starts saving as scripts change. Call once at startup. */
export function initPersistence(): void {
  useScripts.subscribe((state, previous) => {
    for (const [id, script] of Object.entries(state.scripts)) {
      const before = previous.scripts[id]
      // A script that just appeared holds text that is already in its file.
      if (before && before.text !== script.text) scheduleSave(id)
    }
  })

  // Typing stops when the window loses focus or goes away; don't leave the last words unsaved.
  window.addEventListener('blur', flushPending)
  window.addEventListener('pagehide', flushPending)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPending()
  })
}
