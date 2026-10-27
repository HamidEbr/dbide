import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseDataSources, type DbeaverConnection, type DbeaverSkipped } from '@shared/dbeaver'
import { decryptCredentials, type DbeaverLogin } from './credentials'

/** Where DBeaver keeps the connections of its default workspace on this computer. */
export function defaultDbeaverDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const data =
    platform === 'darwin'
      ? join(home, 'Library', 'DBeaverData')
      : platform === 'win32'
        ? join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'DBeaverData')
        : join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'DBeaverData')
  return join(data, 'workspace6', 'General', '.dbeaver')
}

export interface DbeaverFile {
  connections: DbeaverConnection[]
  skipped: DbeaverSkipped[]
  /** Saved logins by DBeaver connection id, when the credentials file could be read. Never sent to the window. */
  logins: Record<string, { connection?: DbeaverLogin; ssh?: DbeaverLogin }>
  /** Whether a credentials file was there to read. */
  hasCredentials: boolean
  /** Why no logins were read, when there was something to say. */
  credentialsProblem?: 'missing' | 'unreadable'
}

/**
 * Reads the connections in a DBeaver `data-sources*.json`, or all of them in a `.dbeaver` folder, with the saved
 * logins from the `credentials-config.json` beside them. Null when nothing there is a DBeaver file.
 */
export async function readDbeaver(path: string): Promise<DbeaverFile | null> {
  const isDir = path.endsWith('.dbeaver')
  const dir = isDir ? path : dirname(path)
  let files: string[]
  try {
    files = isDir
      ? (await readdir(dir))
          .filter((f) => /^data-sources.*\.json$/.test(f))
          .map((f) => join(dir, f))
      : [path]
  } catch {
    return null
  }
  const connections: DbeaverConnection[] = []
  const skipped: DbeaverSkipped[] = []
  let found = false
  for (const file of files) {
    let source: string
    try {
      source = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const parsed = parseDataSources(source)
    if (!parsed) continue
    found = true
    connections.push(...parsed.connections)
    skipped.push(...parsed.skipped)
  }
  if (!found) return null
  let logins: DbeaverFile['logins'] = {}
  let hasCredentials = false
  let credentialsProblem: DbeaverFile['credentialsProblem']
  let file: Buffer | null = null
  try {
    file = await readFile(join(dir, 'credentials-config.json'))
  } catch {
    credentialsProblem = 'missing'
  }
  if (file) {
    const decrypted = decryptCredentials(file)
    if (decrypted) {
      logins = decrypted
      hasCredentials = true
    } else {
      credentialsProblem = 'unreadable'
    }
  }
  return {
    connections,
    skipped,
    logins,
    hasCredentials,
    ...(credentialsProblem ? { credentialsProblem } : {}),
  }
}
