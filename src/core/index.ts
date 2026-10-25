/**
 * Entry point of the core utility process. It owns drivers, storage and parsing, so a slow
 * query or a crashing driver can never freeze or take down a window.
 *
 * Wiring, set up by the main process:
 *  - `host-port`: a port to the main process for the few things only it can do (secrets).
 *  - `attach`:    a port to one renderer window. Every window gets its own port.
 */
import { join } from 'node:path'
import type { CoreApi, HostApi } from '@shared/api'
import { fromNodePort, type NodeMessagePort } from '@shared/node-port'
import { createRpcClient, createRpcServer, type RpcClient } from '@shared/rpc'
import { createDefaultRegistry } from './drivers/registry'
import { createHostFiles } from './host-files'
import { createHostSecrets } from './secrets'
import { SpillStore } from './results/spill'
import { SessionManager } from './session/manager'
import { createCoreHandlers } from './service'
import { openDatabase } from './storage/database'

const dataDir = process.env.DBIDE_DATA_DIR
if (!dataDir) throw new Error('DBIDE_DATA_DIR is not set')

const parentPort = process.parentPort

let resolveHost!: (client: RpcClient<HostApi>) => void
const host = new Promise<RpcClient<HostApi>>((resolve) => {
  resolveHost = resolve
})

const db = openDatabase(join(dataDir, 'dbide.sqlite'))
// Rows of big results that the window does not keep. Scratch space, emptied at every start.
const spill = new SpillStore(join(dataDir, 'spill'))
const drivers = createDefaultRegistry()
const sessions = new SessionManager(drivers)

const server = createRpcServer<CoreApi>(
  createCoreHandlers({
    db,
    drivers,
    sessions,
    secrets: createHostSecrets(host),
    files: createHostFiles(host),
    scriptsDir: join(dataDir, 'scripts'),
    spill,
    notify: (event, payload) => server.broadcast(event, payload),
    info: { version: process.env.DBIDE_VERSION ?? '0.0.0', dataDir },
  }),
)

parentPort.on('message', (event) => {
  const message = event.data as { type?: string } | undefined
  const [port] = event.ports
  if (!port) return

  if (message?.type === 'host-port') {
    resolveHost(createRpcClient<HostApi>(fromNodePort(port as unknown as NodeMessagePort)))
  } else if (message?.type === 'attach') {
    server.attach(fromNodePort(port as unknown as NodeMessagePort))
  }
})

parentPort.on('message', (event) => {
  if ((event.data as { type?: string } | undefined)?.type !== 'shutdown') return
  void sessions.closeAll().finally(() => {
    spill.close()
    db.close()
    process.exit(0)
  })
})
