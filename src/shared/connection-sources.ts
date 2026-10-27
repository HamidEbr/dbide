import type { EngineKind } from './connection'
import { parseDataSources, type DbeaverConnection, type DbeaverSkipped } from './dbeaver'
import { parseConnectionUri } from './uri'

/** Where connections can be brought in from. */
export type ConnectionSource = 'dbeaver' | 'workbench' | 'sequelace' | 'navicat' | 'urls'

export interface ConnectionSourceInfo {
  value: ConnectionSource
  label: string
  /** What the person is asked for: a file to pick, or text to paste. */
  input: 'file' | 'text'
  /** Extensions for the file dialog. */
  extensions: string[]
  fileHint: string
  /** Whether the passwords can be brought over. */
  passwords: boolean
}

export const CONNECTION_SOURCES: readonly ConnectionSourceInfo[] = [
  {
    value: 'dbeaver',
    label: 'DBeaver',
    input: 'file',
    extensions: ['json'],
    fileHint: 'data-sources.json, in the .dbeaver folder of its workspace',
    passwords: true,
  },
  {
    value: 'workbench',
    label: 'MySQL Workbench',
    input: 'file',
    extensions: ['xml'],
    fileHint: 'connections.xml, in the MySQL Workbench folder of your user data',
    passwords: false,
  },
  {
    value: 'sequelace',
    label: 'Sequel Ace / Pro',
    input: 'file',
    extensions: ['plist'],
    fileHint: 'Favorites.plist, in the Sequel Ace data folder',
    passwords: false,
  },
  {
    value: 'navicat',
    label: 'Navicat',
    input: 'file',
    extensions: ['ncx'],
    fileHint: 'a connections file exported from Navicat (.ncx)',
    passwords: true,
  },
  {
    value: 'urls',
    label: 'Connection URLs',
    input: 'text',
    extensions: [],
    fileHint: '',
    passwords: true,
  },
]

export interface ParsedSource {
  connections: DbeaverConnection[]
  skipped: DbeaverSkipped[]
  /** Logins that came with the file itself (a URL's, a Navicat export's), by connection id, as read. */
  logins: Record<string, { connection?: { user: string; password: string } }>
}

const unescapeXml = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')

const DEFAULT_PORTS: Record<EngineKind, number> = {
  mysql: 3306,
  mongodb: 27017,
  redis: 6379,
  rabbitmq: 5672,
}

function connection(
  partial: Partial<DbeaverConnection> & Pick<DbeaverConnection, 'sourceId' | 'name' | 'engine'>,
): DbeaverConnection {
  const port =
    partial.port && partial.port > 0 && partial.port < 65536
      ? partial.port
      : DEFAULT_PORTS[partial.engine]
  return {
    host: 'localhost',
    database: '',
    username: '',
    folder: '',
    environment: 'dev',
    tls: false,
    ssh: null,
    hasPassword: false,
    ...partial,
    port,
  }
}

// ───────── MySQL Workbench: connections.xml ─────────

function valueOf(block: string, key: string): string {
  const match = new RegExp(
    `<(?:value|link)[^>]*\\bkey="${key}"[^>]*>([^<]*)</(?:value|link)>`,
  ).exec(block)
  return match ? unescapeXml(match[1]!.trim()) : ''
}

export function parseWorkbench(xml: string): ParsedSource | null {
  if (!xml.includes('db.mgmt.Connection')) return null
  const blocks = xml.split('<value type="object" struct-name="db.mgmt.Connection"').slice(1)
  const connections: DbeaverConnection[] = []
  blocks.forEach((block, i) => {
    const sshHost = valueOf(block, 'sshHost')
    const [sshName, sshPort] = sshHost.split(':')
    connections.push(
      connection({
        sourceId: `workbench-${i}`,
        name: valueOf(block, 'name') || `Connection ${i + 1}`,
        engine: 'mysql',
        host: valueOf(block, 'hostName') || 'localhost',
        port: Number(valueOf(block, 'port')),
        database: valueOf(block, 'schema'),
        username: valueOf(block, 'userName'),
        tls: ['1', '2', '3'].includes(valueOf(block, 'useSSL')) && valueOf(block, 'useSSL') !== '0',
        ssh: sshName
          ? {
              host: sshName,
              port: Number(sshPort) || 22,
              username: valueOf(block, 'sshUserName'),
              auth: valueOf(block, 'sshKeyFile') ? 'key' : 'password',
              keyPath: valueOf(block, 'sshKeyFile'),
            }
          : null,
      }),
    )
  })
  return { connections, skipped: [], logins: {} }
}

// ───────── Sequel Ace / Sequel Pro: Favorites.plist ─────────

