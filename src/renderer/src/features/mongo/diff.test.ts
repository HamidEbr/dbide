import { describe, expect, it } from 'vitest'
import { diffDocuments, same, touchedFields, withField } from './diff'
import type { Json } from '@shared/mongo/ejson'

const int = (n: number): Json => ({ $numberInt: String(n) })
const oid: Json = { $oid: '507f1f77bcf86cd799439011' }

describe('same', () => {
  it('ignores the order of fields but not of array items', () => {
    expect(same({ a: int(1), b: 'x' }, { b: 'x', a: int(1) })).toBe(true)
    expect(same([int(1), int(2)], [int(2), int(1)])).toBe(false)
    expect(same({ a: int(1) }, { a: { $numberDouble: '1' } })).toBe(false)
    expect(same({ a: [1] as Json }, { a: {} })).toBe(false)
    expect(same(null, null)).toBe(true)
    expect(same(null, undefined)).toBe(false)
  })
})

describe('diffDocuments', () => {
  const original: Json = {
    _id: oid,
    name: 'Ada',
    age: int(36),
    tags: ['a', 'b'],
    address: {
      city: 'London',
      geo: { lat: { $numberDouble: '51.5' }, lng: { $numberDouble: '0' } },
    },
    note: 'x',
  }

  it('is empty when nothing changed', () => {
    expect(diffDocuments(original, JSON.parse(JSON.stringify(original)))).toEqual({
      ok: true,
      changes: { set: {}, unset: [] },
    })
  })

  it('sets what changed, as paths into sub-documents, and unsets what is gone', () => {
    const next: Json = {
      _id: oid,
      name: 'Ada L',
      age: int(36),
      tags: ['a', 'b', 'c'],
      address: {
        city: 'Paris',
        geo: { lat: { $numberDouble: '48.8' }, lng: { $numberDouble: '0' } },
        zip: '75001',
      },
      extra: true,
    }
    expect(diffDocuments(original, next)).toEqual({
      ok: true,
      changes: {
        set: {
          name: 'Ada L',
          tags: ['a', 'b', 'c'],
          'address.city': 'Paris',
          'address.geo.lat': { $numberDouble: '48.8' },
          'address.zip': '75001',
          extra: true,
        },
        unset: ['note'],
      },
    })
  })

  it('replaces a value whose type changed, and an object that was empty', () => {
    expect(diffDocuments({ _id: int(1), a: {} }, { _id: int(1), a: { b: int(1) } })).toEqual({
      ok: true,
      changes: { set: { a: { b: int(1) } }, unset: [] },
    })
    expect(diffDocuments({ _id: int(1), a: int(1) }, { _id: int(1), a: 'one' })).toEqual({
      ok: true,
      changes: { set: { a: 'one' }, unset: [] },
    })
  })

  it('writes a sub-document whole when one of its names has a dot', () => {
    const result = diffDocuments(
      { _id: int(1), a: { 'x.y': int(1) } },
      { _id: int(1), a: { 'x.y': int(2) } },
    )
    expect(result).toEqual({
      ok: true,
      changes: { set: { a: { 'x.y': int(2) } }, unset: [] },
    })
  })

  it('refuses a changed _id and names that can’t be addressed at the top', () => {
    expect(diffDocuments(original, { ...(original as object), _id: int(2) } as Json)).toMatchObject(
      {
        ok: false,
        message: expect.stringContaining('_id'),
      },
    )
    expect(diffDocuments({ _id: int(1) }, { _id: int(1), 'a.b': int(1) })).toMatchObject({
      ok: false,
    })
    expect(diffDocuments({ _id: int(1) }, [] as Json)).toMatchObject({ ok: false })
  })

  it('does not report a re-ordered document as a change', () => {
    expect(
      diffDocuments({ _id: int(1), a: int(1), b: int(2) }, { b: int(2), _id: int(1), a: int(1) }),
    ).toEqual({
      ok: true,
      changes: { set: {}, unset: [] },
    })
  })
})

describe('helpers', () => {
  it('names the top-level fields touched', () => {
    expect(
      touchedFields({ set: { 'a.b': int(1), 'a.c': int(2), d: int(3) }, unset: ['e.f'] }),
    ).toEqual(['a', 'd', 'e'])
  })

  it('sets one field, keeping order', () => {
    expect(
      Object.keys(withField({ _id: int(1), a: int(1), b: int(2) }, 'a', 'x') as object),
    ).toEqual(['_id', 'a', 'b'])
    expect(withField({ _id: int(1) }, 'a', 'x')).toEqual({ _id: int(1), a: 'x' })
  })
})
