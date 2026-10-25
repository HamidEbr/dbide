import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings'

export class SettingsRepo {
  constructor(private readonly db: DatabaseSync) {}

  /** Stored values layered over the defaults, so new settings never come back undefined. */
  getAll(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as unknown as {
      key: string
      value: string
    }[]
    const stored: Record<string, unknown> = {}
    for (const row of rows) {
      try {
        stored[row.key] = JSON.parse(row.value)
      } catch {
        // A corrupt value falls back to the default instead of breaking startup.
      }
    }
    return { ...DEFAULT_SETTINGS, ...stored } as Settings
  }

  set(patch: Partial<Settings>): Settings {
    const upsert = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    )
    this.db.exec('BEGIN')
    try {
      for (const [key, value] of Object.entries(patch)) upsert.run(key, JSON.stringify(value))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getAll()
  }
}
