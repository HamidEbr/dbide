import { SPILL_PAGE_ROWS, type Cell } from '@shared/query'
import type { NumberTotals } from '@shared/value'

type Scheduler = (callback: () => void) => void

/** Where rows past the ones the window holds itself live: in the core. */
export interface RowBacking {
  /** `count` held rows from position `from`, counting from the first held row. */
  fetch(from: number, count: number): Promise<Cell[][]>
  /** The numbers in a block of held rows. */
  stats(
    from: number,
    count: number,
    columns: { index: number; type: string }[],
  ): Promise<NumberTotals & { partial: boolean }>
}

/** How long to wait before asking again for a page that could not be fetched. */
const RETRY_AFTER_MS = 3000

/**
 * Rows of one result set. They live outside React state: a million-row result must not be
 * copied on every batch. Subscribers are told at most once per `intervalMs`, so a fast stream
 * repaints a few times a second instead of once per batch.
 *
 * The window keeps the first rows of a result itself (`rows`). Rows past those are held by the core
 * and counted here; one is read with `getRow`, which answers `undefined` and asks the core for its
 * page when it isn't at hand. When the page arrives the store tells its subscribers, so the grid
 * draws the row then. Pages that were not looked at for a while are let go.
 */
export class RowStore {
  /** The rows the window holds, in order. */
  readonly rows: Cell[][] = []
  private held = 0
  private version = 0
  private readonly listeners = new Set<() => void>()
  private scheduled = false

  /** Held pages by number, least recently used first. */
  private readonly pages = new Map<number, Cell[][]>()
  private readonly loading = new Set<number>()
  private readonly failed = new Map<number, number>()

  constructor(
    private readonly schedule: Scheduler = (callback) => void setTimeout(callback, 50),
    private readonly backing: RowBacking | null = null,
    private readonly pageRows: number = SPILL_PAGE_ROWS,
    private readonly maxPages: number = 60,
  ) {}

  get length(): number {
    return this.rows.length + this.held
  }

  /** Rows that are held by the core, not here. */
  get spilled(): number {
    return this.held
  }

  append(batch: Cell[][]): void {
    for (const row of batch) this.rows.push(row)
    this.notify()
  }

  /** The core took `count` more rows to hold. */
  appendSpilled(count: number): void {
    this.held += count
    this.notify()
  }

  /** Overwrites cells of one loaded row after a successful save. */
  setCells(row: number, values: Record<number, Cell>): void {
    const target = this.rows[row]
    if (!target) return
    for (const [col, value] of Object.entries(values)) target[Number(col)] = value
    this.notify()
  }

  /** Drops rows after they were deleted on the server. The rows after them move up. */
  removeRows(indices: number[]): void {
    const drop = new Set(indices)
    let write = 0
    for (let read = 0; read < this.rows.length; read++) {
      if (!drop.has(read)) this.rows[write++] = this.rows[read]!
    }
    this.rows.length = write
    this.notify()
  }

  /** A row, asking the core for it when it is not at hand. */
  getRow = (index: number): Cell[] | undefined => {
    if (index < this.rows.length) return this.rows[index]
    const { page, offset } = this.locate(index)
    const cached = this.pages.get(page)
    if (cached) {
      // Used just now, so it goes to the back of the line for being let go.
      this.pages.delete(page)
      this.pages.set(page, cached)
      return cached[offset]
    }
    this.load(page)
    return undefined
  }

  /** A row if it is at hand, without asking for it. */
  peekRow = (index: number): Cell[] | undefined => {
    if (index < this.rows.length) return this.rows[index]
    const { page, offset } = this.locate(index)
    return this.pages.get(page)?.[offset]
  }

  private locate(index: number): { page: number; offset: number } {
    const position = index - this.rows.length
    return { page: Math.floor(position / this.pageRows), offset: position % this.pageRows }
  }

  private load(page: number): void {
    const backing = this.backing
    if (!backing || this.loading.has(page)) return
    const failedAt = this.failed.get(page)
    if (failedAt !== undefined && Date.now() - failedAt < RETRY_AFTER_MS) return

    this.loading.add(page)
    backing
      .fetch(page * this.pageRows, this.pageRows)
      .then((rows) => {
        this.failed.delete(page)
        this.pages.set(page, rows)
        while (this.pages.size > this.maxPages) {
          this.pages.delete(this.pages.keys().next().value!)
        }
      })
      .catch(() => {
        this.failed.set(page, Date.now())
      })
      .finally(() => {
        this.loading.delete(page)
        this.notify()
      })
  }

  /**
   * The rows from `from` to `to` (inclusive), whether held here or by the core. For copying a
   * selection; rows are fetched in pages and not kept, so a big range doesn't push out what is shown.
   */
  async readRange(from: number, to: number): Promise<Cell[][]> {
    const out: Cell[][] = []
    const last = Math.min(to, this.length - 1)
    let index = from
    while (index <= last) {
      if (index < this.rows.length) {
        out.push(this.rows[index]!)
        index++
        continue
      }
      const { page, offset } = this.locate(index)
      const fetched =
        this.pages.get(page) ??
        (await this.backing?.fetch(page * this.pageRows, this.pageRows)) ??
        []
      const take = Math.min(fetched.length - offset, last - index + 1)
      if (take <= 0) break
      for (let i = 0; i < take; i++) out.push(fetched[offset + i]!)
      index += take
    }
    return out
  }

  /** What the numbers in a block of rows past the held ones add up to. */
  async heldTotals(
    from: number,
    to: number,
    columns: { index: number; type: string }[],
  ): Promise<(NumberTotals & { partial: boolean }) | null> {
    const first = Math.max(from, this.rows.length)
    if (!this.backing || first > to) return null
    return this.backing.stats(first - this.rows.length, to - first + 1, columns)
  }

  /** For `useSyncExternalStore`. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  private notify(): void {
    if (this.scheduled) return
    this.scheduled = true
    this.schedule(() => {
      this.scheduled = false
      this.version++
      for (const listener of this.listeners) listener()
    })
  }
}
