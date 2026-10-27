import { readFile } from 'node:fs/promises'
import { Client, type ClientConfig } from 'pg'
import type { ConnectContext, Driver, DriverDescriptor, DriverSession } from '@shared/driver'
import { PgError } from './errors'
import { PgSession } from './session'
import { typeParsers } from './types'

export const postgresDescriptor: DriverDescriptor = {
  engine: 'postgresql',
  displayName: 'PostgreSQL',
  defaultPort: 5432,
  uriSchemes: ['postgres', 'postgresql'],
  capabilities: ['tabular', 'edit', 'explain', 'search'],
  tlsMode: 'upgrade',
  implemented: true,
}

async function buildConfig(context: ConnectContext): Promise<ClientConfig> {
  const { config, secrets, endpoint } = context
  let ssl: ClientConfig['ssl']
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
    user: config.username || 'postgres',
    ...(secrets.password ? { password: secrets.password } : {}),
    database: config.database || 'postgres',
    ...(ssl ? { ssl } : {}),
    connectionTimeoutMillis: 10_000,
    application_name: 'DBIDE',
    // Values arrive as the text the server wrote.
    types: typeParsers,
  }
}

export const postgresDriver: Driver = {
  descriptor: postgresDescriptor,

  async connect(context: ConnectContext): Promise<DriverSession> {
    const options = await buildConfig(context)
    const client = new Client(options)
    const onAbort = (): void => void client.end().catch(() => undefined)
    context.signal.addEventListener('abort', onAbort, { once: true })
    try {
      context.signal.throwIfAborted()
      await client.connect()
      const result = await client.query({
        text: 'SELECT version(), current_schema()',
        rowMode: 'array',
      })
      const [version, schema] = (result.rows[0] ?? []) as unknown[]
      if (context.readOnly) {
        await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
      }
      return new PgSession(client, options, {
        serverVersion: String(version ?? ''),
        currentDatabase: schema ? String(schema) : 'public',
        readOnly: context.readOnly === true,
        readOnlyEnforcedByServer: true,
      })
    } catch (error) {
      await client.end().catch(() => undefined)
      if (context.signal.aborted) throw error
      throw new PgError(error)
    } finally {
      context.signal.removeEventListener('abort', onAbort)
    }
  },
}
