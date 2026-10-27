import { readFile } from 'node:fs/promises'
import sql from 'mssql'
import type { ConnectContext, Driver, DriverDescriptor, DriverSession } from '@shared/driver'
import { MssqlError } from './errors'
import { MssqlSession } from './session'

export const mssqlDescriptor: DriverDescriptor = {
  engine: 'mssql',
  displayName: 'SQL Server',
  defaultPort: 1433,
  uriSchemes: ['sqlserver', 'mssql'],
  capabilities: ['tabular', 'edit', 'search'],
  tlsMode: 'upgrade',
  implemented: true,
}

async function buildConfig(context: ConnectContext): Promise<sql.config> {
  const { config, secrets, endpoint } = context
  const ca = config.tls.enabled && config.tls.caPath ? await readFile(config.tls.caPath) : undefined
  return {
    server: endpoint.host,
    port: endpoint.port,
    user: config.username || 'sa',
    ...(secrets.password ? { password: secrets.password } : {}),
    ...(config.database ? { database: config.database } : {}),
    connectionTimeout: 10_000,
    // A long query must not be cut off by the driver.
    requestTimeout: 0,
    // One connection: a transaction and the statements inside it have to share it.
    pool: { max: 1, min: 1, idleTimeoutMillis: 2_147_483_647 },
    options: {
      encrypt: config.tls.enabled,
      trustServerCertificate: config.tls.enabled ? config.tls.allowInvalidCertificates : true,
      appName: 'DBIDE',
      useUTC: true,
      enableArithAbort: true,
      ...(ca ? { cryptoCredentialsDetails: { ca } } : {}),
    },
  }
}

export const mssqlDriver: Driver = {
  descriptor: mssqlDescriptor,

  async connect(context: ConnectContext): Promise<DriverSession> {
    const pool = new sql.ConnectionPool(await buildConfig(context))
    const onAbort = (): void => void pool.close().catch(() => undefined)
    context.signal.addEventListener('abort', onAbort, { once: true })
    try {
      context.signal.throwIfAborted()
      await pool.connect()
      const request = pool.request()
      request.arrayRowMode = true
      const result = await request.query(
        `SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(50)),
                CAST(SERVERPROPERTY('Edition') AS nvarchar(100)), SCHEMA_NAME()`,
      )
      const [version, edition, schema] = (result.recordset?.[0] ?? []) as unknown as unknown[]
      return new MssqlSession(pool, {
        serverVersion: `${String(version ?? '')} ${String(edition ?? '')}`.trim(),
        currentDatabase: schema ? String(schema) : 'dbo',
        readOnly: context.readOnly === true,
        readOnlyEnforcedByServer: false,
      })
    } catch (error) {
      await pool.close().catch(() => undefined)
      if (context.signal.aborted) throw error
      throw new MssqlError(error)
    } finally {
      context.signal.removeEventListener('abort', onAbort)
    }
  },
}
