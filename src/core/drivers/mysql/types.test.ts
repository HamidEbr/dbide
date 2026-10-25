import { describe, expect, it } from 'vitest'
import { describeMysqlError, MysqlError } from './errors'
import { columnTypeName, toCell, toColumnInfo, type MysqlField } from './types'

const field = (overrides: Partial<MysqlField>): MysqlField => ({
  name: 'c',
  columnType: 0x0f,
  characterSet: 255,
  flags: 0,
  ...overrides,
})

describe('columnTypeName', () => {
  it.each([
    [0x01, 'tinyint'],
    [0x03, 'int'],
    [0x08, 'bigint'],
    [0xf6, 'decimal'],
    [0x05, 'double'],
    [0x0a, 'date'],
    [0x0c, 'datetime'],
    [0x07, 'timestamp'],
    [0xf5, 'json'],
    [0xf7, 'enum'],
    [0x10, 'bit'],
  ])('maps wire type %i to %s', (columnType, name) => {
    expect(columnTypeName(field({ columnType }))).toBe(name)
  })

  it('tells text from binary by character set', () => {
    expect(columnTypeName(field({ columnType: 0xfc, characterSet: 255 }))).toBe('text')
    expect(columnTypeName(field({ columnType: 0xfc, characterSet: 63 }))).toBe('blob')
    expect(columnTypeName(field({ columnType: 0xfd, characterSet: 255 }))).toBe('varchar')
    expect(columnTypeName(field({ columnType: 0xfd, characterSet: 63 }))).toBe('varbinary')
    expect(columnTypeName(field({ columnType: 0xfe, characterSet: 255 }))).toBe('char')
    expect(columnTypeName(field({ columnType: 0xfb, characterSet: 255 }))).toBe('longtext')
  })

  it('does not throw on an unknown type', () => {
    expect(columnTypeName(field({ columnType: 0x99 }))).toBe('type 153')
  })
})

describe('toColumnInfo', () => {
  it('reads nullability from the NOT NULL flag and keeps the table name', () => {
    expect(toColumnInfo(field({ name: 'id', flags: 1, table: 'orders' }))).toEqual({
      name: 'id',
      type: 'varchar',
      nullable: false,
      table: 'orders',
    })
    expect(toColumnInfo(field({ flags: 0 })).nullable).toBe(true)
  })
})

describe('toCell', () => {
  it('copies binary values into a compact array', () => {
    const slab = new Uint8Array(1024)
    slab.set([1, 2, 3], 100)
    const view = slab.subarray(100, 103)
    const cell = toCell(view) as Uint8Array
    expect([...cell]).toEqual([1, 2, 3])
    expect(cell.buffer.byteLength).toBe(3)
  })

  it('leaves other values alone', () => {
    expect(toCell(null)).toBeNull()
    expect(toCell('text')).toBe('text')
    expect(toCell(42)).toBe(42)
  })
})

describe('describeMysqlError', () => {
  it('keeps the server message and adds what to do', () => {
    const described = describeMysqlError({
      code: 'ER_ACCESS_DENIED_ERROR',
      sqlMessage: "Access denied for user 'app'@'host' (using password: YES)",
    })
    expect(described.code).toBe('ER_ACCESS_DENIED_ERROR')
    expect(described.message).toContain("Access denied for user 'app'@'host'")
    expect(described.message).toContain('Check the username and password')
  })

  it('explains read-only rejections in the app’s words', () => {
    expect(
      describeMysqlError({ code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' }).message,
    ).toMatch(/Unlock writes/)
  })

  it('reports a cancelled query plainly', () => {
    expect(
      describeMysqlError({
        code: 'ER_QUERY_INTERRUPTED',
        sqlMessage: 'Query execution was interrupted',
      }).message,
    ).toBe('The query was cancelled.')
  })

  it('passes through errors it does not know', () => {
    expect(
      describeMysqlError({
        code: 'ER_PARSE_ERROR',
        sqlMessage: 'You have an error in your SQL syntax',
      }),
    ).toEqual({
      code: 'ER_PARSE_ERROR',
      message: 'You have an error in your SQL syntax',
    })
    expect(describeMysqlError(new Error('plain')).message).toBe('plain')
  })

  it('MysqlError carries the code', () => {
    const error = new MysqlError({ code: 'ER_BAD_DB_ERROR', sqlMessage: "Unknown database 'x'" })
    expect(error.code).toBe('ER_BAD_DB_ERROR')
    expect(error.message).toContain("Unknown database 'x'")
  })
})
