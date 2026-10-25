import type { ConnectContext, Driver, DriverDescriptor, DriverSession } from '@shared/driver'
import { RedisClientApi } from './api'
import { send, str } from './calls'
import { openConnection } from './client'
import { RedisFailure, describeRedisError } from './errors'
import { parseInfo, toInfo } from './info'
import { RedisSession } from './session'

export const redisDescriptor: DriverDescriptor = {
  engine: 'redis',
  displayName: 'Redis',
  defaultPort: 6379,
  uriSchemes: ['redis', 'rediss', 'valkey'],
  capabilities: ['keyvalue', 'edit', 'search'],
  tlsMode: 'direct',
  implemented: true,
}

export const redisDriver: Driver = {
  descriptor: redisDescriptor,

  async connect(context: ConnectContext): Promise<DriverSession> {
    const conn = await openConnection(context)
    try {
      // Connecting only proves something is listening. A command is what checks the login.
      try {
        await send(conn.base, 'PING')
      } catch (error) {
        const described = describeRedisError(error, conn.where)
        // A user that may not PING still has a working connection.
        if (!(described instanceof RedisFailure) || described.code !== 'FORBIDDEN') throw described
      }
      let version = 'unknown'
      try {
        version = toInfo(parseInfo(str(await send(conn.base, 'INFO', 'server'))), null).version
      } catch {
        // INFO may be forbidden; the server is usable without knowing its version.
      }
      const api = new RedisClientApi(conn)
      return new RedisSession(conn, api, api, {
        serverVersion: version,
        currentDatabase: String(conn.setup.db),
        readOnly: context.readOnly === true,
        // Redis has no read-only session; the app guards every change before it is sent.
        readOnlyEnforcedByServer: false,
      })
    } catch (error) {
      conn.close()
      throw describeRedisError(error, conn.where)
    }
  },
}
