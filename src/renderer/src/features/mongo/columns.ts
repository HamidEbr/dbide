import { typeOf, type BsonType, type Json } from '@shared/mongo/ejson'
import type { Cell } from '@shared/query'
import { parseDocument } from './docs'

/** More fields than this and the table shows the first ones and says how many it left out. */
export const MAX_COLUMNS = 150
/** Documents read per pass, so a big result doesn't hold up the window while it is scanned. */
const SCAN_BATCH = 1500

/** The name of the one column that stands for a result whose rows are not documents. */
export const VALUE_COLUMN = 'value'

export interface DocumentColumn {
  /** The top-level field name. */
  path: string
  /** The types its values have had so far. */
  types: BsonType[]
}

/**
 * The fields of a result, found by reading the documents as they arrive: `_id` first, then in the
 * order they were first seen. A document with a field no earlier one had adds a column.
 */
export class ColumnScanner {
  private scanned = 0
  private readonly seen = new Map<string, Set<BsonType>>()
  private order: string[] = []
  private overflow = new Set<string>()
  private version = 0
  /** The list handed out last, kept until a column changes so views can tell nothing moved. */
  private cache: DocumentColumn[] | null = null

  /** Reads the documents that were not read yet. Returns whether the columns changed. */
  scan(rows: readonly Cell[][]): boolean {
    const before = this.version
    const end = Math.min(rows.length, this.scanned + SCAN_BATCH)
    for (let i = this.scanned; i < end; i++) {
      const document = parseDocument(rows[i]?.[0])
      if (document === undefined) continue
      if (
        typeof document === 'object' &&
        document !== null &&
        !Array.isArray(document) &&
        typeOf(document) === 'object'
      ) {
        for (const [key, value] of Object.entries(document)) this.note(key, value)
      } else {
        this.note(VALUE_COLUMN, document)
      }
    }
    this.scanned = end
    return this.version !== before
  }

  private note(key: string, value: Json): void {
    let types = this.seen.get(key)
    if (!types) {
      if (this.order.length >= MAX_COLUMNS) {
        this.overflow.add(key)
        return
      }
      types = new Set()
      this.seen.set(key, types)
      this.order.push(key)
      // `_id` leads, wherever it turned up.
      if (key === '_id') this.order = ['_id', ...this.order.filter((k) => k !== '_id')]
      this.version++
      this.cache = null
    }
    const type = typeOf(value)
    if (!types.has(type)) {
      types.add(type)
      this.version++
      this.cache = null
    }
  }

  /** Whether documents are still waiting to be read. */
  behind(total: number): boolean {
    return this.scanned < total
  }

  /** Fields past the cap that were seen but have no column. */
  get hidden(): number {
    return this.overflow.size
  }

  columns(): DocumentColumn[] {
    this.cache ??= this.order.map((path) => ({ path, types: [...(this.seen.get(path) ?? [])] }))
    return this.cache
  }
}

/** A starting width in pixels from the field's name and a sample of its values. */
export function columnWidth(path: string, sample: readonly string[]): number {
  const CHAR = 7.6
  let longest = path.length + 2
  for (const text of sample) longest = Math.max(longest, Math.min(text.length, 48))
  return Math.round(Math.min(340, Math.max(96, longest * CHAR + 24)))
}
