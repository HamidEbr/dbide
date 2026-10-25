import { BSON, type Document } from 'mongodb'
import type { Json } from '@shared/mongo/ejson'

const { EJSON } = BSON

/**
 * Canonical Extended JSON text for a value the driver returned. Canonical, not relaxed, so an Int32, a
 * Double and an Int64 stay three different things all the way to the window.
 */
export function toEjsonText(value: unknown): string {
  return EJSON.stringify(value as Document, { relaxed: false })
}

export function toEjson(value: unknown): Json {
  return JSON.parse(toEjsonText(value)) as Json
}

/**
 * What the BSON library hands back for Extended JSON: a document, an array or a scalar. The library
 * types all of them as `Document`, and so does this.
 */
export type Bson = Document

/** BSON values from canonical Extended JSON, ready to hand to the driver. */
export function fromEjson(json: Json): Bson {
  return EJSON.deserialize(json as unknown as Document, { relaxed: false })
}

/**
 * A JavaScript number from what the driver reports. Replies are read without promoting values, so the
 * counts in them (`deletedCount`, `modifiedCount`) arrive as BSON Int32 or Long objects, not numbers.
 */
export function plainNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (value !== null && typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber(): number }).toNumber()
  }
  return Number(value)
}
