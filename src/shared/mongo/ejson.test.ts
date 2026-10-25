import { describe, expect, it } from 'vitest'
import {
  formatCell,
  formatRelaxedJson,
  formatShell,
  getPath,
  idOf,
  isoOf,
  numberOf,
  typeOf,
  type Json,
} from './ejson'
import { collectionRef, previewChange } from './documents'

const oid = (hex: string): Json => ({ $oid: hex })
const long = (n: string): Json => ({ $numberLong: n })
const int = (n: string): Json => ({ $numberInt: n })
const double = (n: string): Json => ({ $numberDouble: n })
const date = (ms: string): Json => ({ $date: { $numberLong: ms } })

const sample: Json = {
  _id: oid('507f1f77bcf86cd799439011'),
  name: 'Ada',
  age: int('36'),
  score: double('9.5'),
  whole: double('10'),
  big: long('9007199254740993'),
  price: { $numberDecimal: '12.50' },
  born: date('-3600000'),
  tags: ['a', 'b'],
  address: { city: 'London', geo: { lat: double('51.5') } },
  nothing: null,
  ok: true,
  pattern: { $regularExpression: { pattern: 'a/b', options: 'i' } },
  at: { $timestamp: { t: 1700000000, i: 3 } },
  blob: { $binary: { base64: 'AQID', subType: '00' } },
  uid: { $binary: { base64: 'EjRWeJq83vASNFZ4mrze8A==', subType: '04' } },
  'odd key': 1,
}

describe('typeOf', () => {
  it('names every wrapper', () => {
    const types = Object.fromEntries(
      Object.entries(sample as Record<string, Json>).map(([key, value]) => [key, typeOf(value)]),
    )
    expect(types).toMatchObject({
      _id: 'objectId',
      name: 'string',
      age: 'int',
      score: 'double',
      big: 'long',
      price: 'decimal',
      born: 'date',
      tags: 'array',
      address: 'object',
      nothing: 'null',
      ok: 'bool',
      pattern: 'regex',
      at: 'timestamp',
      blob: 'binary',
      uid: 'uuid',
    })
  })

  it('treats a $ref document as a plain object', () => {
    expect(typeOf({ $ref: 'c', $id: oid('507f1f77bcf86cd799439011') })).toBe('object')
  })
})

describe('formatShell', () => {
  it('writes values the way the shell does, on one line', () => {
    expect(formatShell(sample)).toBe(
      '{ _id: ObjectId("507f1f77bcf86cd799439011"), name: "Ada", age: 36, score: 9.5, whole: 10.0, ' +
        'big: NumberLong("9007199254740993"), price: NumberDecimal("12.50"), ' +
        'born: ISODate("1969-12-31T23:00:00.000Z"), tags: [ "a", "b" ], ' +
        'address: { city: "London", geo: { lat: 51.5 } }, nothing: null, ok: true, ' +
        'pattern: /a\\/b/i, at: Timestamp(1700000000, 3), blob: BinData(0, "AQID"), ' +
        'uid: UUID("12345678-9abc-def0-1234-56789abcdef0"), "odd key": 1 }',
    )
  })

  it('spreads over lines when asked', () => {
    expect(formatShell({ a: int('1'), b: { c: ['x', null] }, d: [], e: {} }, { indent: 2 })).toBe(
      '{\n  a: 1,\n  b: {\n    c: [\n      "x",\n      null\n    ]\n  },\n  d: [],\n  e: {}\n}',
    )
  })

  it('keeps a whole double distinct from an Int32', () => {
    expect(formatShell(double('5'))).toBe('5.0')
    expect(formatShell(double('-0.0'))).toBe('-0.0')
    expect(formatShell(double('1e+30'))).toBe('1e+30')
    expect(formatShell(double('NaN'))).toBe('NaN')
    expect(formatShell(double('-Infinity'))).toBe('-Infinity')
    expect(formatShell(int('5'))).toBe('5')
  })

  it('shows a date outside the range of JavaScript as a number of milliseconds', () => {
    expect(formatShell(date('99999999999999999'))).toBe('new Date(99999999999999999)')
  })
})

