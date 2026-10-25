import type { PortLike } from './rpc'

/**
 * Structural type for Electron's `MessagePortMain`. Declared here instead of imported so the
 * shared code does not depend on Electron's typings.
 */
export interface NodeMessagePort {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown
  postMessage(message: unknown): void
  start(): void
  close(): void
}

export function fromNodePort(port: NodeMessagePort): PortLike {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage(handler) {
      port.on('message', (event: { data: unknown }) => handler(event.data))
      port.start()
    },
    onClose(handler) {
      port.on('close', handler)
    },
    close: () => port.close(),
  }
}
