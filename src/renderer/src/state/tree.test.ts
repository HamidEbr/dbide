import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TreeNode } from '@shared/driver'

const answers = new Map<string, TreeNode[] | Error>()
const asked: string[] = []

vi.mock('@/ipc/link', () => ({
  coreLink: {
    call: (_method: string, params: { connectionId: string; parent: TreeNode | null }) => {
      const key = `${params.connectionId}|${params.parent?.id ?? ''}`
      asked.push(key)
      const answer = answers.get(key)
      if (answer instanceof Error) return Promise.reject(answer)
      return Promise.resolve(answer ?? [])
    },
  },
}))

const { treeKey, useTree } = await import('./tree')

const node = (id: string, hasChildren = true): TreeNode => ({
  id,
  label: id,
  kind: 'queue',
  hasChildren,
})

beforeEach(() => {
  answers.clear()
  asked.length = 0
  useTree.setState({ expanded: {}, branches: {}, selected: null })
})

describe('refresh', () => {
  it('reloads every loaded branch of one connection, and leaves the others and what is open alone', async () => {
    const vhost = node('vhost')
    const queues = node('queues')
    answers.set('c1|', [vhost])
    answers.set('c1|vhost', [queues])
    answers.set('c1|queues', [node('a'), node('b')])
    answers.set('c2|', [node('other')])

    const tree = useTree.getState()
    tree.expand('c1', null)
    await vi.waitFor(() => expect(useTree.getState().branches.c1?.status).toBe('loaded'))
    tree.expand('c1', vhost)
    await vi.waitFor(() =>
      expect(useTree.getState().branches[treeKey('c1', vhost)]?.status).toBe('loaded'),
    )
    tree.expand('c1', queues)
    await vi.waitFor(() =>
      expect(useTree.getState().branches[treeKey('c1', queues)]?.status).toBe('loaded'),
    )
    tree.expand('c2', null)
    await vi.waitFor(() => expect(useTree.getState().branches.c2?.status).toBe('loaded'))

    // A queue is added on the server, and one is gone.
    answers.set('c1|queues', [node('a'), node('c')])
    asked.length = 0
    useTree.getState().refresh('c1')
    await vi.waitFor(() =>
      expect(useTree.getState().branches[treeKey('c1', queues)]?.nodes.map((n) => n.id)).toEqual([
        'a',
        'c',
      ]),
    )
    expect(asked.sort()).toEqual(['c1|', 'c1|queues', 'c1|vhost'])
    expect(Object.keys(useTree.getState().expanded).sort()).toEqual([
      'c1',
      'c1|queues',
      'c1|vhost',
      'c2',
    ])
  })

  it('keeps showing what was there while the new list is on its way, and when it fails', async () => {
    answers.set('c1|', [node('x')])
    useTree.getState().expand('c1', null)
    await vi.waitFor(() => expect(useTree.getState().branches.c1?.status).toBe('loaded'))

    answers.set('c1|', new Error('the broker went away'))
    useTree.getState().refresh('c1')
    await vi.waitFor(() => expect(asked.length).toBe(2))
    expect(useTree.getState().branches.c1).toMatchObject({ status: 'loaded', nodes: [{ id: 'x' }] })
  })

  it('does not load a branch that was never opened', () => {
    useTree.getState().refresh('c1')
    expect(asked).toEqual([])
  })
})
