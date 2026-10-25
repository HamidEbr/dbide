import { describe, expect, it } from 'vitest'
import type { ColumnInfo } from './driver'
import { buildEditStatements, singleSourceTable, type EditBatch } from './edit'

const types = { id: 'int', name: 'varchar', price: 'decimal', blob: 'blob' }
const batch = (changes: EditBatch['changes']): EditBatch => ({
  schema: 'shop',
  table: 'items',
  changes,
})

describe('buildEditStatements', () => {
  it('updates by primary key with bound parameters and a readable preview', () => {
    const [statement] = buildEditStatements(
      batch([{ kind: 'update', key: { id: 7 }, values: { name: "O'Brien", price: '9.99' } }]),
      types,
    )
    expect(statement).toEqual({
      kind: 'update',
      sql: 'UPDATE `shop`.`items` SET `name` = ?, `price` = ? WHERE `id` = ?',
      params: ["O'Brien", '9.99', 7],
      preview: "UPDATE `shop`.`items` SET `name` = 'O''Brien', `price` = 9.99 WHERE `id` = 7",
    })
  })

  it('addresses a composite key with AND', () => {
    const [statement] = buildEditStatements(
      batch([{ kind: 'delete', key: { id: 1, name: 'a' } }]),
      types,
    )
    expect(statement!.sql).toBe('DELETE FROM `shop`.`items` WHERE `id` = ? AND `name` = ?')
    expect(statement!.params).toEqual([1, 'a'])
    expect(statement!.preview).toBe("DELETE FROM `shop`.`items` WHERE `id` = 1 AND `name` = 'a'")
  })

  it('inserts only the values that were given, so defaults and auto-increment apply', () => {
    const [statement] = buildEditStatements(
      batch([{ kind: 'insert', values: { name: 'x' } }]),
      types,
    )
    expect(statement!.sql).toBe('INSERT INTO `shop`.`items` (`name`) VALUES (?)')
    expect(statement!.params).toEqual(['x'])
  })

  it('inserts a row of pure defaults', () => {
    const [statement] = buildEditStatements(batch([{ kind: 'insert', values: {} }]), types)
    expect(statement!.sql).toBe('INSERT INTO `shop`.`items` () VALUES ()')
    expect(statement!.params).toEqual([])
  })

  it('writes NULL and binary values into the preview', () => {
    const [statement] = buildEditStatements(
      batch([
        { kind: 'update', key: { id: 1 }, values: { name: null, blob: new Uint8Array([1, 255]) } },
      ]),
      types,
    )
    expect(statement!.preview).toBe(
      'UPDATE `shop`.`items` SET `name` = NULL, `blob` = 0x01ff WHERE `id` = 1',
    )
  })

  it('escapes backticks in names', () => {
    const [statement] = buildEditStatements(
      { schema: 'we`ird', table: 'ta`ble', changes: [{ kind: 'delete', key: { 'i`d': 1 } }] },
      {},
    )
    expect(statement!.sql).toBe('DELETE FROM `we``ird`.`ta``ble` WHERE `i``d` = ?')
  })

  it('keeps the order of changes', () => {
    const statements = buildEditStatements(
      batch([
        { kind: 'delete', key: { id: 1 } },
        { kind: 'insert', values: { name: 'a' } },
        { kind: 'update', key: { id: 2 }, values: { name: 'b' } },
      ]),
      types,
    )
    expect(statements.map((s) => s.kind)).toEqual(['delete', 'insert', 'update'])
  })

  it('refuses changes that would touch the whole table', () => {
    expect(() => buildEditStatements(batch([{ kind: 'delete', key: {} }]), types)).toThrow(
      /primary key/,
    )
    expect(() =>
      buildEditStatements(batch([{ kind: 'update', key: { id: 1 }, values: {} }]), types),
    ).toThrow(/at least one value/)
  })
})

describe('singleSourceTable', () => {
  const col = (name: string, source?: ColumnInfo['source']): ColumnInfo => ({
    name,
    type: 'int',
    ...(source ? { source } : {}),
  })

  it('finds the table when every column is a plain column of it', () => {
    expect(
      singleSourceTable([
        col('id', { schema: 's', table: 't', column: 'id' }),
        col('alias', { schema: 's', table: 't', column: 'name' }),
      ]),
    ).toEqual({ schema: 's', table: 't' })
  })

  it('says why a result with a computed column is read-only', () => {
    const result = singleSourceTable([
      col('id', { schema: 's', table: 't', column: 'id' }),
      col('total'),
    ])
    expect(result).toEqual({ reason: '“total” is computed, so these rows can’t be edited.' })
  })

  it('refuses a join', () => {
    const result = singleSourceTable([
      col('a', { schema: 's', table: 't1', column: 'a' }),
      col('b', { schema: 's', table: 't2', column: 'b' }),
    ])
    expect(result).toMatchObject({ reason: expect.stringContaining('joins') })
  })

  it('treats the same table name in another schema as a different table', () => {
    const result = singleSourceTable([
      col('a', { schema: 's1', table: 't', column: 'a' }),
      col('b', { schema: 's2', table: 't', column: 'b' }),
    ])
    expect(result).toHaveProperty('reason')
  })

  it('handles an empty result', () => {
    expect(singleSourceTable([])).toHaveProperty('reason')
  })
})
