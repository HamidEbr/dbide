import { describe, expect, it } from 'vitest'
import { columnNameOf, formatOfFile, inferColumnType, tableNameOfFile } from './import'

describe('inferColumnType', () => {
  it('picks the narrowest type that holds every value', () => {
    expect(inferColumnType(['1', '-20', '3'])).toBe('BIGINT')
    expect(inferColumnType(['1', '2.5'])).toBe('DOUBLE')
    expect(inferColumnType(['2026-01-02', '2026-12-31'])).toBe('DATE')
    expect(inferColumnType(['2026-01-02 10:00:00', '2026-01-02T10:00'])).toBe('DATETIME')
    expect(inferColumnType(['a', 'bcd'])).toBe('VARCHAR(50)')
    expect(inferColumnType(['x'.repeat(120)])).toBe('VARCHAR(255)')
    expect(inferColumnType(['x'.repeat(300)])).toBe('TEXT')
  })

  it('ignores empty values, and keeps text that looks like a number with leading zeros as text', () => {
    expect(inferColumnType(['', null, '7'])).toBe('BIGINT')
    expect(inferColumnType([null, ''])).toBe('VARCHAR(255)')
    expect(inferColumnType(['007', '12'])).toBe('VARCHAR(50)')
    expect(inferColumnType(['12345678901234567890'])).toBe('VARCHAR(50)')
  })
})

describe('names', () => {
  it('guesses the format, the table and the columns from names', () => {
    expect(formatOfFile('a.TSV')).toBe('tsv')
    expect(formatOfFile('a.jsonl')).toBe('ndjson')
    expect(formatOfFile('a.txt')).toBe('csv')
    expect(tableNameOfFile('orders-2026 final.csv')).toBe('orders_2026_final')
    expect(tableNameOfFile('2026.csv')).toBe('t_2026')
    expect(columnNameOf(' First name ', 0)).toBe('First_name')
    expect(columnNameOf('', 2)).toBe('column_3')
  })
})
