import { describe, expect, it } from 'vitest'
import { appReadOnlyViolation } from './read-only'

describe('appReadOnlyViolation', () => {
  it('lets reads and session settings through', () => {
    for (const sql of [
      'SELECT 1',
      'SELECT * FROM t WHERE a = 1',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'SHOW TABLES',
      'EXPLAIN SELECT 1',
      'USE shop',
      "SET NAMES 'utf8mb4'",
      'SET @a = 1',
      'SET SESSION sql_mode = ""',
      'START TRANSACTION',
      'ROLLBACK',
      "SELECT 'INTO OUTFILE' AS s",
      '/* INTO DUMPFILE */ SELECT 1',
    ]) {
      expect(appReadOnlyViolation(sql), sql).toBeNull()
    }
  })

  it('refuses changes to data and schema, and administration', () => {
    expect(appReadOnlyViolation('INSERT INTO t VALUES (1)')).toMatch(/data change/)
    expect(appReadOnlyViolation('update t set a = 1')).toMatch(/data change/)
    expect(appReadOnlyViolation('DELETE FROM t')).toMatch(/data change/)
    expect(appReadOnlyViolation('CALL purge()')).toMatch(/data change/)
    expect(appReadOnlyViolation('CREATE TABLE t (a INT)')).toMatch(/schema change/)
    expect(appReadOnlyViolation('DROP TABLE t')).toMatch(/schema change/)
    expect(appReadOnlyViolation('TRUNCATE t')).toMatch(/schema change/)
    expect(appReadOnlyViolation('GRANT ALL ON *.* TO x')).toMatch(/administrative/)
    expect(appReadOnlyViolation('KILL 5')).toMatch(/administrative/)
  })

  it('refuses a write hidden behind a leading comment or CTE', () => {
    expect(appReadOnlyViolation('/* hi */ DELETE FROM t')).toMatch(/data change/)
    expect(appReadOnlyViolation('WITH x AS (SELECT 1) DELETE FROM t')).toMatch(/data change/)
  })

  it('refuses a statement that writes a file on the server', () => {
    expect(appReadOnlyViolation("SELECT * FROM t INTO OUTFILE '/tmp/x'")).toMatch(/file/)
    expect(appReadOnlyViolation("select 1 into   dumpfile '/tmp/y'")).toMatch(/file/)
  })

  it('refuses settings for the whole server and password changes', () => {
    expect(appReadOnlyViolation('SET GLOBAL max_connections = 1')).toMatch(/whole server/)
    expect(appReadOnlyViolation("SET PASSWORD = 'x'")).toMatch(/whole server/)
  })

  it('refuses what it can not read', () => {
    expect(appReadOnlyViolation('FROBNICATE t')).toMatch(/can’t tell/)
    expect(appReadOnlyViolation('')).toMatch(/can’t tell/)
  })
})
