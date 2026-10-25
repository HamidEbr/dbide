import { MongoClient, type Document } from 'mongodb'
import type { ConnectContext, Driver, DriverDescriptor, DriverSession } from '@shared/driver'
import { MongoError } from './errors'
import { buildClientSetup } from './options'
import { MongoSession } from './session'

export const mongoDescriptor: DriverDescriptor = {
  engine: 'mongodb',
  displayName: 'MongoDB',
  defaultPort: 27017,
  uriSchemes: ['mongodb', 'mongodb+srv'],
  capabilities: ['documents', 'edit', 'explain', 'search'],
  tlsMode: 'direct',
  implemented: true,
}

/** Rejects when the signal aborts, so a connection attempt that hangs can still be cancelled. */
function whenAborted(signal: AbortSignal): { promise: Promise<never>; stop: () => void } {
  let listener: (() => void) | undefined
  const promise = new Promise<never>((_, reject) => {
    listener = () => reject(new DOMException('The connection attempt was cancelled', 'AbortError'))
    if (signal.aborted) listener()
    else signal.addEventListener('abort', listener, { once: true })
  })
  return { promise, stop: () => listener && signal.removeEventListener('abort', listener) }
}

export const mongoDriver: Driver = {
  descriptor: mongoDescriptor,

  async connect(context: ConnectContext): Promise<DriverSession> {
    const { uri, options } = await buildClientSetup(context)
    const client = new MongoClient(uri, options)
    const aborted = whenAborted(context.signal)
    // A rejected race leaves the loser running; swallow its late failure.
    aborted.promise.catch(() => undefined)

    try {
      const opened = (async () => {
        await client.connect()
        const admin = client.db('admin')
        // The first command is what checks the login; connecting alone does not.
        await admin.command({ ping: 1 })
        const build = (await admin.command({ buildInfo: 1 }, {
          promoteValues: true,
        } as never)) as Document
        const hello = (await admin
          .command({ hello: 1 }, { promoteValues: true } as never)
          .catch(() =>
            admin.command({ isMaster: 1 }, { promoteValues: true } as never),
          )) as Document
        return { version: String(build.version ?? ''), hello }
      })()
      const { version, hello } = await Promise.race([opened, aborted.promise])

      const transactions = hello.setName !== undefined || hello.msg === 'isdbgrid'
      return new MongoSession(
        client,
        {
          serverVersion: version,
          currentDatabase: context.config.database || null,
          readOnly: context.readOnly === true,
          // MongoDB has no read-only session. The session refuses writes itself; a login with only the
          // read role is the only guarantee the server can give.
          readOnlyEnforcedByServer: false,
        },
        {
          ...(context.config.database ? { defaultDatabase: context.config.database } : {}),
          transactions,
        },
      )
    } catch (error) {
      await client.close(true).catch(() => undefined)
      if (context.signal.aborted) throw error
      throw new MongoError(error)
    } finally {
      aborted.stop()
    }
  },
}
