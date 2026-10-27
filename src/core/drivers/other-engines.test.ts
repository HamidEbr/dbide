import { describe, expect, it } from 'vitest'
import { describeMssqlError } from './mssql/errors'
import { formatType, toCell as mssqlCell } from './mssql/types'
import { describePgError } from './postgres/errors'
import { toCell as pgCell, toColumnInfo, typeParsers } from './postgres/types'

describe('PostgreSQL values', () => {
  it('hands values over as the text the server wrote, but booleans and bytes as themselves', () => {
    expect(typeParsers.getTypeParser(1114)('2026-01-02 03:04:05')).toBe('2026-01-02 03:04:05')
    expect(typeParsers.getTypeParser(20)('9007199254740993')).toBe('9007199254740993')
    expect(typeParsers.getTypeParser(16)('t')).toBe(true)
    expect(typeParsers.getTypeParser(16)('f')).toBe(false)
    expect([...(typeParsers.getTypeParser(17)('\\x01ff') as Uint8Array)]).toEqual([1, 255])
  })

  it('names columns the way the grid knows them, with where they come from', () => {
    expect(toColumnInfo({ name: 'n', dataTypeID: 23, tableID: 0, columnID: 0 }, undefined)).toEqual(
      {
        name: 'n',
        type: 'int',
      },
    )
    expect(
      toColumnInfo(
        { name: 'id', dataTypeID: 20, tableID: 5, columnID: 1 },
        { schema: 'public', table: 't', column: 'id' },
      ),
    ).toMatchObject({ type: 'bigint', source: { table: 't' }, table: 't' })
    expect(pgCell(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z')
    expect(pgCell({ a: 1 })).toBe('{"a":1}')
  })

  it('explains the common failures and keeps the server’s words', () => {
    expect(
      describePgError({ code: '28P01', message: 'password authentication failed' }).message,
    ).toMatch(/Check the username and password/)
    expect(
      describePgError({ code: '23505', message: 'duplicate key', detail: 'Key (id)=(1) exists.' }),
    ).toEqual({
      code: '23505',
      message: 'duplicate key. Key (id)=(1) exists.',
    })
  })
})

describe('SQL Server values', () => {
  it('writes dates as the server prints them, with no zone shift', () => {
    const d = new Date('2026-01-02T03:04:05.123Z')
    expect(mssqlCell(d, 'date')).toBe('2026-01-02')
    expect(mssqlCell(d, 'time')).toBe('03:04:05.123')
    expect(mssqlCell(d, 'datetime2')).toBe('2026-01-02 03:04:05.123')
    expect(mssqlCell(d, 'datetimeoffset')).toBe('2026-01-02T03:04:05.123Z')
    expect(mssqlCell(Buffer.from([1, 2]), 'varbinary')).toEqual(new Uint8Array([1, 2]))
    expect(mssqlCell(null, 'int')).toBeNull()
  })

  it('writes a column type from the catalog’s numbers', () => {
    expect(formatType('nvarchar', 100, 0, 0)).toBe('nvarchar(50)')
    expect(formatType('varchar', -1, 0, 0)).toBe('varchar(max)')
    expect(formatType('decimal', 9, 10, 2)).toBe('decimal(10,2)')
    expect(formatType('datetime2', 8, 27, 7)).toBe('datetime2(7)')
    expect(formatType('int', 4, 10, 0)).toBe('int')
  })

  it('explains a failed login and keeps the number of a server error', () => {
    expect(describeMssqlError({ code: 'ELOGIN', message: 'Login failed' }).message).toMatch(
      /Check the username/,
    )
    expect(describeMssqlError({ number: 208, message: 'Invalid object name' })).toEqual({
      code: 'MSSQL_208',
      message: 'Invalid object name',
    })
  })
})
