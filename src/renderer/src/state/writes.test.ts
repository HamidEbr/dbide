import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionSummary } from '@shared/connection'
import type { Environment } from '@shared/environment'
import { useData } from '@/state/data'
import { useGuard } from '@/state/guard'
import { useNotices } from '@/state/notices'
import { changeData, setWritable, useWriteLocks } from './writes'

const connection = (id: string, environment: Environment): ConnectionSummary => ({
  id,
  name: `Broker ${id}`,
  engine: 'rabbitmq',
  environment,
  host: 'h',
  port: 5672,
})

beforeEach(() => {
  useData.setState({
    connections: [
      connection('local', 'local'),
      connection('dev', 'dev'),
      connection('staging', 'staging'),
      connection('prod', 'prod'),
    ],
  })
  useWriteLocks.setState({ unlocked: {} })
  useGuard.setState({ request: null })
  useNotices.setState({ notices: [] })
})

const request = (connectionId: string, extra: Partial<Parameters<typeof changeData>[0]> = {}) => {
  const run = vi.fn(() => Promise.resolve())
  return {
    run,
    start: () =>
      changeData({
        connectionId,
        title: 'Do it?',
        confirmLabel: 'Do it',
        lines: ['Do the thing'],
        run,
        ...extra,
      }),
  }
}

const messages = (): string[] => useNotices.getState().notices.map((n) => n.message)

describe('changeData', () => {
  it('runs a change at once on a connection that is not guarded', async () => {
    for (const id of ['local', 'dev']) {
      const { run, start } = request(id, { done: 'Done.' })
      expect(await start()).toBe(true)
      expect(run).toHaveBeenCalledOnce()
      expect(useGuard.getState().request).toBeNull()
    }
    expect(messages()).toEqual(['Done.', 'Done.'])
  })

  it('does nothing while a connection is locked, and says how to go on', async () => {
    const { run, start } = request('prod')
    expect(await start()).toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect(messages()[0]).toMatch(/locked.*Unlock writes/)
    // A person can lock any connection.
    useWriteLocks.getState().set('dev', false)
    const again = request('dev')
    expect(await again.start()).toBe(false)
    expect(again.run).not.toHaveBeenCalled()
  })

  it('asks first on production, and runs only when the person says yes', async () => {
    useWriteLocks.getState().set('prod', true)
    const { run, start } = request('prod', { reasons: ['It matters.'] })
    const pending = start()
    await vi.waitFor(() => expect(useGuard.getState().request).not.toBeNull())
    expect(useGuard.getState().request).toMatchObject({
      title: 'Do it?',
      confirmLabel: 'Do it',
      plain: true,
      statements: ['Do the thing'],
      reasons: ['It matters.'],
      typedName: false,
      connectionName: 'Broker prod',
      environment: 'prod',
    })
    expect(run).not.toHaveBeenCalled()
    useGuard.getState().answer(true)
    expect(await pending).toBe(true)
    expect(run).toHaveBeenCalledOnce()

    const declined = request('prod')
    const second = declined.start()
    await vi.waitFor(() => expect(useGuard.getState().request).not.toBeNull())
    useGuard.getState().answer(false)
    expect(await second).toBe(false)
    expect(declined.run).not.toHaveBeenCalled()
  })

  it('asks for the connection’s name before a destructive change on a guarded environment', async () => {
    useWriteLocks.getState().set('prod', true)
    const prod = request('prod', { destructive: true })
    const first = prod.start()
    await vi.waitFor(() => expect(useGuard.getState().request?.typedName).toBe(true))
    useGuard.getState().answer(true)
    await first

    const staging = request('staging', { destructive: true })
    const second = staging.start()
    await vi.waitFor(() => expect(useGuard.getState().request?.typedName).toBe(true))
    useGuard.getState().answer(false)
    expect(await second).toBe(false)
    expect(staging.run).not.toHaveBeenCalled()

    // Staging only asks about what destroys; an ordinary change goes straight through.
    const plain = request('staging')
    expect(await plain.start()).toBe(true)
    expect(useGuard.getState().request).toBeNull()
  })

  it('reports a failure as a notice and says it did not run', async () => {
    const run = vi.fn(() => Promise.reject(new Error('The broker said no.')))
    const ran = await changeData({
      connectionId: 'dev',
      title: 't',
      confirmLabel: 'c',
      lines: [],
      run,
      done: 'Done.',
    })
    expect(ran).toBe(false)
    expect(messages()).toEqual(['The broker said no.'])
  })

  it('ignores a connection that no longer exists', async () => {
    const { run, start } = request('gone')
    expect(await start()).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('setWritable', () => {
  it('unlocks a development connection without asking, and locks it again', async () => {
    await setWritable('dev', false)
    expect(useWriteLocks.getState().unlocked.dev).toBe(false)
    await setWritable('dev', true)
    expect(useWriteLocks.getState().unlocked.dev).toBe(true)
    expect(useGuard.getState().request).toBeNull()
  })

  it('asks before unlocking a production connection, and stays locked on no', async () => {
    const pending = setWritable('prod', true)
    await vi.waitFor(() => expect(useGuard.getState().request).not.toBeNull())
    expect(useGuard.getState().request).toMatchObject({ action: 'unlock', typedName: false })
    useGuard.getState().answer(false)
    await pending
    expect(useWriteLocks.getState().unlocked.prod).toBeUndefined()

    const again = setWritable('prod', true)
    await vi.waitFor(() => expect(useGuard.getState().request).not.toBeNull())
    useGuard.getState().answer(true)
    await again
    expect(useWriteLocks.getState().unlocked.prod).toBe(true)
    await setWritable('prod', false)
    expect(useWriteLocks.getState().unlocked.prod).toBe(false)
  })
})
