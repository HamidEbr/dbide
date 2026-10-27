import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ResultBatch } from '@shared/driver'
import { fakeSession } from '../testing'
import { openRecords } from './records'
import { importRows } from './run'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbide-import-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const collect = async (records: Awaited<ReturnType<typeof openRecords>>) => {
  const rows: (string | null)[][] = []
  for await (const row of records.rows()) rows.push(row)
  return rows
}
const csv = { format: 'csv' as const, delimiter: ',' as const, header: true }

describe('openRecords', () => {
  it('reads a CSV with a header, a byte order mark and ragged rows', async () => {
    const file = join(dir, 'a.csv')
    writeFileSync(file, '﻿id,First name,\n1,Ann,x\n2\n')
    const records = await openRecords(file, csv)
    expect(records.columns).toEqual(['id', 'First_name', 'column_3'])
    expect(await collect(records)).toEqual([
      ['1', 'Ann', 'x'],
      ['2', null, null],
    ])
  })

  it('names columns itself without a header, and uses the separator', async () => {
    const file = join(dir, 'a.csv')
    writeFileSync(file, '1;a\n2;b\n')
    const records = await openRecords(file, { format: 'csv', delimiter: ';', header: false })
    expect(records.columns).toEqual(['column_1', 'column_2'])
    expect(await collect(records)).toHaveLength(2)
  })

  it('reads JSON Lines and a JSON array, with fields from every row', async () => {
    const lines = join(dir, 'a.ndjson')
    writeFileSync(lines, '{"id":1,"ok":true}\n\n{"id":2,"tags":["x"],"note":null}\n')
    const records = await openRecords(lines, { ...csv, format: 'ndjson' })
    expect(records.columns).toEqual(['id', 'ok', 'tags', 'note'])
    expect(await collect(records)).toEqual([
      ['1', '1', null, null],
      ['2', null, '["x"]', null],
    ])
    const array = join(dir, 'a.json')
    writeFileSync(array, '[{"a":1},{"a":2}]')
    expect(await collect(await openRecords(array, { ...csv, format: 'json' }))).toEqual([
      ['1'],
      ['2'],
    ])
  })

  it('says what is wrong with a file', async () => {
    const empty = join(dir, 'e.csv')
    writeFileSync(empty, '')
    await expect(openRecords(empty, csv)).rejects.toThrow(/empty/)
    const bad = join(dir, 'b.json')
    writeFileSync(bad, '{"a":1}')
    await expect(openRecords(bad, { ...csv, format: 'json' })).rejects.toThrow(/array/)
    writeFileSync(bad, 'nope')
    await expect(openRecords(bad, { ...csv, format: 'json' })).rejects.toThrow(/valid JSON/)
  })
})

describe('importRows', () => {
  function server(seen: string[], failOn?: RegExp) {
    return fakeSession({
      async *execute(request): AsyncGenerator<ResultBatch> {
        seen.push(request.text)
        if (failOn?.test(request.text)) throw new Error('Duplicate entry')
        yield { kind: 'ok', affectedRows: 0, insertId: null, message: '', warnings: 0 }
      },
    })
  }
  const records = (rows: (string | null)[][]) => ({
    columns: ['a', 'b'],
    async *rows() {
      yield* rows
    },
  })
  const base = {
    database: 'shop',
    table: 'items',
    create: null,
    mapping: [
      { source: 0, target: 'id' },
      { source: 1, target: 'name' },
    ],
    emptyAsNull: true,
    skipDuplicates: false,
    signal: new AbortController().signal,
  }

  it('writes the rows in one transaction, mapped and quoted, with empty values as NULL', async () => {
    const seen: string[] = []
    const done = await importRows({
      ...base,
      session: server(seen),
      records: records([
        ['1', "O'Neil"],
        ['2', ''],
        ['3', null],
      ]),
    })
    expect(done.rows).toBe(3)
    expect(seen).toEqual([
      'START TRANSACTION',
      "INSERT INTO `shop`.`items` (`id`, `name`) VALUES\n('1', 'O''Neil'),\n('2', NULL),\n('3', NULL)",
      'COMMIT',
    ])
  })

  it('creates the table first, skips duplicates when asked, and splits large files', async () => {
    const seen: string[] = []
    await importRows({
      ...base,
      session: server(seen),
      create: [
        { name: 'id', type: 'BIGINT' },
        { name: 'name', type: 'VARCHAR(50)' },
      ],
      skipDuplicates: true,
      records: records(Array.from({ length: 501 }, (_, i) => [String(i), 'x'])),
    })
    expect(seen[0]).toBe(
      'CREATE TABLE `shop`.`items` (\n  `id` BIGINT NULL,\n  `name` VARCHAR(50) NULL\n)',
    )
    expect(seen.filter((s) => s.startsWith('INSERT IGNORE INTO')).length).toBe(2)
  })

  it('rolls back when a statement fails', async () => {
    const seen: string[] = []
    await expect(
      importRows({ ...base, session: server(seen, /^INSERT/), records: records([['1', 'a']]) }),
    ).rejects.toThrow(/Duplicate/)
    expect(seen.at(-1)).toBe('ROLLBACK')
    expect(seen).not.toContain('COMMIT')
  })

  it('rolls back when cancelled', async () => {
    const seen: string[] = []
    const abort = new AbortController()
    const source = {
      columns: ['a', 'b'],
      async *rows() {
        yield ['1', 'a']
        abort.abort()
        yield ['2', 'b']
      },
    }
    await expect(
      importRows({ ...base, session: server(seen), records: source, signal: abort.signal }),
    ).rejects.toThrow()
    expect(seen.at(-1)).toBe('ROLLBACK')
  })
})
