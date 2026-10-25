import { CoreEvents, type CoreApi } from '@shared/api'
import { CORE_PORT_MESSAGE, type CoreState } from '@shared/bridge'
import { createRpcClient, RpcError, type PortLike, type RpcClient } from '@shared/rpc'

function fromDomPort(port: MessagePort): PortLike {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage(handler) {
      port.onmessage = (event) => handler(event.data)
    },
    onClose(handler) {
      port.addEventListener('close', handler)
    },
    close: () => port.close(),
  }
}

type Listener = () => void

/**
 * The renderer's connection to the core process. It asks the main process for a MessagePort,
 * and asks again whenever the core restarts, so a driver crash never needs a window reload.
 */
export class CoreLink {
  private client: RpcClient<CoreApi> | null = null
  private requested = true
  private readonly connectedListeners = new Set<Listener>()
  private readonly eventListeners = new Map<string, Set<(payload: unknown) => void>>()
  private waiters: ((client: RpcClient<CoreApi>) => void)[] = []

  start(): void {
    window.addEventListener('message', (event) => this.onMessage(event))
    window.dbide.onCoreState((state) => this.onState(state))
    window.dbide.requestCorePort()
  }

  /** Runs after every (re)connection, including the first. */
  onConnected(listener: Listener): () => void {
    this.connectedListeners.add(listener)
    return () => this.connectedListeners.delete(listener)
  }

  on(event: string, handler: (payload: unknown) => void): () => void {
    let set = this.eventListeners.get(event)
    if (!set) {
      set = new Set()
      this.eventListeners.set(event, set)
    }
    set.add(handler)
    return () => set.delete(handler)
  }

  async call<M extends keyof CoreApi & string>(
    method: M,
    params: CoreApi[M]['params'],
    options?: { signal?: AbortSignal },
  ): Promise<CoreApi[M]['result']> {
    const client = this.client ?? (await this.waitForClient())
    try {
      return await client.call(method, params, options)
    } catch (error) {
      if (error instanceof RpcError && error.code === 'PORT_CLOSED') {
        // The core restarted mid-call. Wait for the new port and try once more.
        this.client = null
        return (await this.waitForClient()).call(method, params, options)
      }
      throw error
    }
  }

  private waitForClient(): Promise<RpcClient<CoreApi>> {
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private onState(state: CoreState): void {
    if (state === 'ready') {
      if (!this.requested) {
        this.requested = true
        window.dbide.requestCorePort()
      }
      return
    }
    // The old port is dead. Drop it and ask again once the core reports ready.
    this.client?.close()
    this.client = null
    this.requested = false
  }

  private onMessage(event: MessageEvent): void {
    const data = event.data as { type?: string } | null
    if (event.source !== window || data?.type !== CORE_PORT_MESSAGE) return
    const [port] = event.ports
    if (!port) return

    this.client?.close()
    const client = createRpcClient<CoreApi>(fromDomPort(port))
    for (const name of Object.values(CoreEvents)) {
      client.on(name, (payload) =>
        this.eventListeners.get(name)?.forEach((handler) => handler(payload)),
      )
    }
    this.client = client
    this.requested = true

    const waiting = this.waiters
    this.waiters = []
    waiting.forEach((resolve) => resolve(client))
    this.connectedListeners.forEach((listener) => listener())
  }
}

export const coreLink = new CoreLink()
