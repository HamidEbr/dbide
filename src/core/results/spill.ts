import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { deserialize, serialize } from 'node:v8'
import type { Cell } from '@shared/query'
import { RpcError } from '@shared/rpc'
import { addToTotals, emptyTotals, numericValueOf, type NumberTotals } from '@shared/value'

/** Who owns a held result, so it can be let go when its script runs again or closes. */
export interface SpillOwner {
  script: string
  run: string
  /** The result's id, the same one the window uses. */
  key: string
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024
const SCAN_CHUNK = 2000
/** A stored piece never grows past this, so one huge cell can't make a piece the database refuses. */
const MAX_PIECE_BYTES = 64 * 1024 * 1024

/**
 * Rows of results that are too big for the window to hold, kept on disk in the core. A result is
 * addressed by its key, and its rows by their position past the ones the window kept itself.
 *
 * Rows are stored in the pieces they arrive in (a driver batch each), not one by one, which makes
 * holding a million rows a matter of seconds. A read finds the pieces that cover the range.
 *
 * It is scratch space, not storage: the folder is emptied when the core starts and removed when it
 * stops, and nothing here is read by anything but the window that asked for the run.
 */
export class SpillStore {
  private readonly db: DatabaseSync
  /** Result ids by key, so appending a batch doesn't look the key up in the database. */
  private readonly ids = new Map<string, number>()
  /** Bytes held per script and run, so letting go of a run gives its space back to the limit. */
  private readonly held = new Map<string, number>()

