import { describe, expect, it } from 'vitest'
import { classifyStatement, splitStatements } from './sql'
import { buildTableSelect, quoteIdentifier, type TableExport } from './export-table'

const all = ['id', 'name', 'created at']
const base: TableExport = { schema: 'shop', table: 'orders', columns: null, where: '', limit: null }

describe('buildTableSelect', () => {
  it('reads every column of the table as *', () => {
    expect(buildTableSelect(base, all)).toBe('SELECT *\nFROM `shop`.`orders`')
    // Naming every column, in any order, is still all of them.
    expect(buildTableSelect({ ...base, columns: ['name', 'id', 'created at'] }, all)).toBe(
      'SELECT *\nFROM `shop`.`orders`',
    )
  })

  it('names only the columns that were chosen, quoted', () => {
    expect(buildTableSelect({ ...base, columns: ['id', 'created at'] }, all)).toBe(
      'SELECT `id`, `created at`\nFROM `shop`.`orders`',
    )
  })

  it('adds a condition and a limit, each on its own lines', () => {
    const sql = buildTableSelect({ ...base, where: "status = 'paid'", limit: 500 }, all)
    expect(sql).toBe("SELECT *\nFROM `shop`.`orders`\nWHERE (\nstatus = 'paid'\n)\nLIMIT 500")
  })

  it('ignores a blank condition, and keeps a limit of zero', () => {
    expect(buildTableSelect({ ...base, where: '   ' }, all)).not.toContain('WHERE')
    expect(buildTableSelect({ ...base, limit: 0 }, all)).toContain('LIMIT 0')
    expect(buildTableSelect({ ...base, limit: 2.9 }, all)).toContain('LIMIT 2')
  })

  it('quotes a name that holds a backtick', () => {
    expect(quoteIdentifier('we`ird')).toBe('`we``ird`')
    expect(buildTableSelect({ ...base, schema: 'a`b', table: 'c d' }, all)).toContain(
      '`a``b`.`c d`',
    )
  })

  it('is one statement that only reads, so the core accepts it', () => {
    const sql = buildTableSelect({ ...base, where: 'x = 1 -- comment', limit: 10 }, all)
    expect(splitStatements(sql)).toHaveLength(1)
    expect(classifyStatement(sql).kind).toBe('read')
  })

  it('leaves a second statement in the condition for the core to refuse', () => {
    const sql = buildTableSelect({ ...base, where: '1=1); DROP TABLE orders; --' }, all)
    expect(splitStatements(sql).length).toBeGreaterThan(1)
  })
})
