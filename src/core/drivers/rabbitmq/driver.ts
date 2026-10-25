import { readFile } from 'node:fs/promises'
import type { ConnectContext, Driver, DriverDescriptor, DriverSession } from '@shared/driver'
import { ManagementBroker } from './broker'
import { ManagementError } from './errors'
import { ManagementClient } from './http'
import { raw, toUser } from './map'
import { RabbitSession, vhostOf } from './session'
import { managementBase } from './url'

export const rabbitmqDescriptor: DriverDescriptor = {
  engine: 'rabbitmq',
  displayName: 'RabbitMQ',
  defaultPort: 5672,
  uriSchemes: ['amqp', 'amqps'],
  capabilities: ['messaging', 'search'],
  tlsMode: 'direct',
  implemented: true,
}

/** A login that can use the management API has at least one of these tags. */
const API_TAGS = ['management', 'policymaker', 'monitoring', 'administrator']

export const rabbitmqDriver: Driver = {
  descriptor: rabbitmqDescriptor,

  // Everything goes through the management API, so that is what the connection test should reach.
  testEndpoint(config) {
    const base = managementBase(config)
    return {
      host: base.hostname.replace(/^\[|\]$/g, ''),
      port: Number(base.port) || (base.protocol === 'https:' ? 443 : 80),
      tls: base.protocol === 'https:',
    }
  },

  async connect(context: ConnectContext): Promise<DriverSession> {
    const { config, secrets, signal } = context
    const [ca, cert, key] = await Promise.all([
      config.tls.enabled && config.tls.caPath ? readFile(config.tls.caPath) : undefined,
      config.tls.enabled && config.tls.certPath ? readFile(config.tls.certPath) : undefined,
      config.tls.enabled && config.tls.keyPath ? readFile(config.tls.keyPath) : undefined,
    ])
    const client = new ManagementClient({
      baseUrl: managementBase(config),
      username: config.username || 'guest',
      password: secrets.password ?? (config.username ? '' : 'guest'),
      ...(ca ? { ca } : {}),
      ...(cert ? { cert } : {}),
      ...(key ? { key } : {}),
      allowInvalidCertificates: config.tls.enabled && config.tls.allowInvalidCertificates,
    })

    try {
      // The first call is what checks the login, and shows whether the management API is there at all.
      const whoami = raw(await client.get<unknown>('whoami', { signal, what: 'The user' }))
      const user = toUser(whoami)
      if (user.tags.length > 0 && !user.tags.some((tag) => API_TAGS.includes(tag))) {
        throw new ManagementError(
          `${user.name} has no management tag, so RabbitMQ won’t let it use the management API. Give the user the “management” tag (rabbitmqctl set_user_tags ${user.name} management).`,
          'FORBIDDEN',
          403,
        )
      }
      const overview = raw(await client.get<unknown>('overview', { signal, what: 'The overview' }))
      const broker = new ManagementBroker(client)
      return new RabbitSession(
        client,
        broker,
        {
          serverVersion:
            typeof overview.rabbitmq_version === 'string' ? overview.rabbitmq_version : 'unknown',
          currentDatabase: vhostOf(config.database),
          readOnly: context.readOnly === true,
          // RabbitMQ has no read-only session; the app guards every change before it asks.
          readOnlyEnforcedByServer: false,
        },
        vhostOf(config.database),
      )
    } catch (error) {
      client.close()
      throw error
    }
  },
}