export function parseSequelAce(plist: string): ParsedSource | null {
  if (plist.startsWith('bplist')) return null
  if (!plist.includes('<plist')) return null
  const pairs = plist.matchAll(
    /<key>([^<]*)<\/key>\s*(?:<(string|integer|real)>([^<]*)<\/\2>|<(true|false)\s*\/>|<(string)\s*\/>)/g,
  )
  type Record = { [key: string]: string }
  const records: Record[] = []
  let current: Record | null = null
  for (const pair of pairs) {
    const key = unescapeXml(pair[1]!)
    const value = pair[4] ?? unescapeXml(pair[3] ?? '')
    if (key === 'name') {
      current = { name: value }
      records.push(current)
    } else if (current) {
      current[key] = value
    }
  }
  const connections: DbeaverConnection[] = []
  records.forEach((r, i) => {
    if (!r.host && !r.socket) return
    // type 0 is TCP/IP, 1 a socket, 2 a connection through SSH.
    const ssh = r.type === '2' && r.sshHost
    connections.push(
      connection({
        sourceId: `sequelace-${i}`,
        name: r.name || `Favorite ${i + 1}`,
        engine: 'mysql',
        host: r.host || 'localhost',
        port: Number(r.port),
        database: r.database ?? '',
        username: r.user ?? '',
        tls: r.useSSL === '1' || r.useSSL === 'true',
        ssh: ssh
          ? {
              host: r.sshHost!,
              port: Number(r.sshPort) || 22,
              username: r.sshUser ?? '',
              auth: r.sshKeyLocationEnabled === '1' ? 'key' : 'password',
              keyPath: r.sshKeyLocation ?? '',
            }
          : null,
      }),
    )
  })
  return { connections, skipped: [], logins: {} }
}

// ───────── Navicat: .ncx ─────────

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([A-Za-z_]+)="([^"]*)"/g)) out[m[1]!] = unescapeXml(m[2]!)
  return out
}

const NAVICAT_ENGINES: Record<string, EngineKind> = {
  MYSQL: 'mysql',
  MARIADB: 'mysql',
  MONGODB: 'mongodb',
  REDIS: 'redis',
}

/**
 * Navicat's export. A password in it is encrypted; `decrypt` turns the hex text into the password, or null.
 */
export function parseNavicat(
  xml: string,
  decrypt: (hex: string) => string | null,
): ParsedSource | null {
  const tags = [...xml.matchAll(/<Connection\s[^>]*>/g)].map((m) => attributes(m[0]))
  if (tags.length === 0) return null
  const connections: DbeaverConnection[] = []
  const skipped: DbeaverSkipped[] = []
  const logins: ParsedSource['logins'] = {}
  tags.forEach((a, i) => {
    const name = a.ConnectionName || `Connection ${i + 1}`
    const engine = NAVICAT_ENGINES[(a.ConnType ?? '').toUpperCase()]
    if (!engine) {
      skipped.push({ name, driver: a.ConnType || 'unknown' })
      return
    }
    const sourceId = `navicat-${i}`
    const password = a.Password ? decrypt(a.Password) : null
    if (a.UserName || password) {
      logins[sourceId] = { connection: { user: a.UserName ?? '', password: password ?? '' } }
    }
    connections.push(
      connection({
        sourceId,
        name,
        engine,
        host: a.Host || 'localhost',
        port: Number(a.Port),
        database: a.InitialDatabase ?? '',
        username: a.UserName ?? '',
        tls: a.UseSSL === 'true',
        hasPassword: Boolean(password),
        ssh:
          a.SSH === 'true' || a.UseSSH === 'true'
            ? {
                host: a.SSH_Host ?? '',
                port: Number(a.SSH_Port) || 22,
                username: a.SSH_UserName ?? '',
                auth: a.SSH_AuthenMethod === 'PUBLICKEY' ? 'key' : 'password',
                keyPath: a.SSH_PrivateKey ?? '',
              }
            : null,
      }),
    )
  })
  return { connections, skipped, logins }
}

// ───────── Pasted URLs ─────────

/** One connection per line: `mysql://user:pass@host:3306/db`, `mongodb://…`, `redis://…`. Blank lines and # comments are skipped. */
export function parseUrlList(text: string): ParsedSource {
  const connections: DbeaverConnection[] = []
  const skipped: DbeaverSkipped[] = []
  const logins: ParsedSource['logins'] = {}
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
  lines.forEach((line, i) => {
    const parsed = parseConnectionUri(line)
    if (!parsed || parsed.engine === 'rabbitmq') {
      skipped.push({
        name: line.replace(/\/\/[^@/]*@/, '//…@').slice(0, 60),
        driver: 'not a MySQL, MongoDB or Redis URL',
      })
      return
    }
    const sourceId = `url-${i}`
    if (parsed.username || parsed.password) {
      logins[sourceId] = {
        connection: { user: parsed.username ?? '', password: parsed.password ?? '' },
      }
    }
    connections.push(
      connection({
        sourceId,
        name: `${parsed.engine === 'mysql' ? 'MySQL' : parsed.engine === 'mongodb' ? 'MongoDB' : 'Redis'} ${parsed.host}`,
        engine: parsed.engine,
        host: parsed.host,
        port: parsed.port,
        database: parsed.database ?? '',
        username: parsed.username ?? '',
        tls: parsed.tls,
        hasPassword: Boolean(parsed.password),
      }),
    )
  })
  return { connections, skipped, logins }
}

/** DBeaver's file through the same shape as the rest. */
export function parseDbeaverSource(text: string): ParsedSource | null {
  const parsed = parseDataSources(text)
  return parsed ? { ...parsed, logins: {} } : null
}
