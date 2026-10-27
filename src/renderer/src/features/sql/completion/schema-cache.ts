import type { SchemaDetail } from '@shared/driver'
import { coreLink } from '@/ipc/link'

/** Where the cache gets what it holds. The window's is the core; tests give their own. */
export interface SchemaLoader {
  detail(connectionId: string, database: string): Promise<SchemaDetail>
  databases(connectionId: string): Promise<string[]>
}

const coreLoader: SchemaLoader = {
  detail: (connectionId, database) => coreLink.call('schema.detail', { connectionId, database }),
  databases: (connectionId) => coreLink.call('schema.databases', { connectionId }),
}

/**
 * The tables, columns and databases autocomplete suggests from. Each is read from the server the first time a
 * script needs it, shared by every script on that connection, and read again after a statement that changes the
 * schema. A read that fails is not remembered, so the next keystroke tries again.
 */
export class SchemaCache {
  private details = new Map<string, Promise<SchemaDetail | null>>()
  private loaded = new Map<string, SchemaDetail>()
  private names = new Map<string, Promise<string[] | null>>()
  private known = new Map<string, string[]>()

  constructor(private readonly loader: SchemaLoader = coreLoader) {}

  private key = (connectionId: string, database: string): string =>
    JSON.stringify([connectionId, database])

  /** The database's tables, or null when they can't be read right now. Starts the read on first use. */
  detail(connectionId: string, database: string): Promise<SchemaDetail | null> {
    const key = this.key(connectionId, database)
    const cached = this.details.get(key)
    if (cached) return cached
    const promise = this.loader.detail(connectionId, database).then(
      (detail) => {
        this.loaded.set(key, detail)
        return detail
      },
      () => {
        // Not kept: a connection that was down a moment ago may be up now.
        if (this.details.get(key) === promise) this.details.delete(key)
        return null
      },
    )
    this.details.set(key, promise)
    return promise
  }

  /** What is already loaded, without waiting or asking. */
  peek(connectionId: string, database: string): SchemaDetail | undefined {
    return this.loaded.get(this.key(connectionId, database))
  }

  databases(connectionId: string): Promise<string[] | null> {
    const cached = this.names.get(connectionId)
    if (cached) return cached
    const promise = this.loader.databases(connectionId).then(
      (names) => {
        this.known.set(connectionId, names)
        return names
      },
      () => {
        if (this.names.get(connectionId) === promise) this.names.delete(connectionId)
        return null
      },
    )
    this.names.set(connectionId, promise)
    return promise
  }

  peekDatabases(connectionId: string): string[] | undefined {
    return this.known.get(connectionId)
  }

  /** Forgets what is held for a connection, or for one of its databases, so the next use reads it again. */
  invalidate(connectionId: string, database?: string): void {
    if (database === undefined) {
      this.names.delete(connectionId)
      this.known.delete(connectionId)
      for (const key of [...this.details.keys()]) {
        if ((JSON.parse(key) as string[])[0] === connectionId) {
          this.details.delete(key)
          this.loaded.delete(key)
        }
      }
      return
    }
    const key = this.key(connectionId, database)
    this.details.delete(key)
    this.loaded.delete(key)
  }

  clear(): void {
    this.details.clear()
    this.loaded.clear()
    this.names.clear()
    this.known.clear()
  }
}

/** The cache the editors share. */
export const schemaCache = new SchemaCache()
