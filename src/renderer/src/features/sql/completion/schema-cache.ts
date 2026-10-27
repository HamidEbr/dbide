import { useSyncExternalStore } from 'react'
import type { SchemaDetail, SchemaForeignKey, SchemaTable, TableColumns } from '@shared/driver'
import { coreLink } from '@/ipc/link'
import { notify } from '@/state/notices'

/** Where the cache gets what it holds. The window's is the core; tests give their own. */
export interface SchemaLoader {
  detail(connectionId: string, database: string): Promise<SchemaDetail>
  columns(connectionId: string, database: string, tables: string[]): Promise<TableColumns>
  databases(connectionId: string): Promise<string[]>
}

const coreLoader: SchemaLoader = {
  detail: (connectionId, database) => coreLink.call('schema.detail', { connectionId, database }),
  columns: (connectionId, database, tables) =>
    coreLink.call('schema.columns', { connectionId, database, tables }),
  databases: (connectionId) => coreLink.call('schema.databases', { connectionId }),
}

/** How far the names of one database have got, for the chip beside the editor. */
export interface SchemaStatus {
  state: 'idle' | 'loading' | 'ready' | 'failed'
  /** Tables and views the database has, once known. */
  tables: number
  /** Tables whose columns are known. */
  withColumns: number
  /** Tables whose columns are being read right now. */
  reading: number
  error: string | null
}

const IDLE: SchemaStatus = { state: 'idle', tables: 0, withColumns: 0, reading: 0, error: null }

/** Most tables asked about in one read. */
const BATCH = 200

/** Says once per connection why names can't be suggested, rather than leaving the popup quietly short. */
const told = new Set<string>()
function tellOnce(connectionId: string, what: string, error: unknown): void {
  if (told.has(connectionId)) return
  told.add(connectionId)
  const reason = error instanceof Error ? error.message : String(error)
  notify(`Autocomplete couldn’t read ${what}, so it can only suggest keywords. ${reason}`, 'warn')
}

interface Known {
  table: SchemaTable
  foreignKeys: SchemaForeignKey[]
}

/**
 * The tables, columns and databases autocomplete suggests from. A database's tables are read the first time a
 * script needs them, and the columns of a table only when a statement names it, so a database with thousands of
 * tables costs no more than one with a few. Everything is shared by the scripts on a connection and read again
 * after a statement that changes the schema. A read that fails is not remembered, so the next keystroke tries
 * again, and the status says what is going on.
 */
export class SchemaCache {
  private details = new Map<string, Promise<SchemaDetail | null>>()
  private loaded = new Map<string, SchemaDetail>()
  private names = new Map<string, Promise<string[] | null>>()
  private known = new Map<string, string[]>()
  /** By database, then lower-case table name. */
  private tables = new Map<string, Map<string, Known>>()
  /** Tables whose columns are being read, by database, lower-case name. */
  private pending = new Map<string, Set<string>>()
  /** Tables asked about that the server doesn't have, so they aren't asked again. */
  private absent = new Map<string, Set<string>>()
  private statuses = new Map<string, SchemaStatus>()
  private listeners = new Set<() => void>()

  constructor(
    private readonly loader: SchemaLoader = coreLoader,
    private readonly onFailure: (
      connectionId: string,
      what: string,
      error: unknown,
    ) => void = tellOnce,
  ) {}

  private key = (connectionId: string, database: string): string =>
    JSON.stringify([connectionId, database])

