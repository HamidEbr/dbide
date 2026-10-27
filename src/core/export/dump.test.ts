import { describe, expect, it } from 'vitest'
import type { ResultBatch } from '@shared/driver'
import { dumpDatabase } from './dump'
import type { ExportSink } from './export-query'
import { fakeSession } from '../testing'

function memorySink() {
  const chunks: string[] = []
  const sink: ExportSink = {
    ready: () => Promise.resolve(),
    write: (chunk) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return Promise.resolve()
    },
    finish: () => Promise.resolve(),
    abort: () => Promise.resolve(),
  }
  return { sink, text: () => chunks.join('') }
}

/** A server with a table `t` (two rows), an empty table `e` and a view `v`. */
function server(seen: string[] = []) {
  return fakeSession({
    async *execute(request): AsyncGenerator<ResultBatch> {
      seen.push(request.text)
      const sql = request.text
      if (sql.startsWith('SHOW CREATE TABLE')) {
        yield {
          kind: 'columns',
          columns: [
            { name: 'Table', type: 'varchar' },
            { name: 'Create Table', type: 'varchar' },
          ],
        }
        yield { kind: 'rows', rows: [['x', `CREATE TABLE ${sql.slice(18)} (id int)`]] }
      } else if (sql.startsWith('SHOW CREATE VIEW')) {
        yield {
          kind: 'columns',
          columns: [
            { name: 'View', type: 'varchar' },
            { name: 'Create View', type: 'varchar' },
          ],
        }
        yield { kind: 'rows', rows: [['v', 'CREATE VIEW `v` AS select 1']] }
      } else {
        yield { kind: 'columns', columns: [{ name: 'id', type: 'int' }] }
        if (sql.includes('`t`')) yield { kind: 'rows', rows: [[1], [2]] }
      }
    },
  })
}

const base = {
  database: 'shop',
  tables: [
    { name: 'v', view: true },
    { name: 't', view: false },
    { name: 'e', view: false },
  ],
  structure: true,
  data: true,
  drop: true,
  rowsPerInsert: 100,
  signal: new AbortController().signal,
}

describe('dumpDatabase', () => {
  it('writes tables before views, each with its CREATE and rows, between the check switches', async () => {
    const out = memorySink()
    const seen: string[] = []
    const result = await dumpDatabase({ ...base, session: server(seen), sink: out.sink })
    const text = out.text()
    expect(text).toContain('SET FOREIGN_KEY_CHECKS = 0;')
    expect(text.trimEnd().endsWith('SET FOREIGN_KEY_CHECKS = 1;')).toBe(true)
    expect(text).toContain('DROP TABLE IF EXISTS `t`;')
    expect(text).toContain('CREATE TABLE `shop`.`t` (id int);')
    expect(text).toContain('INSERT INTO `t` (`id`) VALUES\n  (1),\n  (2);')
    expect(text).toContain('DROP VIEW IF EXISTS `v`;')
    expect(text.indexOf('-- View')).toBeGreaterThan(text.indexOf('-- Table `e`'))
    // A view has no rows of its own to read.
    expect(seen.some((s) => s.startsWith('SELECT') && s.includes('`v`'))).toBe(false)
    expect(result).toMatchObject({ rows: 2, tables: 3 })
  })

  it('leaves out what was not asked for', async () => {
    const out = memorySink()
    await dumpDatabase({ ...base, structure: false, session: server(), sink: out.sink })
    expect(out.text()).not.toContain('CREATE')
    expect(out.text()).not.toContain('DROP')
    expect(out.text()).toContain('INSERT INTO')

    const only = memorySink()
    await dumpDatabase({ ...base, data: false, drop: false, session: server(), sink: only.sink })
    expect(only.text()).toContain('CREATE TABLE')
    expect(only.text()).not.toContain('INSERT')
    expect(only.text()).not.toContain('DROP')
  })

  it('stops when cancelled', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(
      dumpDatabase({ ...base, signal: abort.signal, session: server(), sink: memorySink().sink }),
    ).rejects.toThrow()
  })
})
