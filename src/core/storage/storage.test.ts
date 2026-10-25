import { describe, expect, it } from 'vitest'
import { newConnectionDraft, type ConnectionConfig } from '@shared/connection'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { ConnectionsRepo } from './connections-repo'
import { migrate, openDatabase, sqliteVersion } from './database'
import { SettingsRepo } from './settings-repo'

const connection = (overrides: Partial<ConnectionConfig>): ConnectionConfig => ({
  ...newConnectionDraft('mysql', crypto.randomUUID()),
  name: 'Conn',
  ...overrides,
})

describe('database', () => {
  it('migrates a fresh database to the latest version', () => {
    const db = openDatabase(':memory:')
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(row.user_version).toBeGreaterThanOrEqual(1)
    expect(sqliteVersion(db)).toMatch(/^\d+\.\d+/)
  })
})

describe('migrations', () => {
  it('upgrades a database made before scripts and history existed, keeping what it held', () => {
    const db = openDatabase(':memory:')
    new ConnectionsRepo(db).save(connection({ id: 'old', name: 'Kept' }))
    new SettingsRepo(db).set({ theme: 'dark' })

    // Put it back the way the first release left it.
    db.exec('DROP TABLE query_history; DROP TABLE script_revisions; DROP TABLE scripts')
    db.exec('PRAGMA user_version = 1')

    migrate(db)
    expect(new ConnectionsRepo(db).get('old')?.name).toBe('Kept')
    expect(new SettingsRepo(db).getAll().theme).toBe('dark')
    for (const table of ['scripts', 'script_revisions', 'query_history']) {
      expect(() => db.prepare(`SELECT COUNT(*) FROM ${table}`).get()).not.toThrow()
    }
    // Running it again changes nothing.
    expect(() => migrate(db)).not.toThrow()
  })

  it('deletes a script’s versions with the script', () => {
    const db = openDatabase(':memory:')
    db.prepare('INSERT INTO scripts (id, name, created_at) VALUES (?, ?, ?)').run('s1', 'A', 1)
    db.prepare(
      'INSERT INTO script_revisions (script_id, created_at, size, content) VALUES (?, ?, ?, ?)',
    ).run('s1', 1, 1, 'x')
    db.prepare('DELETE FROM scripts WHERE id = ?').run('s1')
    expect(db.prepare('SELECT COUNT(*) AS n FROM script_revisions').get()).toEqual({ n: 0 })
  })
})

describe('ConnectionsRepo', () => {
  it('saves, reads back, and deletes a connection', () => {
    const repo = new ConnectionsRepo(openDatabase(':memory:'))
    const config = connection({ name: 'Orders', host: 'db.internal', environment: 'prod' })
    repo.save(config)
    expect(repo.get(config.id)).toEqual(config)
    expect(repo.delete(config.id)).toBe(true)
    expect(repo.get(config.id)).toBeNull()
    expect(repo.delete(config.id)).toBe(false)
  })

  it('upserts on the same id', () => {
    const repo = new ConnectionsRepo(openDatabase(':memory:'))
    const config = connection({ name: 'Before' })
    repo.save(config)
    repo.save({ ...config, name: 'After' })
    expect(repo.list()).toHaveLength(1)
    expect(repo.get(config.id)?.name).toBe('After')
  })

  it('lists unfiled connections first, then by folder, then by name ignoring case', () => {
    const repo = new ConnectionsRepo(openDatabase(':memory:'))
    repo.save(connection({ name: 'zeta' }))
    repo.save(connection({ name: 'Alpha' }))
    repo.save(connection({ name: 'b-shop', folder: 'Shop' }))
    repo.save(connection({ name: 'a-billing', folder: 'Billing' }))
    expect(repo.list().map((c) => c.name)).toEqual(['Alpha', 'zeta', 'a-billing', 'b-shop'])
  })

  it('never stores a password in the config', () => {
    const repo = new ConnectionsRepo(openDatabase(':memory:'))
    const config = connection({})
    repo.save(config)
    expect(JSON.stringify(repo.get(config.id))).not.toMatch(/password/i)
  })

  it('summaries expose no credentials', () => {
    const repo = new ConnectionsRepo(openDatabase(':memory:'))
    repo.save(connection({ username: 'root', database: 'shop' }))
    const [summary] = repo.list()
    expect(summary).not.toHaveProperty('username')
    expect(summary).not.toHaveProperty('database')
  })
})

describe('SettingsRepo', () => {
  it('returns the defaults on a fresh database', () => {
    expect(new SettingsRepo(openDatabase(':memory:')).getAll()).toEqual(DEFAULT_SETTINGS)
  })

  it('persists changes and layers them over the defaults', () => {
    const repo = new SettingsRepo(openDatabase(':memory:'))
    expect(repo.set({ theme: 'dark' })).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' })
    expect(repo.set({ density: 'compact' })).toEqual({
      ...DEFAULT_SETTINGS,
      theme: 'dark',
      density: 'compact',
    })
  })

  it('falls back to the default when a stored value is corrupt', () => {
    const db = openDatabase(':memory:')
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('theme', '{not json')
    expect(new SettingsRepo(db).getAll().theme).toBe(DEFAULT_SETTINGS.theme)
  })
})
