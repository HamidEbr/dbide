import { readFile } from 'node:fs/promises'
import { createConnection, type ConnectionOptions } from 'mysql2'
import type { ConnectContext, Driver, DriverDescriptor, DriverSession } from '@shared/driver'
import { MysqlError, UnsupportedServerError } from './errors'
import { setServerReadOnly } from './read-only'
import { MysqlSession } from './session'
import { parseServerVersion, unsupportedReason } from './version'

export const mysqlDescriptor: DriverDescriptor = {
  engine: 'mysql',
  displayName: 'MySQL',
  defaultPort: 3306,
  uriSchemes: ['mysql', 'mariadb'],
  capabilities: ['tabular', 'edit', 'explain', 'search'],
  tlsMode: 'upgrade',
  implemented: true,
}

/**
 * A client that stalls (the user is reading the first page) must not make the server give up on
 * a large result. The default of 60 seconds would abort "load more" a minute later.
 */
const NET_WRITE_TIMEOUT_SECONDS = 3600

async function buildOptions(context: ConnectContext): Promise<ConnectionOptions> {
  const { config, secrets, endpoint } = context
  let ssl: ConnectionOptions['ssl']
  if (config.tls.enabled) {
    const [ca, cert, key] = await Promise.all([
      config.tls.caPath ? readFile(config.tls.caPath) : undefined,
      config.tls.certPath ? readFile(config.tls.certPath) : undefined,
      config.tls.keyPath ? readFile(config.tls.keyPath) : undefined,
    ])
    ssl = {
      rejectUnauthorized: !config.tls.allowInvalidCertificates,
      ...(ca ? { ca } : {}),
      ...(cert ? { cert } : {}),
      ...(key ? { key } : {}),
    }
  }

  return {
    host: endpoint.host,
    port: endpoint.port,
    user: config.username || 'root',
    ...(secrets.password ? { password: secrets.password } : {}),
    ...(config.database ? { database: config.database } : {}),
    ...(ssl ? { ssl } : {}),
    charset: 'utf8mb4',
    connectTimeout: 10_000,
    // Values arrive exactly as MySQL writes them: no time zone shifts, no lost precision.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    jsonStrings: true,
    // The editor splits scripts itself, so each statement gets its own result tab.
    multipleStatements: false,
    rowsAsArray: true,
  }
}

function open(
  options: ConnectionOptions,
  signal: AbortSignal,
): Promise<ReturnType<typeof createConnection>> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const conn = createConnection(options)
    const onAbort = (): void => {
      conn.destroy()
      reject(new DOMException('The connection attempt was cancelled', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    conn.connect((error) => {
      signal.removeEventListener('abort', onAbort)
      if (error) {
        conn.destroy()
        reject(new MysqlError(error))
      } else {
        resolve(conn)
      }
    })
  })
}

function simpleQuery(conn: ReturnType<typeof createConnection>, sql: string): Promise<unknown[][]> {
  return new Promise((resolve, reject) => {
    conn.query({ sql, rowsAsArray: true }, (error, rows) => {
      if (error) reject(new MysqlError(error))
      else resolve(rows as unknown as unknown[][])
    })
  })
}

export const mysqlDriver: Driver = {
  descriptor: mysqlDescriptor,

  async connect(context: ConnectContext): Promise<DriverSession> {
    const options = await buildOptions(context)
    const conn = await open(options, context.signal)
    try {
      const [[version, database] = []] = await simpleQuery(conn, 'SELECT VERSION(), DATABASE()')
      const tooOld = unsupportedReason(parseServerVersion(String(version ?? '')))
      if (tooOld) throw new UnsupportedServerError(tooOld)
      // Best effort: a server that refuses the setting still works, just with its own timeout.
      await simpleQuery(conn, `SET SESSION net_write_timeout = ${NET_WRITE_TIMEOUT_SECONDS}`).catch(
        () => undefined,
      )
      // A server without read-only transactions (MySQL before 5.6.5) can't be told; the session then
      // refuses writes itself.
      const enforced = context.readOnly
        ? await setServerReadOnly((sql) => simpleQuery(conn, sql), true)
        : true

      return new MysqlSession(conn, options, {
        serverVersion: String(version ?? ''),
        currentDatabase: database ? String(database) : null,
        readOnly: context.readOnly === true,
        readOnlyEnforcedByServer: enforced,
      })
    } catch (error) {
      conn.destroy()
      throw error
    }
  },
}
