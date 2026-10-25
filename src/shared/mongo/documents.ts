import type { ColumnInfo } from '../driver'
import { formatShell, type Json } from './ejson'

/**
 * A MongoDB result has no columns, so the grid's row-and-column protocol carries each document whole:
 * one column of this type, one row per document, the cell holding canonical Extended JSON text. Paging,
 * the core's disk spill and cancellation then work as they do for SQL, and the window derives whatever
 * table, tree or JSON view it shows from those cells.
 */
export const DOCUMENT_COLUMN_TYPE = 'document'

/**
 * How many documents of a result the window keeps. Documents are much bigger than rows, so the rest of a
 * large result is held by the core sooner than for SQL, and read from there as the view scrolls to it.
 */
export const DOCUMENT_RESIDENT_ROWS = 20_000

export function documentColumn(source?: { database: string; collection: string }): ColumnInfo {
  return {
    name: 'document',
    type: DOCUMENT_COLUMN_TYPE,
    nullable: false,
    ...(source
      ? { source: { schema: source.database, table: source.collection, column: 'document' } }
      : {}),
  }
}

export const isDocumentResult = (columns: readonly ColumnInfo[]): boolean =>
  columns.length === 1 && columns[0]!.type === DOCUMENT_COLUMN_TYPE

/** The documents were read straight from one collection, so they can be changed there. */
export function documentSource(
  columns: readonly ColumnInfo[],
): { database: string; collection: string } | null {
  const source = isDocumentResult(columns) ? columns[0]!.source : undefined
  return source ? { database: source.schema, collection: source.table } : null
}

/** A change to one document of a collection. Documents are addressed by `_id`. */
export type DocumentChange =
  /** Sets and removes fields of the document, leaving every other field as it is. Names may be dotted paths. */
  | { kind: 'update'; id: Json; set: Record<string, Json>; unset: string[] }
  | { kind: 'insert'; document: Json }
  | { kind: 'delete'; id: Json }

export interface DocumentEditBatch {
  database: string
  collection: string
  changes: DocumentChange[]
}

export type DocumentEditResult =
  | {
      ok: true
      /** For each change in order: the document as stored afterwards (null for a delete). */
      results: { document: string | null }[]
      /** All the changes were made together; false on a server that has no transactions. */
      atomic: boolean
    }
  | {
      ok: false
      failedIndex: number
      code: string | null
      message: string
      /** Changes made before the failure. Always 0 when the changes are atomic. */
      applied: number
    }

export const MAX_DOCUMENT_CHANGES = 1000

/** The collection as a shell expression: `db.orders`, or `db.getCollection("order-items")` for odd names. */
export function collectionRef(collection: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(collection)
    ? `db.${collection}`
    : `db.getCollection(${JSON.stringify(collection)})`
}

/** The change as the shell statement a person would type for it. Shown before the change is saved. */
export function previewChange(batch: DocumentEditBatch, change: DocumentChange): string {
  const target = collectionRef(batch.collection)
  const one = (value: Json): string => formatShell(value, { indent: false })
  if (change.kind === 'insert') return `${target}.insertOne(${one(change.document)})`
  const filter = `{ _id: ${one(change.id)} }`
  if (change.kind === 'delete') return `${target}.deleteOne(${filter})`

  const parts: string[] = []
  if (Object.keys(change.set).length > 0) parts.push(`$set: ${one(change.set)}`)
  if (change.unset.length > 0) {
    parts.push(`$unset: ${one(Object.fromEntries(change.unset.map((path) => [path, ''])))}`)
  }
  return `${target}.updateOne(${filter}, { ${parts.join(', ')} })`
}
