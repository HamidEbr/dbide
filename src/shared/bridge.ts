/** The narrow, typed surface the preload script exposes to the renderer as `window.dbide`. */

export type Platform = 'darwin' | 'win32' | 'linux'
export type ThemeSource = 'system' | 'light' | 'dark'
export type CoreState = 'starting' | 'ready' | 'restarting' | 'failed'

export interface DbideApi {
  platform: Platform
  /** True when the app was started by the smoke test, which also exposes `window.__dbide`. */
  smoke: boolean
  /** Asks the main process for a fresh port to the core. It arrives as a `window` message. */
  requestCorePort(): void
  onCoreState(handler: (state: CoreState) => void): () => void
  /** Commands triggered from native menus, by command id. */
  onCommand(handler: (commandId: string) => void): () => void
  setThemeSource(source: ThemeSource): Promise<void>
}

export const IPC = {
  requestCorePort: 'dbide:request-core-port',
  corePort: 'dbide:core-port',
  coreState: 'dbide:core-state',
  command: 'dbide:command',
  setThemeSource: 'dbide:set-theme-source',
} as const

/** `window.postMessage` type the preload uses to hand the core port to the page. */
export const CORE_PORT_MESSAGE = 'dbide:core-port'
