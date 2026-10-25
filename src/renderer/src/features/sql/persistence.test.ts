import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotices } from '@/state/notices'
import { useScripts, type Script } from '@/state/scripts'

const calls: { method: string; params: unknown }[] = []
let handler: (method: string, params: unknown) => Promise<unknown>

vi.mock('@/ipc/link', () => ({
  coreLink: {
    call: (method: string, params: unknown) => {
      calls.push({ method, params })
      return handler(method, params)
    },
  },
}))

// Imported after the mock is in place.
const persistence = await import('./persistence')

const script = (overrides: Partial<Script> = {}): Script => ({
  id: 's1',
  name: 'Script',
  language: 'sql',
  connectionId: 'c1',
  database: null,
  text: 'SELECT 1;',
  writable: true,
  run: null,
  saveState: 'saved',
  saveError: null,
  ...overrides,
})

const saves = (): unknown[] => calls.filter((c) => c.method === 'scripts.save').map((c) => c.params)

beforeEach(() => {
  calls.length = 0
  handler = (method) =>
    Promise.resolve(
      method === 'scripts.create'
        ? { name: 'Report' }
        : method === 'scripts.save'
          ? { savedAt: 1, externalChange: false }
          : undefined,
    )
  useNotices.setState({ notices: [] })
  useScripts.setState({ scripts: { s1: script() } })
  persistence.forget('s1')
})

afterEach(() => {
  vi.useRealTimers()
  persistence.forget('s1')
})

describe('saving', () => {
  it('does nothing when the file already holds the text', async () => {
    persistence.trackOpened('s1', 'SELECT 1;')
    await persistence.saveNow('s1')
    expect(calls).toEqual([])
  })

  it('writes changed text and marks the script saved', async () => {
    persistence.trackOpened('s1', 'SELECT 1;')
    useScripts.getState().patch('s1', { text: 'SELECT 2;' })
    await persistence.saveNow('s1')
    expect(saves()).toEqual([{ id: 's1', content: 'SELECT 2;' }])
    expect(useScripts.getState().scripts.s1).toMatchObject({ saveState: 'saved', saveError: null })

    // The same text again is not written twice.
    await persistence.saveNow('s1')
    expect(saves()).toHaveLength(1)
  })

  it('writes unchanged text when asked to keep it in local history', async () => {
    persistence.trackOpened('s1', 'SELECT 1;')
    await persistence.saveNow('s1', { label: 'run' })
    expect(saves()).toEqual([{ id: 's1', content: 'SELECT 1;', label: 'run' }])
  })

  it('saves the text it is given when the script is about to go away', async () => {
    persistence.trackOpened('s1', 'SELECT 1;')
    useScripts.setState({ scripts: {} })
    await persistence.saveNow('s1', { text: 'last words' })
    expect(saves()).toEqual([{ id: 's1', content: 'last words' }])
  })

  it('waits a moment after the last change, then saves once', async () => {
    vi.useFakeTimers()
    persistence.trackOpened('s1', 'SELECT 1;')
    useScripts.getState().patch('s1', { text: 'a' })
    persistence.scheduleSave('s1')
    await vi.advanceTimersByTimeAsync(500)
    persistence.scheduleSave('s1')
    await vi.advanceTimersByTimeAsync(500)
    expect(saves()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(300)
    expect(saves()).toEqual([{ id: 's1', content: 'a' }])
  })

  it('never lets two saves of one script overlap, so an older text can not land last', async () => {
    const order: string[] = []
    let release!: () => void
    handler = (method, params) => {
      if (method !== 'scripts.save') return Promise.resolve(undefined)
      const content = (params as { content: string }).content
      order.push(`start ${content}`)
      const finish = (): Promise<unknown> => {
        order.push(`end ${content}`)
        return Promise.resolve({ savedAt: 1, externalChange: false })
      }
      if (content === 'first') return new Promise((resolve) => (release = () => resolve(finish())))
      return finish()
    }

    persistence.trackOpened('s1', '')
    useScripts.getState().patch('s1', { text: 'first' })
    const one = persistence.saveNow('s1')
    await vi.waitFor(() => expect(order).toContain('start first'))
    // More typing while the first save is still on its way to the disk.
    useScripts.getState().patch('s1', { text: 'second' })
    const two = persistence.saveNow('s1')
    await Promise.resolve()
    expect(order).toEqual(['start first'])
    release()
    await Promise.all([one, two])
    expect(order).toEqual(['start first', 'end first', 'start second', 'end second'])
  })

  it('saves the newest text once, when changes pile up before the save runs', async () => {
    persistence.trackOpened('s1', '')
    useScripts.getState().patch('s1', { text: 'a' })
    const one = persistence.saveNow('s1')
    useScripts.getState().patch('s1', { text: 'ab' })
    const two = persistence.saveNow('s1')
    await Promise.all([one, two])
    expect(saves()).toEqual([{ id: 's1', content: 'ab' }])
  })

  it('reports a failed save on the script and in a notice, and tries again next time', async () => {
    handler = () => Promise.reject(new Error('disk full'))
    persistence.trackOpened('s1', 'SELECT 1;')
    useScripts.getState().patch('s1', { text: 'SELECT 2;' })
    await persistence.saveNow('s1')
    expect(useScripts.getState().scripts.s1).toMatchObject({
      saveState: 'error',
      saveError: 'disk full',
    })
    expect(useNotices.getState().notices[0]?.message).toContain('disk full')

    handler = () => Promise.resolve({ savedAt: 1, externalChange: false })
    await persistence.saveNow('s1')
    expect(useScripts.getState().scripts.s1?.saveState).toBe('saved')
  })

  it('says so when the file was changed outside the app', async () => {
    handler = () => Promise.resolve({ savedAt: 1, externalChange: true })
    persistence.trackOpened('s1', 'SELECT 1;')
    useScripts.getState().patch('s1', { text: 'SELECT 2;', name: 'Report' })
    await persistence.saveNow('s1')
    expect(useNotices.getState().notices[0]?.message).toMatch(/“Report” was changed outside DBIDE/)
  })

  it('writes nothing more for a script that was deleted', async () => {
    persistence.trackOpened('s1', 'SELECT 1;')
    useScripts.getState().patch('s1', { text: 'SELECT 2;' })
    persistence.discard('s1')
    await persistence.saveNow('s1')
    expect(saves()).toEqual([])
  })
})

describe('creating', () => {
  it('creates the file before anything is saved to it, and takes the name it was given', async () => {
    persistence.createInCore('s1', {
      connectionId: 'c1',
      database: 'shop',
      name: 'Report',
      text: 'SELECT 1;',
    })
    useScripts.getState().patch('s1', { text: 'SELECT 2;' })
    await persistence.saveNow('s1')
    expect(calls.map((c) => c.method)).toEqual(['scripts.create', 'scripts.save'])
    expect(calls[0]!.params).toEqual({
      id: 's1',
      connectionId: 'c1',
      database: 'shop',
      content: 'SELECT 1;',
      name: 'Report',
    })
    expect(useScripts.getState().scripts.s1?.name).toBe('Report')
  })

  it('reports a file that could not be created', async () => {
    handler = () => Promise.reject(new Error('read-only folder'))
    persistence.createInCore('s1', { connectionId: 'c1', database: null, text: '' })
    await persistence.settled('s1')
    expect(useScripts.getState().scripts.s1).toMatchObject({ saveState: 'error' })
    expect(useNotices.getState().notices[0]?.message).toContain('read-only folder')
  })
})
