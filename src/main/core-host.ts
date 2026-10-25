import { EventEmitter } from 'node:events'
import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron'
import type { HostApi } from '@shared/api'
import { IPC, type CoreState } from '@shared/bridge'
import { fromNodePort } from '@shared/node-port'
import { createRpcServer } from '@shared/rpc'
import type { FileHandlers } from './files'
import type { SecretStore } from './secrets'

export interface CoreHostOptions {
  entry: string
  dataDir: string
  version: string
  secrets: SecretStore
  files: FileHandlers
}

const MAX_RESTARTS = 5
const RESTART_WINDOW_MS = 60_000

/**
 * Runs the core as an Electron utility process and keeps it alive. If a driver crashes the
 * core, windows keep working, show a banner, and reconnect once the core is back.
 */
export class CoreHost extends EventEmitter<{ state: [CoreState] }> {
  private child: UtilityProcess | null = null
  private state: CoreState = 'starting'
  private ready: Promise<UtilityProcess> = Promise.reject(new Error('not started'))
  private readonly restarts: number[] = []
  private stopping = false

  constructor(private readonly options: CoreHostOptions) {
    super()
    this.ready.catch(() => undefined)
  }

  get currentState(): CoreState {
    return this.state
  }

  start(): void {
    this.setState(this.restarts.length > 0 ? 'restarting' : 'starting')

    const child = utilityProcess.fork(this.options.entry, [], {
      serviceName: 'dbide-core',
      env: {
        ...process.env,
        DBIDE_DATA_DIR: this.options.dataDir,
        DBIDE_VERSION: this.options.version,
      },
    })
    this.child = child

    this.ready = new Promise<UtilityProcess>((resolve, reject) => {
      child.once('spawn', () => {
        this.serveHostApi(child)
        this.setState('ready')
        resolve(child)
      })
      child.once('exit', () => reject(new Error('The core process exited')))
    })
    this.ready.catch(() => undefined)

    child.once('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      if (this.stopping) return
      console.error(`[core] exited with code ${code}`)
      this.scheduleRestart()
    })
  }

  /** Gives a window its own private channel to the core. */
  async attachWindow(webContents: WebContents): Promise<void> {
    const child = await this.ready
    const { port1, port2 } = new MessageChannelMain()
    child.postMessage({ type: 'attach' }, [port1])
    webContents.postMessage(IPC.corePort, null, [port2])
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    const child = this.child
    if (!child) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 2000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.postMessage({ type: 'shutdown' })
    })
  }

  private serveHostApi(child: UtilityProcess): void {
    const { secrets, files } = this.options
    const { port1, port2 } = new MessageChannelMain()
    const server = createRpcServer<HostApi>({
      'secrets.available': () => secrets.available(),
      'secrets.get': ({ key }) => secrets.get(key),
      'secrets.set': ({ key, value }) => secrets.set(key, value),
      'secrets.delete': ({ key }) => secrets.delete(key),
      'files.chooseSavePath': (options) => files['files.chooseSavePath'](options),
      'files.chooseOpenPaths': (options) => files['files.chooseOpenPaths'](options),
      'files.reveal': ({ path }) => files['files.reveal']({ path }),
      'files.trash': ({ path }) => files['files.trash']({ path }),
    })
    server.attach(fromNodePort(port1))
    child.postMessage({ type: 'host-port' }, [port2])
  }

  private scheduleRestart(): void {
    const now = Date.now()
    while (this.restarts.length > 0 && now - this.restarts[0]! > RESTART_WINDOW_MS) {
      this.restarts.shift()
    }
    if (this.restarts.length >= MAX_RESTARTS) {
      this.setState('failed')
      return
    }
    this.restarts.push(now)
    this.setState('restarting')
    setTimeout(() => this.start(), 500)
  }

  private setState(state: CoreState): void {
    this.state = state
    this.emit('state', state)
  }
}
