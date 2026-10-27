import { describe, expect, it } from 'vitest'
import { dialectInfo, dialectOf, selectRows } from './dialect'
import { buildEditStatements } from './edit'
import { buildTableSelect } from './export-table'
import { sqlLiteral } from './value'

describe('dialects', () => {
  it('quotes names the way each server does, doubling the quote inside', () => {
    expect(dialectInfo('mysql').quote('a`b')).toBe('`a``b`')
    expect(dialectInfo('postgresql').quote('a"b')).toBe('"a""b"')
    expect(dialectInfo('mssql').quote('a]b')).toBe('[a]]b]')
    expect(dialectInfo('postgresql').qualified('public', 'Orders')).toBe('"public"."Orders"')
  })

  it('knows which engines speak SQL', () => {
    expect(dialectOf('postgresql')).toBe('postgresql')
    expect(dialectOf('mssql')).toBe('mssql')
    expect(dialectOf('redis')).toBeNull()
  })

  it('limits rows with LIMIT, or TOP where there is none', () => {
    expect(selectRows('postgresql', 'public', 't', 5)).toBe('SELECT * FROM "public"."t" LIMIT 5;')
    expect(selectRows('mssql', 'dbo', 't', 5)).toBe('SELECT TOP (5) * FROM [dbo].[t];')
  })

  it('writes values the way each server reads them', () => {
    expect(sqlLiteral('a\\b', undefined, 'mysql')).toBe("'a\\\\b'")
    expect(sqlLiteral('a\\b', undefined, 'postgresql')).toBe("'a\\b'")
    expect(sqlLiteral("it's", undefined, 'mssql')).toBe("N'it''s'")
    expect(sqlLiteral(true, undefined, 'postgresql')).toBe('TRUE')
    expect(sqlLiteral(true, undefined, 'mssql')).toBe('1')
    expect(sqlLiteral(new Uint8Array([1, 255]), undefined, 'postgresql')).toBe("'\\x01ff'::bytea")
    expect(sqlLiteral(new Uint8Array([1, 255]), undefined, 'mssql')).toBe('0x01ff')
  })

  it('builds the table select and the edit statements in each dialect', () => {
    const source = { schema: 'public', table: 'o', columns: ['id'], where: 'id > 1', limit: 10 }
    expect(buildTableSelect(source, ['id', 'x'], 'postgresql')).toBe(
      'SELECT "id"\nFROM "public"."o"\nWHERE (\nid > 1\n)\nLIMIT 10',
    )
    expect(buildTableSelect(source, ['id', 'x'], 'mssql')).toBe(
      'SELECT TOP (10) [id]\nFROM [public].[o]\nWHERE (\nid > 1\n)',
    )
    const [update, insert] = buildEditStatements(
      {
        schema: 'dbo',
        table: 'o',
        changes: [
          { kind: 'update', key: { id: 1 }, values: { name: 'x' } },
          { kind: 'insert', values: {} },
        ],
      },
      {},
      'mssql',
    )
    expect(update!.sql).toBe('UPDATE [dbo].[o] SET [name] = ? WHERE [id] = ?')
    expect(update!.preview).toBe("UPDATE [dbo].[o] SET [name] = N'x' WHERE [id] = 1")
    expect(insert!.sql).toBe('INSERT INTO [dbo].[o] DEFAULT VALUES')
  })
})
