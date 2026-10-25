import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newConnectionDraft, type ConnectionConfig, type TestStep } from '@shared/connection'
import { DriverRegistry } from '../drivers/registry'
import { closedPort, fakeDriver, fakeSession, listenLocally } from '../testing'
import { explainNetworkError, testConnection } from './connection-test'

let local: Awaited<ReturnType<typeof listenLocally>>

beforeAll(async () => {
  local = await listenLocally()
})
afterAll(async () => {
  await local.close()
})

const registry = (
  drivers = [fakeDriver('redis', undefined, { implemented: false })],
): DriverRegistry => new DriverRegistry(drivers)

const config = (overrides: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  ...newConnectionDraft('redis', 'c1'),
  name: 'Test',
  host: '127.0.0.1',
  port: local.port,
  ...overrides,
})

const byId = (steps: TestStep[], id: TestStep['id']): TestStep => steps.find((s) => s.id === id)!

describe('testConnection', () => {
  it('reports every step in order, and skips what does not apply', async () => {
    const steps = await testConnection(config(), {}, { drivers: registry() })
    expect(steps.map((s) => s.id)).toEqual(['dns', 'tcp', 'tls', 'auth'])
    expect(byId(steps, 'dns')).toMatchObject({ status: 'skipped' })
    expect(byId(steps, 'tcp')).toMatchObject({ status: 'ok' })
    expect(byId(steps, 'tls')).toMatchObject({
      status: 'skipped',
      detail: expect.stringMatching(/off/i),
    })
    expect(byId(steps, 'auth')).toMatchObject({ status: 'skipped' })
  })

  it('resolves a hostname', async () => {
    const steps = await testConnection(config({ host: 'localhost' }), {}, { drivers: registry() })
    expect(byId(steps, 'dns').status).toBe('ok')
    expect(byId(steps, 'tcp').status).toBe('ok')
  })

  it('names the failing layer and skips the rest when the port is closed', async () => {
    const port = await closedPort()
    const steps = await testConnection(config({ port }), {}, { drivers: registry() })
    expect(byId(steps, 'tcp')).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('refused the connection'),
    })
    expect(byId(steps, 'tls').status).toBe('skipped')
    expect(byId(steps, 'auth').status).toBe('skipped')
  })

  it('fails at DNS for a host that does not exist, or one the resolver does not answer for in time', async () => {
    // Some networks take thirty seconds to say a name does not exist; the step gives up sooner than that.
    const steps = await testConnection(
      config({ host: 'definitely-not-a-real-host.invalid' }),
      {},
      { drivers: registry(), timeoutMs: 1500 },
    )
    expect(byId(steps, 'dns')).toMatchObject({
      status: 'failed',
      detail: expect.stringMatching(/Couldn.t resolve|DNS didn.t answer/),
    })
    expect(byId(steps, 'tcp').status).toBe('skipped')
  })

  it('fails the TLS step when the server does not speak TLS', async () => {
    const steps = await testConnection(
      config({ tls: { enabled: true, allowInvalidCertificates: false } }),
      {},
      { drivers: registry() },
    )
    expect(byId(steps, 'tcp').status).toBe('ok')
    expect(byId(steps, 'tls').status).toBe('failed')
    expect(byId(steps, 'auth').status).toBe('skipped')
  })

  it('leaves TLS to the driver for engines that upgrade inside the protocol', async () => {
    const mysql = fakeDriver('mysql', undefined, {
      displayName: 'MySQL',
      tlsMode: 'upgrade',
      implemented: false,
    })
    const steps = await testConnection(
      { ...config({ engine: 'mysql', tls: { enabled: true, allowInvalidCertificates: false } }) },
      {},
      { drivers: new DriverRegistry([mysql]) },
    )
    expect(byId(steps, 'tls')).toMatchObject({
      status: 'skipped',
      detail: expect.stringContaining('negotiates TLS during login'),
    })
  })

  it('fails clearly while SSH tunnels are not implemented', async () => {
    const steps = await testConnection(
      config({ ssh: { enabled: true, host: 'bastion', port: 22, username: 'me', auth: 'agent' } }),
      {},
      { drivers: registry() },
    )
    expect(steps[0]).toMatchObject({ id: 'ssh', status: 'failed' })
    expect(steps.slice(1).every((s) => s.status === 'skipped')).toBe(true)
  })

  it('logs in through the driver when it is implemented', async () => {
    let received: unknown
    const driver = fakeDriver('redis', (context) => {
      received = context
      return Promise.resolve(fakeSession())
    })
    const steps = await testConnection(
      config(),
      { password: 'hunter2' },
      { drivers: new DriverRegistry([driver]) },
    )
    expect(byId(steps, 'auth')).toMatchObject({ status: 'ok', detail: 'Logged in' })
    expect(received).toMatchObject({
      secrets: { password: 'hunter2' },
      endpoint: { host: '127.0.0.1', port: local.port },
    })
  })

  it('reports a failed login with the driver message', async () => {
    const driver = fakeDriver('redis', () => Promise.reject(new Error('Access denied for user')))
    const steps = await testConnection(config(), {}, { drivers: new DriverRegistry([driver]) })
    expect(byId(steps, 'auth')).toMatchObject({
      status: 'failed',
      detail: 'Access denied for user',
    })
  })

  it('closes the session after pinging it', async () => {
    let closed = false
    const driver = fakeDriver('redis', () =>
      Promise.resolve(
        fakeSession({
          close: () => {
            closed = true
            return Promise.resolve()
          },
        }),
      ),
    )
    await testConnection(config(), {}, { drivers: new DriverRegistry([driver]) })
    expect(closed).toBe(true)
  })

  it('stops waiting when the caller aborts', async () => {
    const controller = new AbortController()
    controller.abort()
    const steps = await testConnection(
      config({ host: 'localhost' }),
      {},
      { drivers: registry(), signal: controller.signal },
    )
    // A cancelled test fails the first network step instead of hanging, and says it was cancelled.
    expect(steps.find((step) => step.status === 'failed')).toMatchObject({
      detail: 'The test was cancelled.',
    })
  })
})

