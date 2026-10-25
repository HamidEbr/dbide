import { describe, expect, it } from 'vitest'
import { evaluate } from './eval'
import { formatShell, type Json } from './ejson'
import { MongoSyntaxError, parseMongoValue } from './lang'

const run = (text: string): Json => evaluate(parseMongoValue(text))
const shell = (text: string): string => formatShell(run(text))

describe('evaluate', () => {
  it('types numbers the way the shell does', () => {
    expect(run('5')).toEqual({ $numberInt: '5' })
    expect(run('-5')).toEqual({ $numberInt: '-5' })
    expect(run('5.0')).toEqual({ $numberDouble: '5.0' })
    expect(run('1.5')).toEqual({ $numberDouble: '1.5' })
    expect(run('3000000000')).toEqual({ $numberDouble: '3000000000.0' })
    expect(run('1e3')).toEqual({ $numberDouble: '1000.0' })
    expect(run('Infinity')).toEqual({ $numberDouble: 'Infinity' })
    expect(run('-0')).toEqual({ $numberDouble: '-0.0' })
    expect(run('7 / 2')).toEqual({ $numberDouble: '3.5' })
    expect(run('2 * 3 + 4')).toEqual({ $numberInt: '10' })
  })

  it('builds documents, arrays and plain values', () => {
    expect(run('{ a: 1, "b c": [true, null, undefined, "x"], $gt: 2 }')).toEqual({
      a: { $numberInt: '1' },
      'b c': [true, null, null, 'x'],
      $gt: { $numberInt: '2' },
    })
  })

  it('builds every BSON type', () => {
    expect(run('ObjectId("507F1F77BCF86CD799439011")')).toEqual({
      $oid: '507f1f77bcf86cd799439011',
    })
    expect(run('ISODate("2024-05-17T09:30:00Z")')).toEqual({
      $date: { $numberLong: '1715938200000' },
    })
    expect(run('new Date(0)')).toEqual({ $date: { $numberLong: '0' } })
    expect(run('NumberLong("9007199254740993")')).toEqual({ $numberLong: '9007199254740993' })
    expect(run('NumberLong(5)')).toEqual({ $numberLong: '5' })
    expect(run('NumberInt("7")')).toEqual({ $numberInt: '7' })
    expect(run('Double(5)')).toEqual({ $numberDouble: '5.0' })
    expect(run('NumberDecimal("12.50")')).toEqual({ $numberDecimal: '12.50' })
    expect(run('Timestamp(1700000000, 3)')).toEqual({ $timestamp: { t: 1700000000, i: 3 } })
    expect(run('Timestamp({ t: 1, i: 2 })')).toEqual({ $timestamp: { t: 1, i: 2 } })
    expect(run('UUID("12345678-9abc-def0-1234-56789abcdef0")')).toEqual({
      $binary: { base64: 'EjRWeJq83vASNFZ4mrze8A==', subType: '04' },
    })
    expect(run('BinData(0, "AQID")')).toEqual({ $binary: { base64: 'AQID', subType: '00' } })
    expect(run('HexData(0, "010203")')).toEqual({ $binary: { base64: 'AQID', subType: '00' } })
    expect(run('/ab+c/gi')).toEqual({ $regularExpression: { pattern: 'ab+c', options: 'i' } })
    expect(run('new RegExp("x", "ms")')).toEqual({
      $regularExpression: { pattern: 'x', options: 'ms' },
    })
    expect(run('MinKey()')).toEqual({ $minKey: 1 })
    expect(run('MaxKey()')).toEqual({ $maxKey: 1 })
    expect(run('Code("function() {}")')).toEqual({ $code: 'function() {}' })
  })

  it('generates ids and times', () => {
    const id = run('ObjectId()') as { $oid: string }
    expect(id.$oid).toMatch(/^[0-9a-f]{24}$/)
    expect((run('ObjectId()') as { $oid: string }).$oid).not.toBe(id.$oid)
    const seconds = parseInt(id.$oid.slice(0, 8), 16)
    expect(Math.abs(seconds - Date.now() / 1000)).toBeLessThan(5)
    expect((run('UUID()') as { $binary: { subType: string } }).$binary.subType).toBe('04')
    const before = Date.now()
    const now = Number((run('new Date()') as { $date: { $numberLong: string } }).$date.$numberLong)
    expect(now).toBeGreaterThanOrEqual(before)
    expect(run('Date.now() - Date.now()')).toEqual({ $numberInt: '0' })
  })

  it('does date arithmetic like JavaScript', () => {
    const week = run('new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)') as {
      $date: { $numberLong: string }
    }
    expect(Date.now() - Number(week.$date.$numberLong)).toBeGreaterThan(6.99 * 86400000)
    expect(run('new Date("2024-01-02T00:00:00Z") - new Date("2024-01-01T00:00:00Z")')).toEqual({
      $numberInt: '86400000',
    })
    expect(run('"a" + 1 + "b"')).toBe('a1b')
    expect(run('Math.floor(7 / 2)')).toEqual({ $numberInt: '3' })
    expect(run('Math.max(1, 5, 3)')).toEqual({ $numberInt: '5' })
  })

  it('calls a few methods on values', () => {
    expect(run('ObjectId("507f1f77bcf86cd799439011").getTimestamp()')).toEqual({
      $date: { $numberLong: '1350508407000' },
    })
    expect(run('ObjectId("507f1f77bcf86cd799439011").toHexString()')).toBe(
      '507f1f77bcf86cd799439011',
    )
    expect(run('ISODate("1970-01-01T00:00:01Z").getTime()')).toEqual({ $numberInt: '1000' })
  })

  it('writes what it reads, so a document survives being edited as text', () => {
    const text = `{
      _id: ObjectId("507f1f77bcf86cd799439011"),
      n: 5, d: 5.0, big: NumberLong("9007199254740993"), price: NumberDecimal("1.10"),
      at: ISODate("2024-05-17T09:30:00.000Z"), re: /a\\/b/i, nested: { list: [1, "x", null] },
      uid: UUID("12345678-9abc-def0-1234-56789abcdef0"), bin: BinData(0, "AQID"),
    }`
    const once = run(text)
    expect(run(formatShell(once, { indent: 2 }))).toEqual(once)
    expect(run(formatShell(once))).toEqual(once)
  })
})

