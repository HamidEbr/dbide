import { createCipheriv } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decryptCredentials } from './credentials'
import { defaultDbeaverDir, readDbeaver } from './read'

const KEY = Buffer.from('babb4a9f774ab853c96c2d653dfde98b', 'hex')
function encrypt(value: unknown): Buffer {
  const iv = Buffer.alloc(16, 7)
  const cipher = createCipheriv('aes-128-cbc', KEY, iv)
  return Buffer.concat([iv, cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
}

describe('decryptCredentials', () => {
  it('reads the database login and the tunnel login of each connection', () => {
    const file = encrypt({
      a: {
        '#connection': { user: 'root', password: 'pw' },
        'network/ssh_tunnel': { user: 'jump', password: 'sshpw' },
      },
      b: { '#connection': { user: 'only' } },
    })
    expect(decryptCredentials(file)).toEqual({
      a: {
        connection: { user: 'root', password: 'pw' },
        ssh: { user: 'jump', password: 'sshpw' },
      },
      b: { connection: { user: 'only', password: '' } },
    })
  })

  it('is null for a file that is not DBeaver’s', () => {
    expect(decryptCredentials(Buffer.from('hello'))).toBeNull()
    expect(decryptCredentials(Buffer.alloc(64, 1))).toBeNull()
  })
})

describe('readDbeaver', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbide-dbeaver-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads every data-sources file in a .dbeaver folder with the saved logins', async () => {
    const folder = join(dir, '.dbeaver')
    mkdirSync(folder)
    const source = (id: string) =>
      JSON.stringify({
        connections: { [id]: { provider: 'mysql', driver: 'mysql8', name: id, configuration: {} } },
      })
    writeFileSync(join(folder, 'data-sources.json'), source('one'))
    writeFileSync(join(folder, 'data-sources-2.json'), source('two'))
    writeFileSync(
      join(folder, 'credentials-config.json'),
      encrypt({ one: { '#connection': { user: 'u', password: 'p' } } }),
    )
    const read = await readDbeaver(folder)
    expect(read!.connections.map((c) => c.sourceId).sort()).toEqual(['one', 'two'])
    expect(read!.hasCredentials).toBe(true)
    expect(read!.logins.one!.connection).toEqual({ user: 'u', password: 'p' })
  })

  it('works without a credentials file, and is null when nothing is DBeaver’s', async () => {
    writeFileSync(
      join(dir, 'data-sources.json'),
      JSON.stringify({
        connections: { x: { provider: 'redis', driver: 'redis', name: 'x', configuration: {} } },
      }),
    )
    const read = await readDbeaver(join(dir, 'data-sources.json'))
    expect(read!.hasCredentials).toBe(false)
    expect(read!.credentialsProblem).toBe('missing')
    writeFileSync(join(dir, 'credentials-config.json'), Buffer.alloc(64, 1))
    expect((await readDbeaver(join(dir, 'data-sources.json')))!.credentialsProblem).toBe(
      'unreadable',
    )
    expect(await readDbeaver(join(dir, 'missing.json'))).toBeNull()
  })

  it('knows where each system keeps it', () => {
    expect(defaultDbeaverDir('darwin', {}, '/Users/a')).toBe(
      '/Users/a/Library/DBeaverData/workspace6/General/.dbeaver',
    )
    expect(defaultDbeaverDir('linux', {}, '/home/a')).toContain('.local/share/DBeaverData')
    expect(
      defaultDbeaverDir('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a'),
    ).toContain('DBeaverData')
  })
})

describe('readConnections', () => {
  it('reads a Navicat export, decrypting its passwords', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbide-navicat-'))
    try {
      const cipher = createCipheriv(
        'aes-128-cbc',
        Buffer.from('libcckeylibcckey'),
        Buffer.from('libcciv libcciv '),
      )
      const hex = Buffer.concat([cipher.update('s3cret'), cipher.final()])
        .toString('hex')
        .toUpperCase()
      const file = join(dir, 'c.ncx')
      writeFileSync(
        file,
        `<Connections><Connection ConnectionName="Main" ConnType="MYSQL" Host="h" Port="3306" UserName="u" Password="${hex}" /></Connections>`,
      )
      const read = await (await import('./sources')).readConnections('navicat', { path: file })
      expect(read!.logins['navicat-0']!.connection).toEqual({ user: 'u', password: 's3cret' })
      expect(read!.hasCredentials).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads pasted URLs, and knows where tools keep their files', async () => {
    const { readConnections, defaultSourcePath } = await import('./sources')
    const read = await readConnections('urls', { text: 'redis://:pw@cache:6380/2' })
    expect(read!.connections[0]).toMatchObject({
      engine: 'redis',
      host: 'cache',
      port: 6380,
      database: '2',
    })
    expect(read!.logins['url-0']!.connection!.password).toBe('pw')
    expect(defaultSourcePath('workbench', 'darwin', {}, '/Users/a')).toBe(
      '/Users/a/Library/Application Support/MySQL/Workbench/connections.xml',
    )
    expect(defaultSourcePath('navicat')).toBeNull()
  })
})
