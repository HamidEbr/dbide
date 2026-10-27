import { describe, expect, it } from 'vitest'
import {
  classifyStatement,
  isReadOnlySafe,
  maskSql,
  normalizeSql,
  splitStatements,
  statementAt,
} from './sql'

const texts = (sql: string): string[] => splitStatements(sql).map((s) => s.text)

describe('splitStatements', () => {
  it('splits on semicolons and trims', () => {
    expect(texts('SELECT 1;  SELECT 2 ;\nSELECT 3')).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3'])
  })

  it('returns offsets that point back into the source', () => {
    const sql = 'SELECT 1;\n  SELECT 2;'
    for (const s of splitStatements(sql)) expect(sql.slice(s.from, s.to)).toBe(s.text)
  })

  it('ignores semicolons inside strings, identifiers, and comments', () => {
    expect(texts(`SELECT 'a;b', "c;d", \`e;f\`; SELECT 2`)).toEqual([
      `SELECT 'a;b', "c;d", \`e;f\``,
      'SELECT 2',
    ])
    expect(texts('SELECT 1 /* ; */; SELECT 2 -- ;\n; SELECT 3 # ;\n')).toEqual([
      'SELECT 1',
      'SELECT 2',
      'SELECT 3',
    ])
    // A comment between tokens stays; only leading and trailing ones are trimmed.
    expect(texts('SELECT /* ; */ 1;')).toEqual(['SELECT /* ; */ 1'])
  })

  it('understands escaped and doubled quotes', () => {
    expect(texts(`SELECT 'it''s; fine'; SELECT 'a\\'; b'; SELECT 3`)).toEqual([
      `SELECT 'it''s; fine'`,
      `SELECT 'a\\'; b'`,
      'SELECT 3',
    ])
  })

  it('treats -- as a comment only when followed by whitespace', () => {
    expect(texts('SELECT 5--1; SELECT 2')).toEqual(['SELECT 5--1', 'SELECT 2'])
    expect(texts('SELECT 1 -- note\n; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('drops statements that are only comments or blank', () => {
    expect(texts('-- nothing\n;;  ; /* x */ ; SELECT 1;')).toEqual(['SELECT 1'])
    expect(texts('')).toEqual([])
    expect(texts('   \n  ')).toEqual([])
  })

  it('leaves comments before a statement out of its text', () => {
    expect(texts('-- find users\nSELECT * FROM users;')).toEqual(['SELECT * FROM users'])
  })

  it('keeps executable comments in the statement', () => {
    expect(texts('CREATE TABLE t (a INT) /*!50100 PARTITION BY HASH (a) */; SELECT 1')).toEqual([
      'CREATE TABLE t (a INT) /*!50100 PARTITION BY HASH (a) */',
      'SELECT 1',
    ])
  })

  it('honors DELIMITER for stored programs', () => {
    const sql = [
      'DELIMITER $$',
      'CREATE PROCEDURE p()',
      'BEGIN',
      '  SELECT 1;',
      '  SELECT 2;',
      'END$$',
      'DELIMITER ;',
      'CALL p();',
    ].join('\n')
    expect(texts(sql)).toEqual([
      'CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND',
      'CALL p()',
    ])
  })

  it('supports multi-character delimiters', () => {
    expect(texts('DELIMITER //\nSELECT 1;//\nSELECT 2//')).toEqual(['SELECT 1;', 'SELECT 2'])
  })

  it('handles an unterminated string or comment without hanging', () => {
    expect(texts("SELECT 'oops; SELECT 2")).toEqual(["SELECT 'oops; SELECT 2"])
    expect(texts('SELECT 1; /* never closed')).toEqual(['SELECT 1'])
  })

  it('splits Windows line endings', () => {
    expect(texts('SELECT 1;\r\nSELECT 2;\r\n')).toEqual(['SELECT 1', 'SELECT 2'])
  })
})

describe('statementAt', () => {
  const sql = 'SELECT 1;\n\nSELECT 2;\n\n-- end'
  const statements = splitStatements(sql)

  it('returns the statement containing the cursor', () => {
    expect(statementAt(statements, 3)?.text).toBe('SELECT 1')
    expect(statementAt(statements, sql.indexOf('SELECT 2') + 4)?.text).toBe('SELECT 2')
  })

  it('treats the position right after the semicolon as that statement', () => {
    expect(statementAt(statements, 'SELECT 1;'.length)?.text).toBe('SELECT 1')
  })

  it('picks the statement above when the cursor is between statements', () => {
    expect(statementAt(statements, 'SELECT 1;\n'.length)?.text).toBe('SELECT 1')
    expect(statementAt(statements, sql.length)?.text).toBe('SELECT 2')
  })

  it('picks the first statement before it and nothing for an empty script', () => {
    expect(statementAt(splitStatements('\n\nSELECT 1'), 0)?.text).toBe('SELECT 1')
    expect(statementAt([], 0)).toBeNull()
  })
})

describe('maskSql', () => {
  it('blanks strings and comments but keeps length and keywords', () => {
    const sql = "SELECT 'DELETE' -- DROP\nFROM `where`"
    const masked = maskSql(sql)
    expect(masked).toHaveLength(sql.length)
    expect(masked).not.toMatch(/DELETE|DROP|where/)
    expect(masked).toMatch(/SELECT/)
    expect(masked).toMatch(/FROM/)
  })
})

describe('classifyStatement', () => {
  it.each([
    ['SELECT * FROM t', 'read'],
    ['  (SELECT 1) UNION (SELECT 2)', 'read'],
    ['show tables', 'read'],
    ['EXPLAIN SELECT 1', 'read'],
    ['WITH x AS (SELECT 1) SELECT * FROM x', 'read'],
    ['WITH x AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT * FROM x)', 'write'],
    ['INSERT INTO t VALUES (1)', 'write'],
    ['REPLACE INTO t VALUES (1)', 'write'],
    ['CALL do_things()', 'write'],
    ['CREATE TABLE t (a INT)', 'ddl'],
    ['ALTER TABLE t ADD COLUMN b INT', 'ddl'],
    ['GRANT ALL ON *.* TO x', 'admin'],
    ['KILL 12', 'admin'],
    ['BEGIN', 'transaction'],
    ['COMMIT', 'transaction'],
    ['USE shop', 'session'],
    ['SET @a = 1', 'session'],
    ['', 'unknown'],
    ['-- only a comment', 'unknown'],
  ])('classifies %j as %s', (sql, kind) => {
    expect(classifyStatement(sql).kind).toBe(kind)
  })

  it('flags DELETE and UPDATE without WHERE as destructive', () => {
    expect(classifyStatement('DELETE FROM orders')).toMatchObject({ destructive: true })
    expect(classifyStatement('UPDATE orders SET status = 1')).toMatchObject({ destructive: true })
    expect(classifyStatement('DELETE FROM orders WHERE id = 1').destructive).toBe(false)
    expect(classifyStatement('UPDATE orders SET status = 1 WHERE id = 2').destructive).toBe(false)
  })

  it('does not mistake a WHERE inside a string or comment for a real one', () => {
    expect(classifyStatement('DELETE FROM t -- WHERE id = 1').destructive).toBe(true)
    expect(classifyStatement("UPDATE t SET note = 'where it began'").destructive).toBe(true)
  })

  it('flags DROP, TRUNCATE, and ALTER ... DROP', () => {
    expect(classifyStatement('DROP TABLE t')).toMatchObject({ kind: 'ddl', destructive: true })
    expect(classifyStatement('TRUNCATE TABLE t').destructive).toBe(true)
    expect(classifyStatement('ALTER TABLE t DROP COLUMN a').destructive).toBe(true)
    expect(classifyStatement('ALTER TABLE t ADD COLUMN a INT').destructive).toBe(false)
  })

  it('gives a reason for destructive statements and none otherwise', () => {
    expect(classifyStatement('DELETE FROM t').reason).toMatch(/WHERE/)
    expect(classifyStatement('SELECT 1').reason).toBeUndefined()
  })

  it('knows which statements are safe on a read-only connection', () => {
    expect(isReadOnlySafe(classifyStatement('SELECT 1'))).toBe(true)
    expect(isReadOnlySafe(classifyStatement('USE shop'))).toBe(true)
    expect(isReadOnlySafe(classifyStatement('INSERT INTO t VALUES (1)'))).toBe(false)
    expect(isReadOnlySafe(classifyStatement('DROP TABLE t'))).toBe(false)
  })
})

describe('other servers’ SQL', () => {
  it('splits PostgreSQL scripts around dollar-quoted bodies and double-quoted names', () => {
    const script = `CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;
SELECT "a;b" FROM "t" -- done;
;SELECT 'it''s; fine'`
    expect(splitStatements(script, 'postgresql').map((s) => s.text)).toEqual([
      'CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql',
      'SELECT "a;b" FROM "t"',
      "SELECT 'it''s; fine'",
    ])
    // A backslash does not escape a quote in standard PostgreSQL strings.
    expect(splitStatements("SELECT 'a\\'; SELECT 2", 'postgresql').map((s) => s.text)).toEqual([
      "SELECT 'a\\'",
      'SELECT 2',
    ])
  })

  it('splits SQL Server scripts at GO, and keeps #temp tables and [brackets] whole', () => {
    const script = 'SELECT [a;b] FROM #t\nGO\nSELECT 2\ngo 3\nSELECT 3'
    expect(splitStatements(script, 'mssql').map((s) => s.text)).toEqual([
      'SELECT [a;b] FROM #t',
      'SELECT 2',
      'SELECT 3',
    ])
  })

  it('keeps every offset where it was', () => {
    for (const dialect of ['postgresql', 'mssql'] as const) {
      const script = 'SELECT "x", [y], \'z\', $$q$$ -- c\n/* b */ FROM #t'
      expect(normalizeSql(script, dialect)).toHaveLength(script.length)
    }
  })
})
