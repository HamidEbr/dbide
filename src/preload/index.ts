import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  CORE_PORT_MESSAGE,
  IPC,
  type CoreState,
  type DbideApi,
  type Platform,
} from '@shared/bridge'

// The preload runs in a page context, but this project's Node tsconfig has no DOM lib.
declare const window: {
  postMessage(message: unknown, targetOrigin: string, transfer: unknown[]): void
}

function subscribe<T>(channel: string, handler: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T): void => handler(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: DbideApi = {
  platform: process.platform as Platform,
  smoke: process.argv.includes('--dbide-smoke'),
  requestCorePort: () => ipcRenderer.send(IPC.requestCorePort),
  onCoreState: (handler) => subscribe<CoreState>(IPC.coreState, handler),
  onCommand: (handler) => subscribe<string>(IPC.command, handler),
  setThemeSource: (source) => ipcRenderer.invoke(IPC.setThemeSource, source),
}

contextBridge.exposeInMainWorld('dbide', api)

// A MessagePort can't cross contextBridge, but it can be transferred with postMessage.
ipcRenderer.on(IPC.corePort, (event) => {
  window.postMessage({ type: CORE_PORT_MESSAGE }, '*', [...event.ports])
})
