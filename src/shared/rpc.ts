/**
 * Tiny request/response + event protocol that runs over any MessagePort-like object.
 * It is shared by the renderer (DOM MessagePort), the main process and the core utility
 * process (Electron MessagePortMain), so it must not import anything platform specific.
 */

export interface PortLike {
  postMessage(message: unknown): void
  onMessage(handler: (data: unknown) => void): void
  onClose(handler: () => void): void
  close(): void
}

export interface RpcErrorShape {
  code: string
  message: string
}

type RpcRequest = { t: 'req'; id: number; method: string; params?: unknown }
type RpcResponse =
  | { t: 'res'; id: number; ok: true; result?: unknown }
  | { t: 'res'; id: number; ok: false; error: RpcErrorShape }
type RpcCancel = { t: 'cancel'; id: number }
type RpcEvent = { t: 'evt'; name: string; payload?: unknown }
type RpcMessage = RpcRequest | RpcResponse | RpcCancel | RpcEvent

export class RpcError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RpcError'
    this.code = code
  }

  toShape(): RpcErrorShape {
    return { code: this.code, message: this.message }
  }
}

function isRpcMessage(data: unknown): data is RpcMessage {
  return typeof data === 'object' && data !== null && 't' in data
}

function toErrorShape(error: unknown): RpcErrorShape {
  if (error instanceof RpcError) return error.toShape()
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return { code: typeof code === 'string' ? code : 'INTERNAL', message: error.message }
  }
  return { code: 'INTERNAL', message: String(error) }
}

/**
 * A method map describing one side's API, so both ends of a channel stay in sync. Written as a
 * self-referential constraint (not an index signature) so each method keeps its own types.
 */
export type RpcShape<Api> = { [M in keyof Api]: { params: unknown; result: unknown } }

export interface HandlerContext {
  /** Aborted when the caller cancels the request or the port closes. */
  signal: AbortSignal
  /** Aborted when the caller's port closes, however long after the request finished. */
  portSignal: AbortSignal
  /** Sends an event to the caller only, for results that stream while a request is running. */
  emit(name: string, payload?: unknown): void
}

export type RpcHandlers<Api extends RpcShape<Api>> = {
  [M in keyof Api & string]: (
    params: Api[M]['params'],
    ctx: HandlerContext,
  ) => Promise<Api[M]['result']> | Api[M]['result']
}

export interface RpcServer {
  /** Serve requests arriving on `port`. Returns a function that detaches it. */
  attach(port: PortLike): () => void
  /** Send an event to every attached port. */
  broadcast(name: string, payload?: unknown): void
}

export function createRpcServer<Api extends RpcShape<Api>>(handlers: RpcHandlers<Api>): RpcServer {
  const ports = new Set<PortLike>()
  const table = handlers as Record<
    string,
    (params: unknown, ctx: HandlerContext) => Promise<unknown> | unknown
  >

  return {
    attach(port) {
      const inflight = new Map<number, AbortController>()
      const portLife = new AbortController()
      ports.add(port)

      const detach = (): void => {
        for (const controller of inflight.values()) controller.abort()
        inflight.clear()
        ports.delete(port)
        portLife.abort()
      }

      port.onMessage((data) => {
        if (!isRpcMessage(data)) return
        if (data.t === 'cancel') {
          inflight.get(data.id)?.abort()
          return
        }
        if (data.t !== 'req') return

        const { id, method, params } = data
        const handler = table[method]
        if (!handler) {
          port.postMessage({
            t: 'res',
            id,
            ok: false,
            error: { code: 'NO_SUCH_METHOD', message: `Unknown method "${method}"` },
          } satisfies RpcResponse)
          return
        }

        const controller = new AbortController()
        inflight.set(id, controller)
        Promise.resolve()
          .then(() => {
            // A cancel can overtake the request, so never start work nobody is waiting for.
            if (controller.signal.aborted) throw new RpcError('ABORTED', 'The call was cancelled')
            return handler(params, {
              signal: controller.signal,
              portSignal: portLife.signal,
              emit: (name, payload) => {
                if (!portLife.signal.aborted) {
                  port.postMessage({ t: 'evt', name, payload } satisfies RpcEvent)
                }
              },
            })
          })
          .then(
            (result) => ({ t: 'res', id, ok: true, result }) satisfies RpcResponse,
            (error: unknown) =>
              ({ t: 'res', id, ok: false, error: toErrorShape(error) }) satisfies RpcResponse,
          )
          .then((response) => {
            inflight.delete(id)
            port.postMessage(response)
          })
      })
      port.onClose(detach)

      return () => {
        detach()
        port.close()
      }
    },

    broadcast(name, payload) {
      const message: RpcEvent = { t: 'evt', name, payload }
      for (const port of ports) port.postMessage(message)
    },
  }
}

export interface CallOptions {
  signal?: AbortSignal
}

export interface RpcClient<Api extends RpcShape<Api>> {
  call<M extends keyof Api & string>(
    method: M,
    params: Api[M]['params'],
    options?: CallOptions,
  ): Promise<Api[M]['result']>
  on(name: string, handler: (payload: unknown) => void): () => void
  close(): void
}

export function createRpcClient<Api extends RpcShape<Api>>(port: PortLike): RpcClient<Api> {
  let nextId = 1
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  let closed = false

  const failAll = (error: RpcError): void => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }

  port.onMessage((data) => {
    if (!isRpcMessage(data)) return
    if (data.t === 'res') {
      const entry = pending.get(data.id)
      if (!entry) return
      pending.delete(data.id)
      if (data.ok) entry.resolve(data.result)
      else entry.reject(new RpcError(data.error.code, data.error.message))
    } else if (data.t === 'evt') {
      for (const handler of listeners.get(data.name) ?? []) handler(data.payload)
    }
  })
  port.onClose(() => {
    closed = true
    failAll(new RpcError('PORT_CLOSED', 'The connection to the core process closed'))
  })

  return {
    call(method, params, options) {
      if (closed) return Promise.reject(new RpcError('PORT_CLOSED', 'The core process is gone'))
      const signal = options?.signal
      if (signal?.aborted) return Promise.reject(new RpcError('ABORTED', 'The call was cancelled'))

      const id = nextId++
      return new Promise((resolve, reject) => {
        const onAbort = (): void => {
          pending.delete(id)
          port.postMessage({ t: 'cancel', id } satisfies RpcCancel)
          reject(new RpcError('ABORTED', 'The call was cancelled'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        pending.set(id, {
          resolve: (value) => {
            signal?.removeEventListener('abort', onAbort)
            resolve(value as never)
          },
          reject: (error) => {
            signal?.removeEventListener('abort', onAbort)
            reject(error)
          },
        })
        port.postMessage({ t: 'req', id, method, params } satisfies RpcRequest)
      })
    },

    on(name, handler) {
      let set = listeners.get(name)
      if (!set) {
        set = new Set()
        listeners.set(name, set)
      }
      set.add(handler)
      return () => set.delete(handler)
    },

    close() {
      closed = true
      failAll(new RpcError('PORT_CLOSED', 'The client was closed'))
      port.close()
    },
  }
}