  constructor(
    readonly dir: string,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {
    // Anything left by an earlier run that did not shut down cleanly is not wanted. (`:memory:` is for tests.)
    if (dir !== ':memory:') {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
    }
    this.db = new DatabaseSync(dir === ':memory:' ? dir : join(dir, 'results.sqlite'))
    this.db.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = MEMORY;
      CREATE TABLE results (
        id     INTEGER PRIMARY KEY,
        key    TEXT NOT NULL UNIQUE,
        script TEXT NOT NULL,
        run    TEXT NOT NULL
      );
      CREATE INDEX results_owner ON results (script, run);
      CREATE TABLE pieces (
        result INTEGER NOT NULL,
        first  INTEGER NOT NULL,
        count  INTEGER NOT NULL,
        data   BLOB NOT NULL,
        PRIMARY KEY (result, first)
      ) WITHOUT ROWID;
    `)
  }

  private idFor(owner: SpillOwner): number {
    const known = this.ids.get(owner.key)
    if (known !== undefined) return known
    const row = this.db
      .prepare('INSERT INTO results (key, script, run) VALUES (?, ?, ?) RETURNING id')
      .get(owner.key, owner.script, owner.run) as { id: number }
    this.ids.set(owner.key, row.id)
    return row.id
  }

  /** Adds rows at `first`, the position of the first of them within the held part of the result. */
  append(owner: SpillOwner, first: number, rows: readonly (readonly Cell[])[]): void {
    if (rows.length === 0) return
    this.db.exec('BEGIN')
    try {
      const id = this.idFor(owner)
      const insert = this.db.prepare(
        'INSERT INTO pieces (result, first, count, data) VALUES (?, ?, ?, ?)',
      )
      let added = 0
      const store = (start: number, slice: readonly (readonly Cell[])[]): void => {
        const packed = serialize(slice)
        // Rows with enormous cells are stored in smaller pieces.
        if (packed.length > MAX_PIECE_BYTES && slice.length > 1) {
          const half = Math.ceil(slice.length / 2)
          store(start, slice.slice(0, half))
          store(start + half, slice.slice(half))
          return
        }
        added += packed.length
        insert.run(id, start, slice.length, packed)
      }
      store(first, rows)
      if (this.totalBytes() + added > this.maxBytes) {
        throw new RpcError(
          'RESULTS_TOO_LARGE',
          'The results held for your scripts are using too much disk space. Close some tabs or narrow the query.',
        )
      }
      this.db.exec('COMMIT')
      const held = `${owner.script}\u0000${owner.run}`
      this.held.set(held, (this.held.get(held) ?? 0) + added)
    } catch (error) {
      this.db.exec('ROLLBACK')
      // A result whose first piece was just rolled back is not there to be found.
      if (this.ids.get(owner.key) !== undefined && this.count(owner.key) === 0) {
        this.ids.delete(owner.key)
      }
      throw error
    }
  }

  private totalBytes(): number {
    let total = 0
    for (const bytes of this.held.values()) total += bytes
    return total
  }

  /** `count` rows from position `from`, fewer at the end, none for a result that is gone. */
  fetch(key: string, from: number, count: number): Cell[][] {
    const id = this.lookup(key)
    if (id === undefined) return []
    const end = from + count
    const pieces = this.db
      .prepare(
        'SELECT first, count, data FROM pieces WHERE result = ? AND first < ? AND first + count > ? ORDER BY first',
      )
      .all(id, end, from) as unknown as { first: number; count: number; data: Uint8Array }[]

    const out: Cell[][] = []
    for (const piece of pieces) {
      const rows = deserialize(piece.data) as Cell[][]
      const lo = Math.max(from, piece.first) - piece.first
      const hi = Math.min(end, piece.first + piece.count) - piece.first
      for (let i = lo; i < hi; i++) out.push(rows[i]!)
    }
    return out
  }

  private lookup(key: string): number | undefined {
    const cached = this.ids.get(key)
    if (cached !== undefined) return cached
    const row = this.db.prepare('SELECT id FROM results WHERE key = ?').get(key) as
      { id: number } | undefined
    return row?.id
  }

  /** How many rows of a result are held. */
  count(key: string): number {
    const id = this.lookup(key)
    if (id === undefined) return 0
    const row = this.db
      .prepare('SELECT COALESCE(MAX(first + count), 0) AS n FROM pieces WHERE result = ?')
      .get(id) as { n: number }
    return row.n
  }

  /**
   * What the numbers in a block of held rows add up to, for the columns given. Looks at no more than
   * `limit` cells; `partial` says when it stopped early.
   */
  totals(
    key: string,
    from: number,
    count: number,
    columns: readonly { index: number; type: string }[],
    limit = 500_000,
  ): { totals: NumberTotals; partial: boolean } {
    const totals = emptyTotals()
    let scanned = 0
    for (let start = from; start < from + count; start += SCAN_CHUNK) {
      const rows = this.fetch(key, start, Math.min(SCAN_CHUNK, from + count - start))
      if (rows.length === 0) break
      for (const row of rows) {
        for (const column of columns) {
          if (scanned++ >= limit) return { totals, partial: true }
          const n = numericValueOf(row[column.index], column.type)
          if (n !== null) addToTotals(totals, n)
        }
      }
    }
    return { totals, partial: false }
  }

  private forget(where: string, ...params: string[]): void {
    const doomed = this.db
      .prepare(`SELECT id, key FROM results WHERE ${where}`)
      .all(...params) as unknown as { id: number; key: string }[]
    if (doomed.length === 0) return
    this.db.exec('BEGIN')
    try {
      const drop = this.db.prepare('DELETE FROM pieces WHERE result = ?')
      for (const { id, key } of doomed) {
        drop.run(id)
        this.ids.delete(key)
      }
      this.db.prepare(`DELETE FROM results WHERE ${where}`).run(...params)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Lets go of everything a script holds. */
  dropScript(script: string): void {
    this.forget('script = ?', script)
    for (const id of [...this.held.keys()])
      if (id.startsWith(`${script}\u0000`)) this.held.delete(id)
  }

  /** The script ran again: what its earlier runs held is no longer shown anywhere. */
  dropOtherRuns(script: string, keepRun: string): void {
    this.forget('script = ? AND run <> ?', script, keepRun)
    for (const id of [...this.held.keys()]) {
      if (id.startsWith(`${script}\u0000`) && id !== `${script}\u0000${keepRun}`)
        this.held.delete(id)
    }
  }

  /** Stops, and removes the files. */
  close(): void {
    this.db.close()
    if (this.dir !== ':memory:') rmSync(this.dir, { recursive: true, force: true })
  }
}