  // ───────── Status, for the chip ─────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  status(connectionId: string, database: string): SchemaStatus {
    return this.statuses.get(this.key(connectionId, database)) ?? IDLE
  }

  private setStatus(connectionId: string, database: string, patch: Partial<SchemaStatus>): void {
    const key = this.key(connectionId, database)
    const current = this.statuses.get(key) ?? IDLE
    const known = this.tables.get(key)
    const next: SchemaStatus = {
      ...current,
      withColumns: known?.size ?? 0,
      reading: this.pending.get(key)?.size ?? 0,
      ...patch,
    }
    // A snapshot that changes only when something does, which is what React compares.
    if (JSON.stringify(next) === JSON.stringify(current)) return
    this.statuses.set(key, next)
    for (const listener of this.listeners) listener()
  }

  // ───────── The tables of a database ─────────

  /** The database's tables, or null when they can't be read right now. Starts the read on first use. */
  detail(connectionId: string, database: string): Promise<SchemaDetail | null> {
    const key = this.key(connectionId, database)
    const cached = this.details.get(key)
    if (cached) return cached
    this.setStatus(connectionId, database, { state: 'loading', error: null })
    const promise = this.loader.detail(connectionId, database).then(
      (detail) => {
        this.loaded.set(key, detail)
        told.delete(connectionId)
        this.setStatus(connectionId, database, {
          state: 'ready',
          tables: detail.tables.length,
          error: null,
        })
        return detail
      },
      (error: unknown) => {
        // Not kept: a connection that was down a moment ago may be up now.
        if (this.details.get(key) === promise) this.details.delete(key)
        this.setStatus(connectionId, database, {
          state: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
        this.onFailure(connectionId, `the tables of ${database}`, error)
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

  // ───────── The columns of some tables ─────────

  /** The name a table really has, from what is loaded, when it was typed in another case. */
  realName(connectionId: string, database: string, typed: string): string {
    const found = this.peek(connectionId, database)?.tables.find(
      (t) => t.name.toLowerCase() === typed.toLowerCase(),
    )
    return found?.name ?? typed
  }

  /**
   * Reads the columns and foreign keys of the named tables that aren't known yet, in one call. Resolves when they
   * are known, or when the read fails.
   */
  async columns(connectionId: string, database: string, wanted: string[]): Promise<void> {
    const key = this.key(connectionId, database)
    const known = this.tables.get(key) ?? new Map<string, Known>()
    const pending = this.pending.get(key) ?? new Set<string>()
    const absent = this.absent.get(key) ?? new Set<string>()
    const missing = [
      ...new Set(
        wanted.filter((name) => {
          const lower = name.toLowerCase()
          return !known.has(lower) && !pending.has(lower) && !absent.has(lower)
        }),
      ),
    ].slice(0, BATCH)
    if (missing.length === 0) {
      // Something may already be reading what was asked for; wait for it too.
      await this.settled.get(key)
      return
    }
    this.tables.set(key, known)
    this.pending.set(key, pending)
    this.absent.set(key, absent)
    for (const name of missing) pending.add(name.toLowerCase())
    this.setStatus(connectionId, database, {})

    const read = this.loader.columns(connectionId, database, missing).then(
      (result: TableColumns) => {
        for (const table of result.tables) {
          known.set(table.name.toLowerCase(), {
            table,
            foreignKeys: result.foreignKeys.filter((k) => k.table === table.name),
          })
        }
        for (const name of missing) {
          if (!known.has(name.toLowerCase())) absent.add(name.toLowerCase())
        }
        told.delete(connectionId)
      },
      (error: unknown) => {
        this.onFailure(connectionId, `the columns of ${missing.join(', ')}`, error)
        this.setStatus(connectionId, database, {
          error: error instanceof Error ? error.message : String(error),
        })
      },
    )
    // One read at a time per database is enough to wait on.
    const wait = read.finally(() => {
      for (const name of missing) pending.delete(name.toLowerCase())
      if (this.settled.get(key) === wait) this.settled.delete(key)
      this.setStatus(connectionId, database, {})
    })
    this.settled.set(key, wait)
    await wait
  }
  private settled = new Map<string, Promise<void>>()

  /** A table's columns, when they have been read. */
  peekTable(connectionId: string, database: string, name: string): SchemaTable | undefined {
    return this.tables.get(this.key(connectionId, database))?.get(name.toLowerCase())?.table
  }

  /** The foreign keys of a table, when its columns have been read. */
  peekForeignKeys(connectionId: string, database: string, name: string): SchemaForeignKey[] {
    return (
      this.tables.get(this.key(connectionId, database))?.get(name.toLowerCase())?.foreignKeys ?? []
    )
  }

  // ───────── Databases ─────────

  databases(connectionId: string): Promise<string[] | null> {
    const cached = this.names.get(connectionId)
    if (cached) return cached
    const promise = this.loader.databases(connectionId).then(
      (names) => {
        this.known.set(connectionId, names)
        return names
      },
      (error: unknown) => {
        if (this.names.get(connectionId) === promise) this.names.delete(connectionId)
        this.onFailure(connectionId, 'the databases', error)
        return null
      },
    )
    this.names.set(connectionId, promise)
    return promise
  }

  peekDatabases(connectionId: string): string[] | undefined {
    return this.known.get(connectionId)
  }

  // ───────── Forgetting ─────────

  /** Forgets what is held for a connection, or for one of its databases, so the next use reads it again. */
  invalidate(connectionId: string, database?: string): void {
    const keys =
      database === undefined
        ? [...this.statuses.keys(), ...this.details.keys(), ...this.tables.keys()].filter(
            (key) => (JSON.parse(key) as string[])[0] === connectionId,
          )
        : [this.key(connectionId, database)]
    for (const key of new Set(keys)) {
      this.details.delete(key)
      this.loaded.delete(key)
      this.tables.delete(key)
      this.absent.delete(key)
      this.statuses.delete(key)
    }
    if (database === undefined) {
      this.names.delete(connectionId)
      this.known.delete(connectionId)
    }
    for (const listener of this.listeners) listener()
  }

  clear(): void {
    this.details.clear()
    this.loaded.clear()
    this.names.clear()
    this.known.clear()
    this.tables.clear()
    this.absent.clear()
    this.statuses.clear()
    for (const listener of this.listeners) listener()
  }
}

/** The cache the editors share. */
export const schemaCache = new SchemaCache()

/** The status of one database's names, kept up to date as they load. */
export function useSchemaStatus(connectionId: string, database: string | null): SchemaStatus {
  return useSyncExternalStore(schemaCache.subscribe, () =>
    database ? schemaCache.status(connectionId, database) : IDLE,
  )
}
