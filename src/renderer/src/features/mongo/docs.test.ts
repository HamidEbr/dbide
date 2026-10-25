import { beforeEach, describe, expect, it } from 'vitest'
import { clearDocumentCache, idKey, keyOf, parseDocument, summarize } from './docs'

beforeEach(clearDocumentCache)

describe('parseDocument', () => {
  it('reads a cell as the document it holds, and answers undefined for anything else', () => {
    expect(parseDocument('{"a":{"$numberInt":"1"}}')).toEqual({ a: { $numberInt: '1' } })
    expect(parseDocument('not json')).toBeUndefined()
    expect(parseDocument(undefined)).toBeUndefined()
    expect(parseDocument(null)).toBeUndefined()
  })

  it('keeps a document that is null, which is a value and not a missing row', () => {
    expect(parseDocument('null')).toBeNull()
  })

  it('answers the same text with the same object, without parsing it again', () => {
    const first = parseDocument('{"a":1}')
    expect(parseDocument('{"a":1}')).toBe(first)
  })
})

describe('keys', () => {
  it('tells documents apart by _id, whatever its type', () => {
    expect(keyOf({ _id: { $oid: 'aa' } })).toBe(idKey({ $oid: 'aa' }))
    expect(keyOf({ _id: { $numberInt: '1' } })).not.toBe(keyOf({ _id: { $numberLong: '1' } }))
    expect(keyOf({ a: 1 })).toBeNull()
    expect(keyOf(undefined)).toBeNull()
  })
})

describe('summarize', () => {
  it('writes the first of a document in the shell’s notation, cut to fit', () => {
    expect(summarize({ _id: { $oid: '507f1f77bcf86cd799439011' }, n: { $numberInt: '5' } })).toBe(
      '{ _id: ObjectId("507f1f77bcf86cd799439011"), n: 5 }',
    )
    expect(summarize({ text: 'x'.repeat(500) }, 40)).toHaveLength(40)
  })
})
