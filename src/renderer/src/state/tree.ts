import { create } from 'zustand'
import type { TreeNode } from '@shared/driver'
import { RpcError } from '@shared/rpc'
import { coreLink } from '@/ipc/link'

export interface Branch {
  status: 'loading' | 'loaded' | 'error'
  nodes: TreeNode[]
  error?: string
}

/** Identifies a node across connections. A connection's own root uses the bare id. */
export const treeKey = (connectionId: string, node: TreeNode | null): string =>
  node ? `${connectionId}|${node.id}` : connectionId

interface TreeState {
  expanded: Record<string, true>
  branches: Record<string, Branch>
  /** The row with keyboard focus, and the connection new scripts should go to. */
  selected: string | null
  select: (key: string | null) => void
  toggle: (connectionId: string, node: TreeNode | null) => void
  expand: (connectionId: string, node: TreeNode | null) => void
  collapse: (connectionId: string, node: TreeNode | null) => void
  /** Forgets everything loaded for a connection, so the next open starts fresh. */
  reset: (connectionId: string) => void
  /** Reloads one branch. */
  reload: (connectionId: string, node: TreeNode | null) => void
  /**
   * Reloads every branch of a connection that has been loaded, in place: what is open stays open, and what
   * is already shown stays until the new list arrives. For after something changed on the server.
   */
  refresh: (connectionId: string) => void
}

function describe(error: unknown): string {
  if (error instanceof RpcError || error instanceof Error) return error.message
  return String(error)
}

export const useTree = create<TreeState>((set, get) => {
  async function load(connectionId: string, node: TreeNode | null, quiet = false): Promise<void> {
    const key = treeKey(connectionId, node)
    if (!quiet) {
      set((state) => ({ branches: { ...state.branches, [key]: { status: 'loading', nodes: [] } } }))
    }
    try {
      const nodes = await coreLink.call('tree.children', { connectionId, parent: node })
      set((state) => ({ branches: { ...state.branches, [key]: { status: 'loaded', nodes } } }))
    } catch (error) {
      // A quiet reload that fails leaves what was shown; the person did not ask for this one.
      if (quiet) return
      set((state) => ({
        branches: {
          ...state.branches,
          [key]: { status: 'error', nodes: [], error: describe(error) },
        },
      }))
    }
  }

  const expand = (connectionId: string, node: TreeNode | null): void => {
    const key = treeKey(connectionId, node)
    set((state) => ({ expanded: { ...state.expanded, [key]: true } }))
    const branch = get().branches[key]
    if (!branch || branch.status === 'error') void load(connectionId, node)
  }

  const collapse = (connectionId: string, node: TreeNode | null): void => {
    const key = treeKey(connectionId, node)
    set((state) => {
      const { [key]: _closed, ...rest } = state.expanded
      return { expanded: rest }
    })
  }

  return {
    expanded: {},
    branches: {},
    selected: null,

    select: (selected) => set({ selected }),

    expand,
    collapse,

    toggle: (connectionId, node) => {
      if (get().expanded[treeKey(connectionId, node)]) collapse(connectionId, node)
      else expand(connectionId, node)
    },

    reset: (connectionId) =>
      set((state) => {
        const inConnection = (key: string): boolean =>
          key === connectionId || key.startsWith(`${connectionId}|`)
        return {
          expanded: Object.fromEntries(
            Object.entries(state.expanded).filter(([k]) => !inConnection(k)),
          ),
          branches: Object.fromEntries(
            Object.entries(state.branches).filter(([k]) => !inConnection(k)),
          ),
        }
      }),

    reload: (connectionId, node) => void load(connectionId, node),

    refresh: (connectionId) => {
      const inConnection = (key: string): boolean =>
        key === connectionId || key.startsWith(`${connectionId}|`)
      const { branches } = get()
      const nodes = new Map<string, TreeNode>()
      for (const [key, branch] of Object.entries(branches)) {
        if (!inConnection(key)) continue
        for (const node of branch.nodes) nodes.set(treeKey(connectionId, node), node)
      }
      for (const [key, branch] of Object.entries(branches)) {
        if (!inConnection(key) || branch.status !== 'loaded') continue
        const parent = key === connectionId ? null : nodes.get(key)
        if (parent !== undefined) void load(connectionId, parent, true)
      }
    },
  }
})
