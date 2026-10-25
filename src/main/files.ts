import { readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { BrowserWindow, dialog, shell } from 'electron'
import type { HostApi } from '@shared/api'

type FileMethod = 'files.chooseSavePath' | 'files.chooseOpenPaths' | 'files.reveal' | 'files.trash'

export type FileHandlers = {
  [M in FileMethod]: (params: HostApi[M]['params']) => Promise<HostApi[M]['result']>
}

const parentWindow = (): BrowserWindow | undefined =>
  BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]

/** Dialogs and file-manager actions for the core, which can't show any of them itself. */
export function createFileHandlers(): FileHandlers {
  return {
    async 'files.chooseSavePath'({ defaultName, filterName, extension }) {
      const options = {
        defaultPath: defaultName,
        filters: [
          { name: filterName, extensions: [extension] },
          { name: 'All files', extensions: ['*'] },
        ],
      }
      const window = parentWindow()
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      return result.canceled || !result.filePath ? null : result.filePath
    },

    async 'files.chooseOpenPaths'({ filterName, extensions }) {
      const options = {
        properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
        filters: [
          { name: filterName, extensions },
          { name: 'All files', extensions: ['*'] },
        ],
      }
      const window = parentWindow()
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? [] : result.filePaths
    },

    'files.reveal'({ path }) {
      // A folder is opened; a file is shown inside its folder, selected.
      if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
        return shell.openPath(path).then(() => undefined)
      }
      shell.showItemInFolder(path)
      return Promise.resolve()
    },

    'files.trash': ({ path }) => shell.trashItem(path),
  }
}

/**
 * The smoke test has nobody to click a dialog, and must not open file-manager windows or fill the
 * real trash. Its dialogs answer from a scratch folder instead.
 */
export function createSmokeFileHandlers(dir: string): FileHandlers {
  return {
    'files.chooseSavePath': ({ defaultName }) => Promise.resolve(join(dir, basename(defaultName))),
    'files.chooseOpenPaths': () => {
      const importDir = join(dir, 'import')
      try {
        return Promise.resolve(
          readdirSync(importDir)
            .sort()
            .map((name) => join(importDir, name)),
        )
      } catch {
        return Promise.resolve([])
      }
    },
    'files.reveal': () => Promise.resolve(),
    'files.trash': ({ path }) => rm(path, { force: true }),
  }
}
