import { describe, expect, it, vi } from 'vitest'
import { newConnectionDraft } from '@shared/connection'
import { DriverRegistry } from '../drivers/registry'
import { fakeDriver, fakeSession } from '../testing'
import { SessionManager } from './manager'

const config = { ...newConnectionDraft('redis', 'c1'), name: 'Cache' }
const signal = new AbortController().signal

describe('SessionManager', () => {
  it('opens a session once and reuses it', async () => {
    const connect = vi.fn(() => Promise.resolve(fakeSession()))
    const manager = new SessionManager(new DriverRegistry([fakeDriver('redis', connect)]))
    const first = await manager.open('c1', config, {}, signal)
    const second = await manager.open('c1', config, {}, signal)
    expect(second).toBe(first)
    expect(connect).toHaveBeenCalledOnce()
    expect(manager.has('c1')).toBe(true)
  })

  it('shares one attempt between callers that race', async () => {
    const connect = vi.fn(
      () =>
        new Promise<ReturnType<typeof fakeSession>>((resolve) =>
          setTimeout(() => resolve(fakeSession()), 10),
        ),
    )
    const manager = new SessionManager(new DriverRegistry([fakeDriver('redis', connect)]))
    const [a, b] = await Promise.all([
      manager.open('c1', config, {}, signal),
      manager.open('c1', config, {}, signal),
    ])
    expect(a).toBe(b)
    expect(connect).toHaveBeenCalledOnce()
  })

  it('passes the endpoint and secrets to the driver', async () => {
    const connect = vi.fn(() => Promise.resolve(fakeSession()))
    const manager = new SessionManager(new DriverRegistry([fakeDriver('redis', connect)]))
    await manager.open('c1', config, { password: 'pw' }, signal)
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        secrets: { password: 'pw' },
        endpoint: { host: config.host, port: config.port },
      }),
    )
  })

  it('does not cache a failed attempt, so the next one can succeed', async () => {
    const connect = vi
      .fn<() => Promise<ReturnType<typeof fakeSession>>>()
      .mockRejectedValueOnce(new Error('refused'))
      .mockResolvedValueOnce(fakeSession())
    const manager = new SessionManager(new DriverRegistry([fakeDriver('redis', connect)]))
    await expect(manager.open('c1', config, {}, signal)).rejects.toThrow('refused')
    expect(manager.has('c1')).toBe(false)
    await expect(manager.open('c1', config, {}, signal)).resolves.toBeDefined()
  })

  it('throws NOT_CONNECTED for a connection that is not open', () => {
    const manager = new SessionManager(new DriverRegistry([]))
    expect(() => manager.get('nope')).toThrow(expect.objectContaining({ code: 'NOT_CONNECTED' }))
  })

  it('closes the driver session when a connection is closed', async () => {
    const close = vi.fn(() => Promise.resolve())
    const manager = new SessionManager(
      new DriverRegistry([fakeDriver('redis', () => Promise.resolve(fakeSession({ close })))]),
    )
    await manager.open('c1', config, {}, signal)
    await manager.close('c1')
    expect(close).toHaveBeenCalledOnce()
    expect(manager.has('c1')).toBe(false)
  })

  it('closeAll closes everything, even when one close fails', async () => {
    const good = vi.fn(() => Promise.resolve())
    const bad = vi.fn(() => Promise.reject(new Error('stuck')))
    let n = 0
    const manager = new SessionManager(
      new DriverRegistry([
        fakeDriver('redis', () => Promise.resolve(fakeSession({ close: n++ === 0 ? bad : good }))),
      ]),
    )
    await manager.open('a', { ...config, id: 'a' }, {}, signal)
    await manager.open('b', { ...config, id: 'b' }, {}, signal)
    await manager.closeAll()
    expect(bad).toHaveBeenCalledOnce()
    expect(good).toHaveBeenCalledOnce()
    expect(manager.has('a')).toBe(false)
    expect(manager.has('b')).toBe(false)
  })
})
