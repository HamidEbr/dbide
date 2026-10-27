import { describe, expect, it } from 'vitest'
import { engineOf, parseDataSources } from './dbeaver'

const file = JSON.stringify({
  connections: {
    'mysql8-1': {
      provider: 'mysql',
      driver: 'mysql8',
      name: 'Shop prod',
      'save-password': true,
      folder: 'Work',
      configuration: {
        host: 'db.example.com',
        port: '3307',
        database: 'shop',
        type: 'prod',
        handlers: {
          ssh_tunnel: {
            enabled: true,
            properties: { host: 'bastion', port: '2222', authType: 'PUBLIC_KEY', keyPath: '/k/id' },
          },
          ssl: { enabled: true },
        },
      },
    },
    'redis-1': {
      provider: 'redis',
      driver: 'redis',
      name: 'Cache',
      configuration: { type: 'test' },
    },
    'pg-1': {
      provider: 'oracle',
      driver: 'oracle-thin',
      name: 'Warehouse',
      configuration: {},
    },
    broken: 'nope',
  },
})

describe('parseDataSources', () => {
  it('reads the connections DBIDE can open, and lists the rest', () => {
    const parsed = parseDataSources(file)!
    expect(parsed.skipped).toEqual([{ name: 'Warehouse', driver: 'oracle-thin' }])
    const [shop, cache] = parsed.connections
    expect(shop).toMatchObject({
      sourceId: 'mysql8-1',
      name: 'Shop prod',
      engine: 'mysql',
      host: 'db.example.com',
      port: 3307,
      database: 'shop',
      folder: 'Work',
      environment: 'prod',
      tls: true,
      hasPassword: true,
      ssh: { host: 'bastion', port: 2222, auth: 'key', keyPath: '/k/id' },
    })
    expect(cache).toMatchObject({
      engine: 'redis',
      host: 'localhost',
      port: 6379,
      environment: 'staging',
      ssh: null,
    })
  })

  it('is null for text that is not a DBeaver file', () => {
    expect(parseDataSources('nope')).toBeNull()
    expect(parseDataSources('{"a":1}')).toBeNull()
  })

  it('maps driver ids to engines', () => {
    expect(engineOf('mysql', 'mariaDB')).toBe('mysql')
    expect(engineOf('mongodb', 'mongo')).toBe('mongodb')
    expect(engineOf('jdbc', 'oracle')).toBeNull()
  })
})
