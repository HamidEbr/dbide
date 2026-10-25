import { readFile } from 'node:fs/promises'
import type { MongoClientOptions } from 'mongodb'
import type { ConnectContext } from '@shared/driver'

/**
 * Connection string options that are passed through as the user wrote them. Everything else a pasted
 * URI carried is ignored rather than guessed at. The driver parses and checks the values itself.
 */
const PASS_THROUGH = [
  'replicaSet',
  'authSource',
  'authMechanism',
  'authMechanismProperties',
  'readPreference',
  'readPreferenceTags',
  'maxStalenessSeconds',
  'directConnection',
  'loadBalanced',
  'retryWrites',
  'retryReads',
  'w',
  'wtimeoutMS',
  'journal',
  'compressors',
  'appName',
  'srvServiceName',
  'srvMaxHosts',
  'tlsInsecure',
  'serverSelectionTimeoutMS',
  'connectTimeoutMS',
  'socketTimeoutMS',
] as const

const hostPort = (host: string, port: number): string =>
  `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`

export interface ClientSetup {
  uri: string
  options: MongoClientOptions
}

/** The connection string and client options for a saved connection. */
export async function buildClientSetup(context: ConnectContext): Promise<ClientSetup> {
  const { config, secrets, endpoint } = context
  const srv = config.options.srv === 'true'
  const hosts = config.options.hosts?.trim() || hostPort(endpoint.host, endpoint.port)

  const query = new URLSearchParams()
  for (const key of PASS_THROUGH) {
    const value = config.options[key]
    if (value !== undefined && value !== '') query.set(key, value)
  }
  // Like a connection string, the default database is where logins are checked unless told otherwise.
  if (config.username && !query.has('authSource') && config.database) {
    query.set('authSource', config.database)
  }

  const uri = `${srv ? `mongodb+srv://${config.host}` : `mongodb://${hosts}`}/?${query.toString()}`

  const options: MongoClientOptions = {
    appName: 'DBIDE',
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    maxPoolSize: 4,
    // Numbers keep their BSON type (Int32, Double, Int64) so a document reads back exactly as stored.
    promoteValues: false,
    ...(config.username
      ? {
          auth: {
            username: config.username,
            ...(secrets.password ? { password: secrets.password } : {}),
          },
        }
      : {}),
  }

  // `mongodb+srv` turns TLS on by itself; a plain URI needs it asked for.
  if (config.tls.enabled) {
    const [ca, cert, key] = await Promise.all([
      config.tls.caPath ? readFile(config.tls.caPath) : undefined,
      config.tls.certPath ? readFile(config.tls.certPath) : undefined,
      config.tls.keyPath ? readFile(config.tls.keyPath) : undefined,
    ])
    Object.assign(options, {
      tls: true,
      ...(config.tls.allowInvalidCertificates
        ? { tlsAllowInvalidCertificates: true, tlsAllowInvalidHostnames: true }
        : {}),
      ...(ca ? { ca } : {}),
      ...(cert ? { cert } : {}),
      ...(key ? { key } : {}),
    })
  } else if (!srv) {
    options.tls = false
  }

  return { uri, options }
}
