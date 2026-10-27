import { describe, expect, it } from 'vitest'
import { newConnectionDraft } from './connection'
import { applyParsedUri, parseConnectionUri } from './uri'

describe('parseConnectionUri', () => {
  it('parses a full MySQL URI', () => {
    expect(parseConnectionUri('mysql://root:s3cret@db.internal:3306/shop')).toEqual({
      engine: 'mysql',
      host: 'db.internal',
      port: 3306,
      username: 'root',
      password: 's3cret',
      database: 'shop',
      tls: false,
      options: {},
    })
  })

  it('treats MariaDB as MySQL', () => {
    expect(parseConnectionUri('mariadb://h')?.engine).toBe('mysql')
  })

  it('keeps an unencoded @ inside the password', () => {
    const parsed = parseConnectionUri('mysql://u:p@ss@host/db')
    expect(parsed).toMatchObject({ username: 'u', password: 'p@ss', host: 'host' })
  })

  it('decodes percent-encoded credentials and database names', () => {
    const parsed = parseConnectionUri('mysql://us%40er:p%40ss%2Fx@h/my%20db')
    expect(parsed).toMatchObject({ username: 'us@er', password: 'p@ss/x', database: 'my db' })
  })

  it('applies the engine default port', () => {
    expect(parseConnectionUri('mysql://h')?.port).toBe(3306)
    expect(parseConnectionUri('mongodb://h')?.port).toBe(27017)
    expect(parseConnectionUri('redis://h')?.port).toBe(6379)
    expect(parseConnectionUri('amqp://h')?.port).toBe(5672)
    expect(parseConnectionUri('amqps://h')?.port).toBe(5671)
  })

  it('handles several Mongo hosts and options', () => {
    const parsed = parseConnectionUri(
      'mongodb://u:p@a:27017,b:27018/app?replicaSet=rs0&authSource=admin',
    )
    expect(parsed).toMatchObject({ host: 'a', port: 27017, database: 'app' })
    expect(parsed?.options).toEqual({
      hosts: 'a:27017,b:27018',
      replicaSet: 'rs0',
      authSource: 'admin',
    })
  })

  it('marks mongodb+srv as TLS with the srv option', () => {
    const parsed = parseConnectionUri('mongodb+srv://u:p@cluster0.example.net/app')
    expect(parsed).toMatchObject({ engine: 'mongodb', tls: true, host: 'cluster0.example.net' })
    expect(parsed?.options.srv).toBe('true')
  })

  it('reads a Redis password without a username and the DB index', () => {
    const parsed = parseConnectionUri('redis://:pw@cache:6380/2')
    expect(parsed).toMatchObject({ host: 'cache', port: 6380, password: 'pw', database: '2' })
    expect(parsed?.username).toBeUndefined()
  })

  it('uses TLS for rediss and amqps', () => {
    expect(parseConnectionUri('rediss://h')?.tls).toBe(true)
    expect(parseConnectionUri('amqps://h')?.tls).toBe(true)
  })

  it('reads RabbitMQ vhosts, including the default one', () => {
    expect(parseConnectionUri('amqp://guest:guest@mq/%2f')?.database).toBe('/')
    expect(parseConnectionUri('amqp://mq')?.database).toBe('/')
    expect(parseConnectionUri('amqps://u:p@mq/orders')?.database).toBe('orders')
  })

  it('parses bracketed IPv6 hosts', () => {
    expect(parseConnectionUri('redis://[::1]:6380')).toMatchObject({ host: '::1', port: 6380 })
    expect(parseConnectionUri('redis://[::1]')).toMatchObject({ host: '::1', port: 6379 })
  })

  it('lets ssl and tls query parameters decide TLS', () => {
    expect(parseConnectionUri('mysql://h/db?ssl=true')?.tls).toBe(true)
    expect(parseConnectionUri('rediss://h?tls=false')?.tls).toBe(false)
  })

  it('trims surrounding whitespace', () => {
    expect(parseConnectionUri('  redis://h  ')?.host).toBe('h')
  })

  it.each(['', 'hello', 'http://example.com', 'mysql://', 'oracle://h/db'])(
    'rejects %j',
    (input) => {
      expect(parseConnectionUri(input)).toBeNull()
    },
  )
})

describe('applyParsedUri', () => {
  it('overwrites what the URI says and keeps everything else', () => {
    const draft = {
      ...newConnectionDraft('mysql', 'id-1'),
      name: 'Orders',
      environment: 'prod' as const,
    }
    const parsed = parseConnectionUri('redis://:pw@cache.internal:6380/3')!
    const next = applyParsedUri(draft, parsed)
    expect(next).toMatchObject({
      id: 'id-1',
      name: 'Orders',
      environment: 'prod',
      engine: 'redis',
      host: 'cache.internal',
      port: 6380,
      database: '3',
    })
    expect(next.tls.enabled).toBe(false)
  })
})
