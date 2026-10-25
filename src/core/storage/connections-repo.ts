import type { DatabaseSync } from 'node:sqlite'
import { summarize, type ConnectionConfig, type ConnectionSummary } from '@shared/connection'

interface ConnectionRow {
  id: string
  config: string
}

/** Persists connection definitions. Secrets are stored elsewhere and never reach this table. */
export class ConnectionsRepo {
  constructor(private readonly db: DatabaseSync) {}

  list(): ConnectionSummary[] {
    const rows = this.db
      .prepare(
        'SELECT id, config FROM connections ORDER BY folder IS NOT NULL, folder, name COLLATE NOCASE',
      )
      .all() as unknown as ConnectionRow[]
    return rows.map((row) => summarize(JSON.parse(row.config) as ConnectionConfig))
  }

  get(id: string): ConnectionConfig | null {
    const row = this.db.prepare('SELECT id, config FROM connections WHERE id = ?').get(id) as
      ConnectionRow | undefined
    return row ? (JSON.parse(row.config) as ConnectionConfig) : null
  }

  save(config: ConnectionConfig): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO connections (id, name, engine, environment, folder, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           engine = excluded.engine,
           environment = excluded.environment,
           folder = excluded.folder,
           config = excluded.config,
           updated_at = excluded.updated_at`,
      )
      .run(
        config.id,
        config.name,
        config.engine,
        config.environment,
        config.folder ?? null,
        JSON.stringify(config),
        now,
        now,
      )
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM connections WHERE id = ?').run(id)
    return Number(result.changes) > 0
  }
}
