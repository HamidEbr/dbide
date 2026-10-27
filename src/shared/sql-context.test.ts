import { describe, expect, it } from 'vitest'
import { insideLiteral } from './sql'
import { analyzeSql, type SqlContext } from './sql-context'

/** The context at the `|` in a script. */
function at(script: string): SqlContext {
  const offset = script.indexOf('|')
  return analyzeSql(script.replace('|', ''), offset)
}

const tableNames = (c: SqlContext): string[] =>
  c.kind === 'column'
    ? c.tables.map(
        (t) => `${t.database ? t.database + '.' : ''}${t.table}${t.alias ? ' ' + t.alias : ''}`,
      )
    : []

describe('where a name goes', () => {
  it('starts a statement with a keyword', () => {
    expect(at('|')).toMatchObject({ kind: 'keyword', atStart: true, prefix: '' })
    expect(at('sel|')).toMatchObject({ kind: 'keyword', atStart: true, prefix: 'sel' })
    expect(at('SELECT 1; |')).toMatchObject({ kind: 'keyword', atStart: true })
    expect(at('SELECT 1;\nup|')).toMatchObject({ kind: 'keyword', atStart: true, prefix: 'up' })
  })

  it('names a table after FROM, JOIN, UPDATE, INTO and DELETE FROM', () => {
    for (const script of [
      'SELECT * FROM |',
      'SELECT * FROM ord|',
      'SELECT * FROM a JOIN |',
      'SELECT * FROM a LEFT OUTER JOIN cu|',
      'UPDATE |',
      'UPDATE LOW_PRIORITY IGNORE |',
      'INSERT INTO |',
      'REPLACE INTO or|',
      'DELETE FROM |',
      'TRUNCATE TABLE |',
      'DROP TABLE IF EXISTS |',
      'DESCRIBE |',
      'DESC or|',
      'EXPLAIN |',
    ]) {
      expect(at(script), script).toMatchObject({ kind: 'table', qualifier: null })
    }
  })

  it('names the next table of a comma list', () => {
    expect(at('SELECT * FROM orders o, |')).toMatchObject({ kind: 'table' })
    expect(at('SELECT * FROM orders o, cust|')).toMatchObject({ kind: 'table', prefix: 'cust' })
  })

  it('offers keywords, not tables, once a table is complete', () => {
    expect(at('SELECT * FROM orders |')).toMatchObject({ kind: 'keyword', atStart: false })
    expect(at('SELECT * FROM orders o |')).toMatchObject({ kind: 'keyword' })
    expect(at('SELECT * FROM orders AS |')).toMatchObject({ kind: 'none' })
  })

  it('names a database after USE', () => {
    expect(at('USE |')).toMatchObject({ kind: 'database', prefix: '' })
    expect(at('use sh|')).toMatchObject({ kind: 'database', prefix: 'sh' })
  })

  it('takes a database qualifier before a table', () => {
    expect(at('SELECT * FROM shop.|')).toMatchObject({
      kind: 'table',
      qualifier: 'shop',
      prefix: '',
    })
    expect(at('SELECT * FROM `my db`.or|')).toMatchObject({
      kind: 'table',
      qualifier: 'my db',
      prefix: 'or',
    })
  })

  it('names a column in the select list, from the tables that come after it', () => {
    const c = at('SELECT | FROM orders o JOIN customers c ON o.customer = c.name')
    expect(c).toMatchObject({ kind: 'column', clause: 'select', qualifier: null })
    expect(tableNames(c)).toEqual(['orders o', 'customers c'])
  })

  it('names a column after WHERE, AND, ON, GROUP BY, ORDER BY, HAVING and SET', () => {
    const cases: [string, string][] = [
      ['SELECT * FROM orders WHERE |', 'where'],
      ['SELECT * FROM orders WHERE id = 1 AND |', 'where'],
      ['SELECT * FROM orders o JOIN c ON |', 'on'],
      ['SELECT * FROM orders GROUP BY |', 'group'],
      ['SELECT * FROM orders ORDER BY id, |', 'group'],
      ['SELECT count(*) FROM orders GROUP BY id HAVING |', 'having'],
      ['UPDATE orders SET |', 'set'],
      ['UPDATE orders SET a = 1, |', 'set'],
    ]
    for (const [script, clause] of cases) {
      expect(at(script), script).toMatchObject({ kind: 'column', clause })
    }
  })

  it('takes an alias or table before the dot', () => {
    const c = at('SELECT o.| FROM orders o')
    expect(c).toMatchObject({ kind: 'column', qualifier: 'o', qualifierDatabase: null, prefix: '' })
    expect(tableNames(c)).toEqual(['orders o'])
    expect(at('SELECT o.cu| FROM orders o')).toMatchObject({ qualifier: 'o', prefix: 'cu' })
    expect(at('SELECT shop.orders.| FROM shop.orders')).toMatchObject({
      kind: 'column',
      qualifier: 'orders',
      qualifierDatabase: 'shop',
    })
    expect(at('SELECT `o`.| FROM orders `o`')).toMatchObject({ qualifier: 'o' })
  })

  it('reads aliases with and without AS, and tables with a database', () => {
    expect(tableNames(at('SELECT | FROM shop.orders AS o, customers'))).toEqual([
      'shop.orders o',
      'customers',
    ])
    expect(tableNames(at('SELECT | FROM orders WHERE x = 1'))).toEqual(['orders'])
    expect(tableNames(at('SELECT | FROM orders LEFT JOIN b USING (id)'))).toEqual(['orders', 'b'])
    expect(tableNames(at('SELECT | FROM orders ORDER BY id'))).toEqual(['orders'])
  })

  it('reads the tables of an UPDATE and a DELETE for their columns', () => {
    expect(tableNames(at('UPDATE orders SET | WHERE id = 1'))).toEqual(['orders'])
    expect(tableNames(at('DELETE FROM orders WHERE |'))).toEqual(['orders'])
  })

  it('names the columns of the table being inserted into', () => {
    const c = at('INSERT INTO orders (id, |')
    expect(c).toMatchObject({ kind: 'column', clause: 'insert' })
    expect(tableNames(c)).toEqual(['orders'])
    expect(tableNames(at('INSERT INTO shop.orders (|'))).toEqual(['shop.orders'])
    expect(at('INSERT INTO orders (id) VALUES (|')).toMatchObject({ kind: 'none' })
  })

  it('has nothing to say where a name does not go', () => {
    expect(at("SELECT 'abc|def'")).toEqual({ kind: 'none' })
    expect(at('SELECT 1 -- comm|ent')).toEqual({ kind: 'none' })
    expect(at('SELECT 1 /* a| */')).toEqual({ kind: 'none' })
    expect(at('SELECT * FROM orders LIMIT |')).toEqual({ kind: 'none' })
    expect(at('SET NAMES |')).toEqual({ kind: 'none' })
    // A dot after a name that no table in the statement answers to is still asked about: it may be a table or a database.
    expect(at('SELECT o.| ')).toMatchObject({ kind: 'column', qualifier: 'o', tables: [] })
  })

  it('works inside a quoted name', () => {
    expect(at('SELECT * FROM `ord|')).toMatchObject({ kind: 'table', prefix: 'ord', quoted: true })
    expect(at('SELECT * FROM `ord`|')).toMatchObject({ kind: 'keyword' })
  })

  it('works with several statements, taking the one the cursor is in', () => {
    const c = at('SELECT * FROM a;\nSELECT | FROM b;\nSELECT * FROM c;')
    expect(tableNames(c)).toEqual(['b'])
    expect(at('SELECT 1;\nSELECT * FROM |;\nSELECT 2')).toMatchObject({ kind: 'table' })
  })

  it('says where the typed name starts, so a choice replaces it', () => {
    const script = 'SELECT * FROM ord'
    const c = analyzeSql(script, script.length)
    expect(c).toMatchObject({ prefix: 'ord', from: 14 })
    const dotted = 'SELECT o.cu FROM orders o'
    expect(analyzeSql(dotted, 11)).toMatchObject({ prefix: 'cu', from: 9 })
  })

  it('does not treat a column list in a subquery as a table list', () => {
    expect(at('SELECT * FROM orders WHERE id IN (SELECT | FROM customers)')).toMatchObject({
      kind: 'column',
      clause: 'select',
    })
  })
})

describe('insideLiteral', () => {
  it('is true inside a string or a comment, and false around them', () => {
    const s = "SELECT 'ab', 1 -- note\n, 2"
    expect(insideLiteral(s, 9)).toBe(true)
    expect(insideLiteral(s, 7)).toBe(false)
    expect(insideLiteral(s, 12)).toBe(false)
    expect(insideLiteral(s, 18)).toBe(true)
    expect(insideLiteral("SELECT 'open", 12)).toBe(true)
  })
})
