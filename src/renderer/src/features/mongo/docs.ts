import { formatShell, idOf, parseJson, type Json } from '@shared/mongo/ejson'
import type { Cell } from '@shared/query'

/** How many parsed documents are kept, so scrolling back over rows doesn't parse them again. */
const CACHE_LIMIT = 4000
const cache = new Map<string, Json | null>()

/**
 * The document a cell holds. Cells carry canonical Extended JSON text; it is parsed when a row is
 * drawn, and remembered for a while. Undefined when the cell is not JSON (a row that has not arrived).
 */
export function parseDocument(cell: Cell | undefined): Json | undefined {
  if (typeof cell !== 'string') return undefined
  const hit = cache.get(cell)
  if (hit !== undefined) {
    // Used just now, so it goes to the back of the line for being let go.
    cache.delete(cell)
    cache.set(cell, hit)
    return hit === null && cell !== 'null' ? undefined : hit
  }
  const parsed = parseJson(cell)
  cache.set(cell, parsed === undefined ? null : parsed)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return parsed
}

/** A string that is the same for the same `_id` and different for different ones. */
export const idKey = (id: Json | undefined): string => JSON.stringify(id ?? null)

/** The key of a document, or null when it has no `_id` (a projection left it out, or it is not a document). */
export function keyOf(document: Json | undefined): string | null {
  if (document === undefined) return null
  const id = idOf(document)
  return id === undefined ? null : idKey(id)
}

/** One line of a document for a list: its first fields in the shell's notation, cut to fit. */
export function summarize(document: Json, max = 140): string {
  const text = formatShell(document, { indent: false })
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Forgets every parsed document. For tests. */
export const clearDocumentCache = (): void => cache.clear()
