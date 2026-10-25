import type { ConnectionConfig, EngineKind } from './connection'

export interface ParsedConnectionUri {
  engine: EngineKind
  host: string
  port: number
  username?: string
  password?: string
  database?: string
  tls: boolean
  options: Record<string, string>
}

const SCHEMES: Record<string, { engine: EngineKind; tls: boolean; port: number }> = {
  mysql: { engine: 'mysql', tls: false, port: 3306 },
  mariadb: { engine: 'mysql', tls: false, port: 3306 },
  mongodb: { engine: 'mongodb', tls: false, port: 27017 },
  'mongodb+srv': { engine: 'mongodb', tls: true, port: 27017 },
  redis: { engine: 'redis', tls: false, port: 6379 },
  rediss: { engine: 'redis', tls: true, port: 6379 },
  valkey: { engine: 'redis', tls: false, port: 6379 },
  amqp: { engine: 'rabbitmq', tls: false, port: 5672 },
  amqps: { engine: 'rabbitmq', tls: true, port: 5671 },
}

const URI_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(?:\/([^?#]*))?(?:\?([^#]*))?(?:#.*)?$/i

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Splits `host:port`, including bracketed IPv6 (`[::1]:6379`). Returns `port: undefined` when
 * the port is missing so the caller can apply the engine default.
 */
function splitHostPort(value: string): { host: string; port: number | undefined } {
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end !== -1) {
      const rest = value.slice(end + 1)
      const port = rest.startsWith(':') ? Number(rest.slice(1)) : undefined
      return { host: value.slice(1, end), port: Number.isInteger(port) ? port : undefined }
    }
  }
  const colon = value.lastIndexOf(':')
  if (colon === -1) return { host: value, port: undefined }
  const port = Number(value.slice(colon + 1))
  return { host: value.slice(0, colon), port: Number.isInteger(port) ? port : undefined }
}

/**
 * Parses the connection strings developers actually paste: `mysql://`, `mongodb://`,
 * `mongodb+srv://`, `redis://`, `rediss://`, `amqp://` and `amqps://`.
 *
 * Hand written instead of `new URL()` because Mongo allows several hosts in one URI and
 * passwords often contain characters the WHATWG parser rejects.
 */
export function parseConnectionUri(input: string): ParsedConnectionUri | null {
  const match = URI_PATTERN.exec(input.trim())
  if (!match) return null
  const [, rawScheme, authority = '', rawPath, rawQuery] = match
  const scheme = SCHEMES[rawScheme!.toLowerCase()]
  if (!scheme) return null

  // Credentials end at the last "@" so an unencoded "@" inside a password still works.
  const at = authority.lastIndexOf('@')
  const userInfo = at === -1 ? '' : authority.slice(0, at)
  const hostList = at === -1 ? authority : authority.slice(at + 1)

  let username: string | undefined
  let password: string | undefined
  if (userInfo) {
    const colon = userInfo.indexOf(':')
    const user = colon === -1 ? userInfo : userInfo.slice(0, colon)
    const pass = colon === -1 ? undefined : userInfo.slice(colon + 1)
    if (user) username = decode(user)
    if (pass) password = decode(pass)
  }

  const hosts = hostList.split(',').filter(Boolean)
  const first = splitHostPort(hosts[0] ?? '')
  if (!first.host) return null

  const options: Record<string, string> = {}
  if (hosts.length > 1) options.hosts = hosts.join(',')
  if (rawScheme!.toLowerCase() === 'mongodb+srv') options.srv = 'true'

  let tls = scheme.tls
  let database = rawPath ? decode(rawPath) : undefined

  for (const pair of (rawQuery ?? '').split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const key = decode(eq === -1 ? pair : pair.slice(0, eq))
    const value = eq === -1 ? '' : decode(pair.slice(eq + 1))
    if (['ssl', 'tls', 'useSSL'].includes(key)) tls = value !== 'false' && value !== '0'
    else options[key] = value
  }

  if (scheme.engine === 'rabbitmq') {
    // The default vhost "/" is written as an empty path or "%2f".
    database = database === undefined || database === '' ? '/' : database
  }
  if (scheme.engine === 'redis' && database === '') database = undefined

  return {
    engine: scheme.engine,
    host: first.host,
    port: first.port ?? scheme.port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(database ? { database } : {}),
    tls,
    options,
  }
}

/** Applies a parsed URI to a draft, keeping everything the URI doesn't say. */
export function applyParsedUri(
  draft: ConnectionConfig,
  parsed: ParsedConnectionUri,
): ConnectionConfig {
  const next: ConnectionConfig = {
    ...draft,
    engine: parsed.engine,
    host: parsed.host,
    port: parsed.port,
    tls: { ...draft.tls, enabled: parsed.tls },
    options: { ...draft.options, ...parsed.options },
  }
  if (parsed.username !== undefined) next.username = parsed.username
  if (parsed.database !== undefined) next.database = parsed.database
  return next
}