describe('testConnection for an engine that is reached elsewhere than its saved port', () => {
  it('looks where the driver says, and logs in there', async () => {
    const asked: { host: string; port: number }[] = []
    const driver = {
      ...fakeDriver('rabbitmq', (context) => {
        asked.push(context.endpoint)
        return Promise.resolve(fakeSession())
      }),
      // The saved port is the AMQP port, which nothing listens on; the API is on the one that is open.
      testEndpoint: () => ({ host: '127.0.0.1', port: local.port, tls: false }),
    }
    const port = await closedPort()
    const steps = await testConnection(
      { ...config({ port }), engine: 'rabbitmq' },
      {},
      { drivers: registry([driver]) },
    )
    expect(byId(steps, 'tcp')).toMatchObject({
      status: 'ok',
      detail: `Reached 127.0.0.1:${local.port}`,
    })
    expect(byId(steps, 'auth')).toMatchObject({ status: 'ok' })
    expect(asked).toEqual([{ host: '127.0.0.1', port: local.port }])
  })

  it('follows the driver on TLS too: a plain endpoint skips the handshake even when the form says TLS', async () => {
    const driver = {
      ...fakeDriver('rabbitmq'),
      testEndpoint: () => ({ host: '127.0.0.1', port: local.port, tls: false }),
    }
    const steps = await testConnection(
      {
        ...config(),
        engine: 'rabbitmq',
        tls: { enabled: true, allowInvalidCertificates: false },
      },
      {},
      { drivers: registry([driver]) },
    )
    expect(byId(steps, 'tls')).toMatchObject({ status: 'skipped' })
  })
})

describe('explainNetworkError', () => {
  it.each([
    ['ENOTFOUND', /resolve/],
    ['ECONNREFUSED', /refused/],
    ['ETIMEDOUT', /No answer/],
    ['ABORT_TIMEOUT', /No answer/],
    ['ABORTED', /cancelled/],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', /self-signed/],
    ['CERT_HAS_EXPIRED', /expired/],
    ['ERR_TLS_CERT_ALTNAME_INVALID', /isn't valid for/],
    ['ERR_SSL_WRONG_VERSION_NUMBER', /doesn't speak TLS/],
  ])('explains %s', (code, pattern) => {
    expect(explainNetworkError(Object.assign(new Error('raw'), { code }), 'h', 1)).toMatch(pattern)
  })

  it('falls back to the original message', () => {
    expect(explainNetworkError(new Error('something odd'), 'h', 1)).toBe('something odd')
  })
})
