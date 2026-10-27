import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { IPC } from '@shared/bridge'

const isMac = process.platform === 'darwin'

/** Sends a command id to the focused window. The renderer's command registry runs it. */
function command(id: string): () => void {
  return () => BrowserWindow.getFocusedWindow()?.webContents.send(IPC.command, id)
}

/**
 * The native menu. macOS needs it for the standard Edit roles (copy and paste in every field)
 * and ⌘Q. Items that run app commands only display their shortcut: the renderer handles the
 * key itself, so each shortcut fires exactly once.
 */
export function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: 'Cmd+,',
                registerAccelerator: false,
                click: command('settings.open'),
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Connection…',
          accelerator: 'CmdOrCtrl+N',
          registerAccelerator: false,
          click: command('connection.new'),
        },
        {
          label: 'New Script',
          accelerator: 'CmdOrCtrl+T',
          registerAccelerator: false,
          click: command('script.new'),
        },
        {
          label: 'Commit Row Changes',
          accelerator: 'CmdOrCtrl+S',
          registerAccelerator: false,
          click: command('edits.commit'),
        },
        { type: 'separator' },
        {
          label: 'Import Connections from Another Tool…',
          click: command('connection.importDbeaver'),
        },
        { label: 'Import SQL Files…', click: command('script.import') },
        { label: 'Show Scripts Folder', click: command('script.revealFolder') },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          registerAccelerator: false,
          click: command('tab.close'),
        },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Command Palette…',
          accelerator: 'CmdOrCtrl+Shift+P',
          registerAccelerator: false,
          click: command('palette.commands'),
        },
        {
          label: 'Go to Anything…',
          accelerator: 'CmdOrCtrl+P',
          registerAccelerator: false,
          click: command('palette.goto'),
        },
        { type: 'separator' },
        {
          label: 'Result as Table',
          accelerator: 'CmdOrCtrl+Alt+1',
          registerAccelerator: false,
          click: command('results.viewTable'),
        },
        {
          label: 'Result as Pivot',
          accelerator: 'CmdOrCtrl+Alt+2',
          registerAccelerator: false,
          click: command('results.viewPivot'),
        },
        {
          label: 'Result as Chart',
          accelerator: 'CmdOrCtrl+Alt+3',
          registerAccelerator: false,
          click: command('results.viewChart'),
        },
        {
          label: 'Compare Results…',
          accelerator: 'CmdOrCtrl+Alt+M',
          registerAccelerator: false,
          click: command('results.compare'),
        },
        {
          label: 'Query Plan…',
          accelerator: 'CmdOrCtrl+Alt+P',
          registerAccelerator: false,
          click: command('sql.explain'),
        },
        {
          label: 'Database Diagram…',
          accelerator: 'CmdOrCtrl+Alt+D',
          registerAccelerator: false,
          click: command('diagram.open'),
        },
        { type: 'separator' },
        {
          label: 'Show Scripts',
          accelerator: 'CmdOrCtrl+Shift+O',
          registerAccelerator: false,
          click: command('view.showScripts'),
        },
        {
          label: 'Show Query History',
          accelerator: 'CmdOrCtrl+Shift+H',
          registerAccelerator: false,
          click: command('view.showHistory'),
        },
        { type: 'separator' },
        {
          label: 'Toggle Navigator',
          accelerator: 'CmdOrCtrl+B',
          registerAccelerator: false,
          click: command('view.toggleNavigator'),
        },
        {
          label: 'Toggle Inspector',
          accelerator: 'CmdOrCtrl+Alt+B',
          registerAccelerator: false,
          click: command('view.toggleInspector'),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged
          ? []
          : [
              { type: 'separator' as const },
              { role: 'reload' as const },
              { role: 'toggleDevTools' as const },
            ]),
      ],
    },
    {
      label: 'SQL',
      submenu: [
        {
          label: 'Run Statement',
          accelerator: 'CmdOrCtrl+Enter',
          registerAccelerator: false,
          click: command('sql.run'),
        },
        {
          label: 'Run Script',
          accelerator: 'CmdOrCtrl+Shift+Enter',
          registerAccelerator: false,
          click: command('sql.runAll'),
        },
        {
          label: 'Cancel',
          accelerator: 'CmdOrCtrl+.',
          registerAccelerator: false,
          click: command('sql.cancel'),
        },
        { type: 'separator' },
        {
          label: 'Format SQL',
          accelerator: 'CmdOrCtrl+Alt+L',
          registerAccelerator: false,
          click: command('sql.format'),
        },
        { type: 'separator' },
        {
          label: 'Local History…',
          accelerator: 'CmdOrCtrl+Alt+H',
          registerAccelerator: false,
          click: command('script.history'),
        },
        {
          label: 'Export Result…',
          accelerator: 'CmdOrCtrl+Alt+E',
          registerAccelerator: false,
          click: command('results.export'),
        },
      ],
    },
    {
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
