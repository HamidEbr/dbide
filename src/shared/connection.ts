import type { Environment } from './environment'

export type EngineKind = 'mysql' | 'postgresql' | 'mssql' | 'mongodb' | 'redis' | 'rabbitmq'

export const ENGINES: readonly EngineKind[] = [
  'mysql',
  'postgresql',
  'mssql',
  'mongodb',
  'redis',
  'rabbitmq',
]

/** The engines that speak SQL, and so share the script editor, the results grid and the SQL tools. */
export const SQL_ENGINES: readonly EngineKind[] = ['mysql', 'postgresql', 'mssql']
export const isSqlEngine = (engine: EngineKind): boolean => SQL_ENGINES.includes(engine)

export interface TlsConfig {
  enabled: boolean
  caPath?: string
  certPath?: string
  keyPath?: string
  /** Turn off certificate verification. Meant for local development only. */
  allowInvalidCertificates: boolean
}

export type SshAuth = 'password' | 'key' | 'agent'

export interface SshConfig {
  enabled: boolean
  host: string
  port: number
  username: string
  auth: SshAuth
  privateKeyPath?: string
  /** Name of a host in ~/.ssh/config to read the settings from. */
  configHost?: string
  jumpHost?: string
}

/** A saved connection. Secrets never live here; they are referenced by key in the secret store. */
export interface ConnectionConfig {
  id: string
  name: string
  engine: EngineKind
  environment: Environment
  folder?: string
  host: string
  port: number
  username?: string
  /** MySQL schema, Mongo database, Redis DB index or RabbitMQ vhost. */
  database?: string
  tls: TlsConfig
  ssh?: SshConfig
  /** Engine specific extras such as `replicaSet`, `srv` or `hosts`. */
  options: Record<string, string>
}

export type ConnectionSecrets = Partial<
  Record<'password' | 'sshPassword' | 'sshPassphrase', string>
>

export type SecretName = keyof ConnectionSecrets

export function secretKey(connectionId: string, name: SecretName): string {
  return `conn:${connectionId}:${name}`
}

export function emptyTls(): TlsConfig {
  return { enabled: false, allowInvalidCertificates: false }
}

export function newConnectionDraft(engine: EngineKind, id: string): ConnectionConfig {
  const defaults: Record<EngineKind, { port: number; database?: string; username?: string }> = {
    mysql: { port: 3306, username: 'root' },
    postgresql: { port: 5432, username: 'postgres', database: 'postgres' },
    mssql: { port: 1433, username: 'sa' },
    mongodb: { port: 27017 },
    redis: { port: 6379, database: '0' },
    rabbitmq: { port: 5672, database: '/', username: 'guest' },
  }
  const d = defaults[engine]
  return {
    id,
    name: '',
    engine,
    environment: 'local',
    host: 'localhost',
    port: d.port,
    ...(d.username ? { username: d.username } : {}),
    ...(d.database ? { database: d.database } : {}),
    tls: emptyTls(),
    options: {},
  }
}

/** What the navigator needs about a connection. Safe to render and to log. */
export interface ConnectionSummary {
  id: string
  name: string
  engine: EngineKind
  environment: Environment
  folder?: string
  host: string
  port: number
}

export function summarize(config: ConnectionConfig): ConnectionSummary {
  return {
    id: config.id,
    name: config.name,
    engine: config.engine,
    environment: config.environment,
    ...(config.folder ? { folder: config.folder } : {}),
    host: config.host,
    port: config.port,
  }
}

export type TestStepId = 'ssh' | 'dns' | 'tcp' | 'tls' | 'auth'
export type TestStepStatus = 'ok' | 'failed' | 'skipped'

export interface TestStep {
  id: TestStepId
  label: string
  status: TestStepStatus
  durationMs: number
  detail?: string
}
