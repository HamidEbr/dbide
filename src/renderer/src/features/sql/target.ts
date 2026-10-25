import { useData } from '@/state/data'
import { useWorkbench } from '@/state/workbench'
import { useTree } from '@/state/tree'

/**
 * The connection a script should use when nothing says which: the one selected in the navigator,
 * else the one the front tab belongs to, else the only connection there is.
 */
export function defaultConnectionId(): string | null {
  const { connections } = useData.getState()
  const selected = useTree.getState().selected?.split('|')[0]
  if (selected && connections.some((c) => c.id === selected)) return selected
  const { tabs, activeId } = useWorkbench.getState()
  const fromTab = tabs.find((t) => t.id === activeId)?.connectionId
  if (fromTab && connections.some((c) => c.id === fromTab)) return fromTab
  return connections.length === 1 ? connections[0]!.id : null
}
