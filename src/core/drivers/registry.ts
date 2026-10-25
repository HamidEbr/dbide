import type { EngineKind } from '@shared/connection'
import type { Driver, DriverDescriptor } from '@shared/driver'
import { RpcError } from '@shared/rpc'
import { demoDriver } from './demo/driver'
import { mongoDriver } from './mongodb/driver'
import { mysqlDriver } from './mysql/driver'
import { rabbitmqDriver } from './rabbitmq/driver'
import { redisDriver } from './redis/driver'

export class DriverRegistry {
  private readonly byEngine = new Map<EngineKind, Driver>()

  constructor(drivers: readonly Driver[]) {
    for (const driver of drivers) this.byEngine.set(driver.descriptor.engine, driver)
  }

  get(engine: EngineKind): Driver {
    const driver = this.byEngine.get(engine)
    if (!driver) throw new RpcError('NO_DRIVER', `No driver registered for ${engine}`)
    return driver
  }

  descriptors(): DriverDescriptor[] {
    return [...this.byEngine.values()].map((driver) => driver.descriptor)
  }
}

export function createDefaultRegistry(): DriverRegistry {
  return new DriverRegistry([
    // The demo engine stands in for MySQL when no server is around (smoke test, UI work).
    process.env.DBIDE_DEMO_ENGINE === '1' ? demoDriver : mysqlDriver,
    mongoDriver,
    redisDriver,
    rabbitmqDriver,
  ])
}
