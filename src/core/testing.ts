import { createServer, type Server } from 'node:net'
import type { EngineKind } from '@shared/connection'
import type { ConnectContext, Driver, DriverDescriptor, DriverSession } from '@shared/driver'

/** Helpers shared by the core's tests. Not imported by production code. */

export function descriptor(
  engine: EngineKind,
  overrides: Partial<DriverDescriptor> = {},
): DriverDescriptor {
  return {
    engine,
    displayName: engine,
    defaultPort: 1,
    uriSchemes: [engine],
    capabilities: [],
    tlsMode: 'direct',
    implemented: true,
    ...overrides,
  }
}

export function fakeSession(overrides: Partial<DriverSession> = {}): DriverSession {
  return {
    info: { serverVersion: 'fake', currentDatabase: null, readOnly: false },
    ping: () => Promise.resolve(),
    children: () => Promise.resolve([]),
    // eslint-disable-next-line require-yield
    async *execute() {
      return
    },
    close: () => Promise.resolve(),
    ...overrides,
  }
}

export function fakeDriver(
  engine: EngineKind,
  connect: (context: ConnectContext) => Promise<DriverSession> = () =>
    Promise.resolve(fakeSession()),
  overrides: Partial<DriverDescriptor> = {},
): Driver {
  return { descriptor: descriptor(engine, overrides), connect }
}

/** Starts a TCP server on a free local port that accepts and immediately hangs up. */
export async function listenLocally(): Promise<{
  server: Server
  port: number
  close: () => Promise<void>
}> {
  const server = createServer((socket) => {
    // Drain and ignore input, otherwise a paused socket never notices the client hanging up.
    socket.on('error', () => undefined)
    socket.resume()
    socket.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** A port nothing listens on: open a server, note its port, close it. */
export async function closedPort(): Promise<number> {
  const { port, close } = await listenLocally()
  await close()
  return port
}
