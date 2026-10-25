import { describe, expect, it, vi } from 'vitest'
import { createRpcClient, createRpcServer, RpcError, type PortLike, type RpcHandlers } from './rpc'

interface TestApi {
  echo: { params: { text: string }; result: string }
  fail: { params: void; result: void }
  explode: { params: void; result: void }
  slow: { params: void; result: string }
}

/** Two linked in-memory ports that behave like a MessageChannel. */
function createPortPair(): [PortLike, PortLike] {
  const sides: {
    message?: (data: unknown) => void
    close?: () => void
  }[] = [{}, {}]
  const make = (self: number, other: number): PortLike => ({
    postMessage: (message) => {
      queueMicrotask(() => sides[other]!.message?.(structuredClone(message)))
    },
    onMessage: (handler) => {
      sides[self]!.message = handler
    },
    onClose: (handler) => {
      sides[self]!.close = handler
    },
    close: () => {
      sides[self]!.close?.()
      sides[other]!.close?.()
    },
  })
  return [make(0, 1), make(1, 0)]
}

function setup(overrides: Partial<RpcHandlers<TestApi>> = {}) {
  const state = { started: false, aborted: false }
  const handlers: RpcHandlers<TestApi> = {
    echo: ({ text }) => text,
    fail: () => {
      throw new RpcError('NOPE', 'That did not work')
    },
    explode: () => {
      throw new Error('boom')
    },
    slow: (_params, { signal }) =>
      new Promise<string>((resolve) => {
        state.started = true
        signal.addEventListener('abort', () => {
          state.aborted = true
          resolve('aborted')
        })
      }),
    ...overrides,
  }
  const [serverPort, clientPort] = createPortPair()
  const server = createRpcServer<TestApi>(handlers)
  server.attach(serverPort)
  const client = createRpcClient<TestApi>(clientPort)
  return { server, client, state, serverPort, clientPort }
}

describe('rpc', () => {
  it('returns the handler result', async () => {
    const { client } = setup()
    await expect(client.call('echo', { text: 'hi' })).resolves.toBe('hi')
  })

  it('keeps the error code of an RpcError', async () => {
    const { client } = setup()
    await expect(client.call('fail', undefined)).rejects.toMatchObject({
      name: 'RpcError',
      code: 'NOPE',
      message: 'That did not work',
    })
  })

  it('maps unexpected errors to INTERNAL without leaking a stack', async () => {
    const { client } = setup()
    await expect(client.call('explode', undefined)).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'boom',
    })
  })

  it('rejects unknown methods', async () => {
    const { client } = setup()
    const call = (client as unknown as { call: (m: string, p: unknown) => Promise<unknown> }).call
    await expect(call('nope', undefined)).rejects.toMatchObject({ code: 'NO_SUCH_METHOD' })
  })

  it('cancels a request: the handler is aborted and the caller rejects', async () => {
    const { client, state } = setup()
    const controller = new AbortController()
    const pending = client.call('slow', undefined, { signal: controller.signal })
    await vi.waitFor(() => expect(state.started).toBe(true))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    await vi.waitFor(() => expect(state.aborted).toBe(true))
  })

  it('does not start a handler whose request was cancelled before it ran', async () => {
    const { client, state } = setup()
    const controller = new AbortController()
    const pending = client.call('slow', undefined, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(state.started).toBe(false)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const { client } = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(
      client.call('echo', { text: 'x' }, { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'ABORTED',
    })
  })

  it('delivers broadcast events to subscribed clients', async () => {
    const { client, server } = setup()
    const received: unknown[] = []
    client.on('ping', (payload) => received.push(payload))
    server.broadcast('ping', { n: 1 })
    await vi.waitFor(() => expect(received).toEqual([{ n: 1 }]))
  })

  it('stops delivering events after unsubscribe', async () => {
    const { client, server } = setup()
    const received: unknown[] = []
    const off = client.on('ping', (payload) => received.push(payload))
    off()
    server.broadcast('ping', 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(received).toEqual([])
  })

  it('fails pending calls with PORT_CLOSED when the port closes', async () => {
    const { client, clientPort } = setup()
    const pending = client.call('slow', undefined)
    clientPort.close()
    await expect(pending).rejects.toMatchObject({ code: 'PORT_CLOSED' })
    await expect(client.call('echo', { text: 'x' })).rejects.toMatchObject({ code: 'PORT_CLOSED' })
  })

  it('aborts in-flight handlers when the caller disappears', async () => {
    const { clientPort, client, state } = setup()
    void client.call('slow', undefined).catch(() => undefined)
    await vi.waitFor(() => expect(state.started).toBe(true))
    clientPort.close()
    await vi.waitFor(() => expect(state.aborted).toBe(true))
  })
})