describe('formatCell', () => {
  it('shows scalars plainly and containers by size', () => {
    expect(formatCell('text')).toBe('text')
    expect(formatCell(null)).toBe('null')
    expect(formatCell(oid('507f1f77bcf86cd799439011'))).toBe('507f1f77bcf86cd799439011')
    expect(formatCell(int('7'))).toBe('7')
    expect(formatCell(long('8'))).toBe('8')
    expect(formatCell(double('3'))).toBe('3.0')
    expect(formatCell(date('0'))).toBe('1970-01-01T00:00:00.000Z')
    expect(formatCell(['a', 'b'])).toBe('[ 2 items ]')
    expect(formatCell(['a'])).toBe('[ 1 item ]')
    expect(formatCell({ a: 1 })).toBe('{ 1 field }')
    expect(formatCell({ a: 1, b: 2 })).toBe('{ 2 fields }')
    expect(formatCell({ $binary: { base64: 'AQID', subType: '00' } })).toBe('BinData(0, "AQID")')
  })
})

describe('formatRelaxedJson', () => {
  it('uses plain numbers where JSON has them and keeps the wrappers where it does not', () => {
    const text = formatRelaxedJson(
      {
        _id: oid('507f1f77bcf86cd799439011'),
        n: int('1'),
        d: double('1.5'),
        l: long('2'),
        big: long('9007199254740993'),
        at: date('0'),
      },
      false,
    )
    expect(JSON.parse(text)).toEqual({
      _id: { $oid: '507f1f77bcf86cd799439011' },
      n: 1,
      d: 1.5,
      l: 2,
      big: { $numberLong: '9007199254740993' },
      at: { $date: '1970-01-01T00:00:00.000Z' },
    })
  })
})

describe('reading values', () => {
  it('finds numbers, dates and ids', () => {
    expect(numberOf(int('4'))).toBe(4)
    expect(numberOf(double('2.5'))).toBe(2.5)
    expect(numberOf('4')).toBeNull()
    expect(isoOf(date('0'))).toBe('1970-01-01T00:00:00.000Z')
    expect(isoOf('x')).toBeNull()
    expect(idOf(sample)).toEqual(oid('507f1f77bcf86cd799439011'))
    expect(idOf({ a: 1 })).toBeUndefined()
  })

  it('looks a dotted path up through objects and arrays', () => {
    expect(getPath(sample, 'address.city')).toBe('London')
    expect(getPath(sample, 'tags.1')).toBe('b')
    expect(getPath(sample, 'address.nope.deeper')).toBeUndefined()
  })
})

describe('previewChange', () => {
  const batch = { database: 'shop', collection: 'orders', changes: [] }

  it('writes each change as the statement a person would type', () => {
    const id = oid('507f1f77bcf86cd799439011')
    expect(
      previewChange(batch, {
        kind: 'update',
        id,
        set: { status: 'paid', 'a.b': int('1') },
        unset: ['note'],
      }),
    ).toBe(
      'db.orders.updateOne({ _id: ObjectId("507f1f77bcf86cd799439011") }, { $set: { status: "paid", "a.b": 1 }, $unset: { note: "" } })',
    )
    expect(previewChange(batch, { kind: 'delete', id })).toBe(
      'db.orders.deleteOne({ _id: ObjectId("507f1f77bcf86cd799439011") })',
    )
    expect(previewChange(batch, { kind: 'insert', document: { a: int('1') } })).toBe(
      'db.orders.insertOne({ a: 1 })',
    )
  })

  it('quotes collection names that are not identifiers', () => {
    expect(collectionRef('order-items')).toBe('db.getCollection("order-items")')
    expect(collectionRef('orders')).toBe('db.orders')
  })
})