describe('errors', () => {
  const message = (text: string): string => {
    try {
      run(text)
    } catch (error) {
      expect(error).toBeInstanceOf(MongoSyntaxError)
      return (error as MongoSyntaxError).message
    }
    throw new Error('did not throw')
  }

  it('explains a bad value where it is typed', () => {
    expect(message('ObjectId("nope")')).toMatch(/24 hexadecimal/)
    expect(message('ISODate("yesterday")')).toMatch(/not a date/)
    expect(message('NumberLong("1.5")')).toMatch(/not a whole number/)
    expect(message('NumberLong("99999999999999999999")')).toMatch(/does not fit/)
    expect(message('NumberLong(9007199254740993)')).toMatch(/as text/)
    expect(message('NumberInt(3000000000)')).toMatch(/between/)
    expect(message('NumberDecimal("abc")')).toMatch(/not a decimal/)
    expect(message('UUID("123")')).toMatch(/not a UUID/)
    expect(message('BinData(0, "***")')).toMatch(/base64/)
  })

  it('says variables and functions are not available', () => {
    expect(message('{ a: someVariable }')).toMatch(/Variables are not supported/)
    expect(message('{ a: ObjectId }')).toMatch(/is a function/)
    expect(message('{ a: foo() }')).toMatch(/not supported/)
    expect(message('{ a: x.y }')).toMatch(/not supported/)
    expect(message('{ a: [1][0] }')).toMatch(/Indexing/)
  })

  it('points at the offending text', () => {
    try {
      run('{ a: 1, b: ObjectId("zz") }')
    } catch (error) {
      expect((error as MongoSyntaxError).at).toBe('{ a: 1, b: '.length)
    }
  })

  it('shows how a value reads once typed', () => {
    expect(shell('{ n: 5, d: 5.0 }')).toBe('{ n: 5, d: 5.0 }')
  })
})
