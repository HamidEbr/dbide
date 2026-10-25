import { rm } from 'node:fs/promises'
import type { HostApi } from '@shared/api'
import type { RpcClient } from '@shared/rpc'

/** Dialogs and file-manager actions. Only the main process can show them, so the core asks it. */
export interface HostFiles {
  chooseSavePath(options: {
    defaultName: string
    filterName: string
    extension: string
  }): Promise<string | null>
  chooseOpenPaths(options: { filterName: string; extensions: string[] }): Promise<string[]>
  reveal(path: string): Promise<void>
  trash(path: string): Promise<void>
}

export function createHostFiles(host: Promise<RpcClient<HostApi>>): HostFiles {
  return {
    chooseSavePath: async (options) => (await host).call('files.chooseSavePath', options),
    chooseOpenPaths: async (options) => (await host).call('files.chooseOpenPaths', options),
    reveal: async (path) => (await host).call('files.reveal', { path }),
    trash: async (path) => (await host).call('files.trash', { path }),
  }
}

/** For tests: answers from a script and records what was asked. */
export function createFakeFiles(
  answers: { savePath?: string | null; openPaths?: string[] } = {},
): HostFiles & { revealed: string[]; trashed: string[]; saveAsked: string[] } {
  const revealed: string[] = []
  const trashed: string[] = []
  const saveAsked: string[] = []
  return {
    revealed,
    trashed,
    saveAsked,
    chooseSavePath: (options) => {
      saveAsked.push(options.defaultName)
      return Promise.resolve(answers.savePath ?? null)
    },
    chooseOpenPaths: () => Promise.resolve(answers.openPaths ?? []),
    reveal: (path) => {
      revealed.push(path)
      return Promise.resolve()
    },
    trash: (path) => {
      trashed.push(path)
      return rm(path, { force: true })
    },
  }
}
