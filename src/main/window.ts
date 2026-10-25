import { join } from 'node:path'
import { BrowserWindow, nativeTheme, shell } from 'electron'
import { TITLEBAR_COLORS, TITLEBAR_HEIGHT } from '@shared/settings'

const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'

function themeColors(): (typeof TITLEBAR_COLORS)[keyof typeof TITLEBAR_COLORS] {
  return nativeTheme.shouldUseDarkColors ? TITLEBAR_COLORS.dark : TITLEBAR_COLORS.light
}

export interface WindowOptions {
  smoke: boolean
}

/**
 * Chrome per platform: the tab strip lives in the title bar on macOS (inset traffic lights)
 * and Windows (native caption buttons as an overlay). Linux keeps native decorations because
 * Wayland and X11 disagree about custom ones.
 */
export function createMainWindow(options: WindowOptions): BrowserWindow {
  const colors = themeColors()

  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'DBIDE',
    backgroundColor: colors.color,
    autoHideMenuBar: !isMac,
    ...(isMac ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 14, y: 12 } } : {}),
    ...(isWindows
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { ...colors, height: TITLEBAR_HEIGHT },
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: !options.smoke,
      additionalArguments: options.smoke ? ['--dbide-smoke'] : [],
    },
  })

  // The smoke test runs headless: it never needs the window on screen.
  if (!options.smoke) window.once('ready-to-show', () => window.show())

  // Database content is untrusted. Nothing it renders may open windows or navigate the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (dev && url.startsWith(dev)) return
    if (url.startsWith('file://')) return
    event.preventDefault()
  })

  if (isWindows) {
    const update = (): void =>
      window.setTitleBarOverlay({ ...themeColors(), height: TITLEBAR_HEIGHT })
    nativeTheme.on('updated', update)
    window.once('closed', () => nativeTheme.removeListener('updated', update))
  }

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))

  return window
}
