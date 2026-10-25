import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { newConnectionDraft, type ConnectionConfig } from '@shared/connection'
import type { ConnectContext } from '@shared/driver'
import { buildClientSetup } from './options'

const context = (overrides: Partial<ConnectionConfig> = {}, password?: string): ConnectContext => {
  const config: ConnectionConfig = { ...newConnectionDraft('mongodb', 'm'), ...overrides }
  return {
    config,
    secrets: password ? { password } : {},
    endpoint: { host: config.host, port: config.port },
    signal: new AbortController().signal,
  }
}

describe('buildClientSetup', () => {
  it('builds a plain connection string with a short timeout and typed values kept', async () => {
    const { uri, options } = await buildClientSetup(context({ host: 'db.internal', port: 27018 }))
    expect(uri).toBe('mongodb://db.internal:27018/?')
    expect(options).toMatchObject({
      appName: 'DBIDE',
      serverSelectionTimeoutMS: 10_000,
      promoteValues: false,
      tls: false,
    })
    expect(options.auth).toBeUndefined()
  })

  it('keeps the login out of the connection string', async () => {
    const { uri, options } = await buildClientSetup(
      context({ username: 'ada@corp', host: 'h' }, 'p@ss/word:1'),
    )
    expect(uri).not.toContain('ada')
    expect(uri).not.toContain('p@ss')
    expect(options.auth).toEqual({ username: 'ada@corp', password: 'p@ss/word:1' })
  })

  it('checks the login in the default database, as a connection string does, unless told otherwise', async () => {
    expect((await buildClientSetup(context({ username: 'u', database: 'shop' }))).uri).toContain(
      'authSource=shop',
    )
    expect(
      (
        await buildClientSetup(
          context({ username: 'u', database: 'shop', options: { authSource: 'admin' } }),
        )
      ).uri,
    ).toContain('authSource=admin')
    expect((await buildClientSetup(context({ database: 'shop' }))).uri).not.toContain('authSource')
  })

  it('passes the options it knows through, and leaves the rest', async () => {
    const { uri } = await buildClientSetup(
      context({
        options: {
          replicaSet: 'rs0',
          readPreference: 'secondaryPreferred',
          directConnection: 'true',
          hosts: 'a:1,b:2',
          srv: 'false',
          nonsense: 'x',
          appName: '',
        },
      }),
    )
    const query = new URLSearchParams(uri.split('?')[1])
    expect(query.get('replicaSet')).toBe('rs0')
    expect(query.get('readPreference')).toBe('secondaryPreferred')
    expect(query.get('directConnection')).toBe('true')
    expect(query.has('nonsense')).toBe(false)
    expect(query.has('appName')).toBe(false)
    expect(uri.startsWith('mongodb://a:1,b:2/')).toBe(true)
  })

  it('finds servers through DNS for an SRV connection, without a port', async () => {
    const { uri, options } = await buildClientSetup(
      context({
        host: 'cluster0.abc.mongodb.net',
        options: { srv: 'true' },
        tls: { enabled: true, allowInvalidCertificates: false },
      }),
    )
    expect(uri.startsWith('mongodb+srv://cluster0.abc.mongodb.net/')).toBe(true)
    expect(options.tls).toBe(true)
  })

  it('brackets an IPv6 address', async () => {
    expect((await buildClientSetup(context({ host: '::1', port: 27017 }))).uri).toBe(
      'mongodb://[::1]:27017/?',
    )
  })

  it('reads the certificate files for TLS, and can skip verification for local use', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbide-tls-'))
    try {
      writeFileSync(join(dir, 'ca.pem'), 'CA')
      const { options } = await buildClientSetup(
        context({
          tls: { enabled: true, caPath: join(dir, 'ca.pem'), allowInvalidCertificates: true },
        }),
      )
      expect(options).toMatchObject({
        tls: true,
        tlsAllowInvalidCertificates: true,
        tlsAllowInvalidHostnames: true,
      })
      expect(Buffer.from(options.ca as Buffer).toString()).toBe('CA')
      await expect(
        buildClientSetup(
          context({
            tls: {
              enabled: true,
              caPath: join(dir, 'missing.pem'),
              allowInvalidCertificates: false,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
