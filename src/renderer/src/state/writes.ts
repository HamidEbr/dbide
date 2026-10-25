import { create } from 'zustand'
import type { EngineKind } from '@shared/connection'
import { ENVIRONMENT_POLICIES } from '@shared/environment'
import { useData } from '@/state/data'
import { useGuard } from '@/state/guard'
import { notify } from '@/state/notices'
import { useTree } from '@/state/tree'
import { messageOf } from '@/lib/format'

/**
 * Whether a connection's changes (publish, purge, edit keys, delete) are unlocked. It belongs to the connection,
 * not to a tab, so unlocking a production server once covers every tab on it, and closing the app locks it again.
 */
interface LockState {
  unlocked: Record<string, boolean>
  set: (connectionId: string, unlocked: boolean) => void
}

export const useWriteLocks = create<LockState>((set) => ({
  unlocked: {},
  set: (connectionId, unlocked) =>
    set((state) => ({ unlocked: { ...state.unlocked, [connectionId]: unlocked } })),
}))

/** Production starts locked; the other environments don't. */
export function useWritable(connectionId: string): boolean {
  const environment = useData(
    (state) => state.connections.find((c) => c.id === connectionId)?.environment,
  )
  const override = useWriteLocks((state) => state.unlocked[connectionId])
  if (override !== undefined) return override
  return environment ? !ENVIRONMENT_POLICIES[environment].readOnlyByDefault : false
}

/** Whether a connection's changes are unlocked right now, for code that is not a component. */
export const isWritable = (connectionId: string): boolean => {
  const override = useWriteLocks.getState().unlocked[connectionId]
  if (override !== undefined) return override
  const connection = useData.getState().connections.find((c) => c.id === connectionId)
  return connection ? !ENVIRONMENT_POLICIES[connection.environment].readOnlyByDefault : false
}

/** Unlocks (asking first on a connection that starts locked) or locks a connection's changes. */
export async function setWritable(connectionId: string, writable: boolean): Promise<void> {
  const connection = useData.getState().connections.find((c) => c.id === connectionId)
  if (!connection || isWritable(connectionId) === writable) return
  if (writable && ENVIRONMENT_POLICIES[connection.environment].readOnlyByDefault) {
    const confirmed = await useGuard.getState().ask({
      action: 'unlock',
      connectionName: connection.name,
      environment: connection.environment,
      statements: [],
      reasons: [
        `${connection.name} is a ${ENVIRONMENT_POLICIES[connection.environment].label.toLowerCase()} connection. Unlocking lets you ${UNLOCK_ALLOWS[connection.engine]}.`,
      ],
      typedName: false,
    })
    if (!confirmed) return
  }
  useWriteLocks.getState().set(connectionId, writable)
}

/** What unlocking a connection of each engine lets a person do, said in the question that asks first. */
const UNLOCK_ALLOWS: Record<EngineKind, string> = {
  mysql: 'change rows and the schema',
  mongodb: 'change documents and collections',
  redis: 'edit, rename and delete keys, and run commands that change data',
  rabbitmq: 'publish, purge, create and delete on this broker',
}

export interface DataWrite {
  connectionId: string
  /** The question, such as “Purge the queue?”. */
  title: string
  /** What will happen, one line each. */
  lines: string[]
  /** Why it matters, shown above the lines. */
  reasons?: string[]
  confirmLabel: string
  /** The person has to type the connection's name on a guarded environment. */
  destructive?: boolean
  /** Said when it worked. */
  done?: string
  /** The navigator lists what a change may add, rename or remove; set this to false for a change it can't show. */
  refreshTree?: boolean
  run: (writable: true) => Promise<unknown>
}

/**
 * Does something that changes the broker, after the checks the connection's environment asks for: nothing
 * runs while writes are locked, a production broker asks first, and a destructive change on a guarded one
 * asks for the connection's name. Returns whether it ran.
 */
export async function changeData(request: DataWrite): Promise<boolean> {
  const connection = useData.getState().connections.find((c) => c.id === request.connectionId)
  if (!connection) return false
  if (!isWritable(request.connectionId)) {
    notify('Changes are locked on this connection. Unlock writes in the toolbar first.')
    return false
  }
  const policy = ENVIRONMENT_POLICIES[connection.environment]
  const destructive = request.destructive === true
  const typedName = destructive && policy.confirmDestructive
  if (policy.confirmBeforeExecute || typedName) {
    const confirmed = await useGuard.getState().ask({
      title: request.title,
      confirmLabel: request.confirmLabel,
      plain: true,
      connectionName: connection.name,
      environment: connection.environment,
      statements: request.lines,
      reasons: request.reasons ?? [`This is a ${policy.label.toLowerCase()} connection.`],
      typedName,
    })
    if (!confirmed) return false
  }
  try {
    await request.run(true)
  } catch (error) {
    notify(messageOf(error), 'error')
    return false
  }
  // The navigator lists what was changed (queues, exchanges, keys); what it shows is out of date now.
  if (request.refreshTree !== false) useTree.getState().refresh(request.connectionId)
  if (request.done) notify(request.done)
  return true
}
