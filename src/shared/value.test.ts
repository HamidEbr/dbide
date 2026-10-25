import { describe, expect, it } from 'vitest'
import {
  cellsEqual,
  cellToEditText,
  fromHex,
  isBinaryType,
  parseEditInput,
  sqlLiteral,
  toHex,
} from './value'

const parse = (text: string, type: string) => parseEditInput(text, { type })

describe('parseEditInput', () => {
  it('parses whole numbers and rejects everything else', () => {
    expect(parse(' 42 ', 'int')).toEqual({ ok: true, value: 42 })
    expect(parse('-7', 'smallint')).toEqual({ ok: true, value: -7 })
    expect(parse('+5', 'tinyint')).toEqual({ ok: true, value: 5 })
    for (const bad of ['', '4.5', 'abc', '1e3', '0x10']) {
      expect(parse(bad, 'int')).toMatchObject({ ok: false })
    }
  })

  it('keeps bigint as text so large values survive', () => {
    expect(parse('9007199254740993', 'bigint')).toEqual({ ok: true, value: '9007199254740993' })
    expect(parse('+12', 'bigint')).toEqual({ ok: true, value: '12' })
    expect(parse('1.5', 'bigint')).toMatchObject({ ok: false })
  })

  it('keeps decimals as exact text', () => {
    expect(parse('12345.67', 'decimal')).toEqual({ ok: true, value: '12345.67' })
    expect(parse('.5', 'decimal')).toEqual({ ok: true, value: '.5' })
    expect(parse('5.', 'decimal')).toEqual({ ok: true, value: '5.' })
    expect(parse('1,5', 'decimal')).toMatchObject({ ok: false })
  })

  it('parses floats and years', () => {
    expect(parse('1.5e3', 'double')).toEqual({ ok: true, value: 1500 })
    expect(parse('', 'float')).toMatchObject({ ok: false })
    expect(parse('Infinity', 'float')).toMatchObject({ ok: false })
    expect(parse('2026', 'year')).toEqual({ ok: true, value: 2026 })
    expect(parse('26', 'year')).toMatchObject({ ok: false })
  })

  it('validates dates and times', () => {
    expect(parse('2026-03-01', 'date')).toEqual({ ok: true, value: '2026-03-01' })
    expect(parse('03/01/2026', 'date')).toMatchObject({ ok: false })
    expect(parse('2026-03-01T12:30:00', 'datetime')).toEqual({
      ok: true,
      value: '2026-03-01 12:30:00',
    })
    expect(parse('2026-03-01 12:30:00.123456', 'timestamp')).toMatchObject({ ok: true })
    expect(parse('2026-03-01', 'datetime')).toMatchObject({ ok: false })
    expect(parse('-12:30:00', 'time')).toMatchObject({ ok: true })
    expect(parse('12:30', 'time')).toMatchObject({ ok: false })
  })

  it('validates JSON and keeps the text as typed', () => {
    expect(parse('{"a": 1}', 'json')).toEqual({ ok: true, value: '{"a": 1}' })
    const bad = parse('{a: 1}', 'json')
    expect(bad.ok).toBe(false)
  })

  it('takes binary as hex', () => {
    const ok = parse('0x0102ff', 'blob')
    expect(ok.ok && [...(ok.value as Uint8Array)]).toEqual([1, 2, 255])
    expect(parse('0x', 'varbinary')).toMatchObject({ ok: true })
    expect(parse('hello', 'blob')).toMatchObject({ ok: false })
    expect(parse('0xABC', 'blob')).toMatchObject({ ok: false })
  })

  it('leaves text, enum, and set untouched, including whitespace and the empty string', () => {
    expect(parse('  padded  ', 'varchar')).toEqual({ ok: true, value: '  padded  ' })
    expect(parse('', 'text')).toEqual({ ok: true, value: '' })
    expect(parse('b', 'enum')).toEqual({ ok: true, value: 'b' })
  })
})

describe('cellsEqual', () => {
  it('treats NULL and empty as different', () => {
    expect(cellsEqual(null, '', 'varchar')).toBe(false)
    expect(cellsEqual(null, null, 'varchar')).toBe(true)
  })

  it('compares numbers by value for numeric columns only', () => {
    expect(cellsEqual('1.50', '1.5', 'decimal')).toBe(true)
    expect(cellsEqual(3, '3', 'int')).toBe(true)
    expect(cellsEqual('1.50', '1.5', 'varchar')).toBe(false)
  })

  it('never calls two long digit strings equal unless identical', () => {
    expect(cellsEqual('9007199254740993', '9007199254740992', 'bigint')).toBe(false)
    expect(cellsEqual('9007199254740993', '9007199254740993', 'bigint')).toBe(true)
  })

  it('compares bytes', () => {
    expect(cellsEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]), 'blob')).toBe(true)
    expect(cellsEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]), 'blob')).toBe(false)
    expect(cellsEqual(new Uint8Array([1]), '1', 'blob')).toBe(false)
  })

  it('knows an unset value is not NULL', () => {
    expect(cellsEqual(undefined, null, 'int')).toBe(false)
    expect(cellsEqual(undefined, undefined, 'int')).toBe(true)
  })
})

describe('hex helpers and literals', () => {
  it('round-trips hex', () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe('000fff')
    expect([...fromHex('000fff')!]).toEqual([0, 15, 255])
    expect(fromHex('abc')).toBeNull()
    expect(fromHex('zz')).toBeNull()
  })

  it('writes SQL literals', () => {
    expect(sqlLiteral(null)).toBe('NULL')
    expect(sqlLiteral(undefined)).toBe('NULL')
    expect(sqlLiteral(5)).toBe('5')
    expect(sqlLiteral(Number.NaN)).toBe('NULL')
    expect(sqlLiteral("it's \\ here")).toBe("'it''s \\\\ here'")
    expect(sqlLiteral('9.99', 'decimal')).toBe('9.99')
    expect(sqlLiteral('9.99', 'varchar')).toBe("'9.99'")
    expect(sqlLiteral(new Uint8Array([1, 255]))).toBe('0x01ff')
    expect(sqlLiteral(new Uint8Array())).toBe("''")
    expect(sqlLiteral(true)).toBe('1')
  })

  it('writes editor text', () => {
    expect(cellToEditText(null)).toBe('')
    expect(cellToEditText(undefined)).toBe('')
    expect(cellToEditText(7)).toBe('7')
    expect(cellToEditText(new Uint8Array([1, 2]))).toBe('0x0102')
  })

  it('knows binary types', () => {
    expect(isBinaryType('blob')).toBe(true)
    expect(isBinaryType('text')).toBe(false)
  })
})
