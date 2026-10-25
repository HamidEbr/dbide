import { describe, expect, it } from 'vitest'
import type { ColumnInfo } from '@shared/driver'
import type { StatementRun, StatementStatus } from '@/state/scripts'
import { exportBlockedReason, singleSourceName } from './open'

const statement = (sql: string, status: StatementStatus = 'done'): StatementRun => ({
  index: 0,
  sql,
  status,
  resultSets: [],
  ok: null,
  error: null,
  durationMs: 1,
  truncated: false,
})

const column = (table: string | null, schema = 'shop'): ColumnInfo => ({
  name: 'c',
  type: 'int',
  ...(table ? { source: { schema, table, column: 'c' } } : {}),
})

describe('exportBlockedReason', () => {
  it('allows a finished query, and one that is waiting for more rows', () => {
    expect(exportBlockedReason(statement('SELECT 1'))).toBeNull()
    expect(exportBlockedReason(statement('SELECT 1', 'paused'))).toBeNull()
    expect(exportBlockedReason(statement('WITH t AS (SELECT 1) SELECT * FROM t'))).toBeNull()
  })

  it('asks to wait while a statement is still running or failed', () => {
    for (const status of ['running', 'queued', 'error', 'cancelled'] as const) {
      expect(exportBlockedReason(statement('SELECT 1', status))).toMatch(/finish/)
    }
  })

  it('refuses anything that is not a query that reads', () => {
    for (const sql of ['DELETE FROM t', 'UPDATE t SET a = 1', 'CALL p()', 'DROP TABLE t']) {
      expect(exportBlockedReason(statement(sql))).toMatch(/reads data/)
    }
  })
})

describe('singleSourceName', () => {
  it('names the table when every column comes from it', () => {
    expect(singleSourceName([column('orders'), column('orders')])).toEqual({
      schema: 'shop',
      table: 'orders',
    })
  })

  it('has no name for a join, a computed column, or no columns', () => {
    expect(singleSourceName([column('orders'), column('customers')])).toBeNull()
    expect(singleSourceName([column('orders'), column(null)])).toBeNull()
    expect(singleSourceName([column('orders', 'a'), column('orders', 'b')])).toBeNull()
    expect(singleSourceName([])).toBeNull()
  })
})
