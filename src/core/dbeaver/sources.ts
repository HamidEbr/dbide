import { createDecipheriv } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  parseNavicat,
  parseSequelAce,
  parseUrlList,
  parseWorkbench,
  type ConnectionSource,
  type ParsedSource,
} from '@shared/connection-sources'
import { defaultDbeaverDir, readDbeaver, type DbeaverFile } from './read'

/** Navicat 12's fixed key and vector, published by the projects that read its files. */
function decryptNavicat(hex: string): string | null {
  try {
    const decipher = createDecipheriv(
      'aes-128-cbc',
      Buffer.from('libcckeylibcckey'),
      Buffer.from('libcciv libcciv '),
    )
    return Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString(
      'utf8',
    )
  } catch {
    return null
  }
}

/** Where a tool keeps its connections on this computer, or null when there is no one place. */
export function defaultSourcePath(
  source: ConnectionSource,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  switch (source) {
    case 'dbeaver':
      return defaultDbeaverDir(platform, env, home)
    case 'workbench':
      return platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'MySQL', 'Workbench', 'connections.xml')
        : platform === 'win32'
          ? join(
              env.APPDATA ?? join(home, 'AppData', 'Roaming'),
              'MySQL',
              'Workbench',
              'connections.xml',
            )
          : join(home, '.mysql', 'workbench', 'connections.xml')
    case 'sequelace':
      return platform === 'darwin'
        ? join(
            home,
            'Library',
            'Containers',
            'com.sequel-ace.sequel-ace',
            'Data',
            'Library',
            'Application Support',
            'Sequel Ace',
            'Data',
            'Favorites.plist',
          )
        : null
    default:
      return null
  }
}

function asFile(parsed: ParsedSource | null): DbeaverFile | null {
  if (!parsed) return null
  return {
    connections: parsed.connections,
    skipped: parsed.skipped,
    logins: parsed.logins,
    hasCredentials: parsed.connections.some((c) => c.hasPassword),
  }
}

/** The connections a tool's file, or pasted text, holds, with the logins that came with them. Null when it isn't one. */
export async function readConnections(
  source: ConnectionSource,
  input: { path?: string | null; text?: string },
): Promise<DbeaverFile | null> {
  if (source === 'urls') return asFile(parseUrlList(input.text ?? ''))
  if (!input.path) return null
  if (source === 'dbeaver') return readDbeaver(input.path)
  let text: string
  try {
    text = await readFile(input.path, 'utf8')
  } catch {
    return null
  }
  if (source === 'workbench') return asFile(parseWorkbench(text))
  if (source === 'sequelace') return asFile(parseSequelAce(text))
  return asFile(parseNavicat(text, decryptNavicat))
}
