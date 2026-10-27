import type { EngineKind } from './connection'
import type { Environment } from './environment'

/**
 * Reading DBeaver's `data-sources.json`: which connections it holds and how they map onto DBIDE's. Passwords are
 * not in this file, and the parts that read them stay in the core.
 */

/** One DBeaver connection that DBIDE can open. */
export interface DbeaverConnection {
  /** DBeaver's id for it, which the import names to say which ones to bring over. */
  sourceId: string
  name: string
  engine: EngineKind
  host: string
  port: number
  database: string
  username: string
  folder: string
  environment: Environment
  tls: boolean
  ssh: {
    host: string
    port: number
    username: string
    auth: 'password' | 'key' | 'agent'
    keyPath: string
  } | null
  /** Whether DBeaver saved a password for it (not the password itself). */
  hasPassword: boolean
}

/** A DBeaver connection of a kind DBIDE doesn't have a driver for. */
export interface DbeaverSkipped {
  name: string
  driver: string
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const DEFAULT_PORTS: Record<EngineKind, number> = {
  mysql: 3306,
  postgresql: 5432,
  mssql: 1433,
  mongodb: 27017,
  redis: 6379,
  rabbitmq: 5672,
}

/** The DBIDE engine for a DBeaver driver id such as `mysql8` or `mariaDB`, or null when there is none. */
export function engineOf(provider: string, driver: string): EngineKind | null {
  const id = `${provider} ${driver}`.toLowerCase()
  if (/mysql|mariadb/.test(id)) return 'mysql'
  if (/postgres|redshift|cockroach/.test(id)) return 'postgresql'
  if (/sqlserver|mssql|sql_server|jtds/.test(id)) return 'mssql'
  if (/mongo/.test(id)) return 'mongodb'
  if (/redis/.test(id)) return 'redis'
  return null
}

const ENVIRONMENT: Record<string, Environment> = { dev: 'dev', test: 'staging', prod: 'prod' }

/** The connections in one `data-sources.json`, and the ones DBIDE can't open. */
export function parseDataSources(source: string): {
  connections: DbeaverConnection[]
  skipped: DbeaverSkipped[]
} | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return null
  }
  if (!isObject(parsed) || !isObject(parsed.connections)) return null
  const connections: DbeaverConnection[] = []
  const skipped: DbeaverSkipped[] = []
  for (const [sourceId, raw] of Object.entries(parsed.connections)) {
    if (!isObject(raw)) continue
    const name = text(raw.name) || sourceId
    const driver = text(raw.driver)
    const engine = engineOf(text(raw.provider), driver)
    if (!engine) {
      skipped.push({ name, driver: driver || text(raw.provider) || 'unknown' })
      continue
    }
    const config = isObject(raw.configuration) ? raw.configuration : {}
    const handlers = isObject(config.handlers) ? config.handlers : {}
    const ssh = isObject(handlers.ssh_tunnel) ? handlers.ssh_tunnel : null
    const sshProps = ssh && isObject(ssh.properties) ? ssh.properties : {}
    const ssl = isObject(handlers.ssl) ? handlers.ssl : null
    const authType = text(sshProps.authType).toUpperCase()
    const port = Number(text(config.port) || config.port)
    connections.push({
      sourceId,
      name,
      engine,
      host: text(config.host) || 'localhost',
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORTS[engine],
      database: text(config.database),
      username: '',
      folder: text(raw.folder),
      environment: ENVIRONMENT[text(config.type)] ?? 'dev',
      tls: ssl?.enabled === true,
      ssh:
        ssh?.enabled === true
          ? {
              host: text(sshProps.host),
              port: Number(text(sshProps.port) || sshProps.port) || 22,
              username: '',
              auth: authType === 'PUBLIC_KEY' ? 'key' : authType === 'AGENT' ? 'agent' : 'password',
              keyPath: text(sshProps.keyPath),
            }
          : null,
      hasPassword: raw['save-password'] === true,
    })
  }
  return { connections, skipped }
}
