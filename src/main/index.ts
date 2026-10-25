import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeTheme, safeStorage, session } from 'electron'
import { IPC, type ThemeSource } from '@shared/bridge'
import { CoreHost } from './core-host'
import { createFileHandlers, createSmokeFileHandlers } from './files'
import { installMenu } from './menu'
import { SecretStore, type Cipher } from './secrets'
import { runSmoke } from './smoke'
import { createMainWindow } from './window'

const smoke = process.env.DBIDE_SMOKE === '1'

app.setName('DBIDE')
// Tests and the smoke run point the app at a scratch directory.
if (process.env.DBIDE_USER_DATA) app.setPath('userData', process.env.DBIDE_USER_DATA)

/** Electron's safeStorage, but only when the OS has a real keychain behind it. */
const osCipher: Cipher = {
  isAvailable() {
    if (!safeStorage.isEncryptionAvailable()) return false
    // On Linux without a keyring Chromium falls back to a hard-coded key. That is not encryption.
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend()
      return backend !== 'basic_text' && backend !== 'unknown'
    }
    return true
  },
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (encrypted) => safeStorage.decryptString(encrypted),
}

/** The smoke test must never touch a real keychain, so it gets a throwaway cipher. */
const smokeCipher: Cipher = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from(plain, 'utf8'),
  decrypt: (encrypted) => encrypted.toString('utf8'),
}

function isThemeSource(value: unknown): value is ThemeSource {
  return value === 'system' || value === 'light' || value === 'dark'
}

if (!smoke && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void app.whenReady().then(() => {
    installMenu()

    // The app asks for no camera, microphone, geolocation or notifications.
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    )
    session.defaultSession.setPermissionCheckHandler(() => false)

    const dataDir = app.getPath('userData')
    const core = new CoreHost({
      entry: join(__dirname, 'core.js'),
      dataDir,
      version: app.getVersion(),
      secrets: new SecretStore(join(dataDir, 'secrets.json'), smoke ? smokeCipher : osCipher),
      files:
        smoke && process.env.DBIDE_SMOKE_FILES_DIR
          ? createSmokeFileHandlers(process.env.DBIDE_SMOKE_FILES_DIR)
          : createFileHandlers(),
    })
    core.start()

    core.on('state', (state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC.coreState, state)
      }
    })

    ipcMain.on(IPC.requestCorePort, (event) => {
      // If the core is down the window asks again when the main process reports it ready.
      core.attachWindow(event.sender).catch(() => undefined)
    })
    ipcMain.handle(IPC.setThemeSource, (_event, source: unknown) => {
      if (!isThemeSource(source)) throw new Error('Unknown theme source')
      nativeTheme.themeSource = source
    })

    const window = createMainWindow({ smoke })
    if (smoke) void runSmoke(window, process.env.DBIDE_SMOKE_SHOTS).then((code) => app.exit(code))

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow({ smoke })
    })

    let shuttingDown = false
    app.on('before-quit', (event) => {
      if (shuttingDown) return
      event.preventDefault()
      shuttingDown = true
      void core.shutdown().finally(() => app.quit())
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
