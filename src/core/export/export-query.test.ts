import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ColumnInfo, ResultBatch } from '@shared/driver'
import { DEFAULT_EXPORT_OPTIONS } from '@shared/export'
import { exportQuery, fileSink, type ExportSink } from './export-query'
import { fakeSession } from '../testing'

const columns: ColumnInfo[] = [
  { name: 'id', type: 'int' },
  { name: 'name', type: 'varchar' },
]

function sessionOf(batches: ResultBatch[], onRequest?: (text: string, target?: string) => void) {
  return fakeSession({
    async *execute(request, signal) {
      onRequest?.(request.text, request.target)
      for (const batch of batches) {
        signal.throwIfAborted()
        yield batch
      }
    },
  })
}

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
  return { sink, chunks, text: () => chunks.join('') }
}

describe('exportQuery', () => {
  it('writes every row of every batch, in order', async () => {
    const out = memorySink()
    const result = await exportQuery({
      session: sessionOf([
        { kind: 'columns', columns },
        { kind: 'rows', rows: [[1, 'a']] },
        {
          kind: 'rows',
          rows: [
            [2, 'b'],
            [3, null],
          ],
        },
      ]),
      sql: 'SELECT * FROM t',
      database: null,
      format: 'csv',
      options: DEFAULT_EXPORT_OPTIONS,
      sink: out.sink,
      signal: new AbortController().signal,
    })
    expect(out.text()).toBe('id,name\n1,a\n2,b\n3,\n')
    expect(result).toEqual({ rows: 3, bytes: Buffer.byteLength(out.text()) })
  })

  it('passes the database to the session', async () => {
    let seen: [string, string | undefined] | undefined
    await exportQuery({
      session: sessionOf([{ kind: 'columns', columns }], (text, target) => (seen = [text, target])),
      sql: 'SELECT 1',
      database: 'shop',
      format: 'json',
      options: DEFAULT_EXPORT_OPTIONS,
      sink: memorySink().sink,
      signal: new AbortController().signal,
    })
    expect(seen).toEqual(['SELECT 1', 'shop'])
  })

  it('writes the header of a result with no rows', async () => {
    const out = memorySink()
    const result = await exportQuery({
      session: sessionOf([{ kind: 'columns', columns }]),
      sql: 'SELECT * FROM empty',
      database: null,
      format: 'json',
      options: DEFAULT_EXPORT_OPTIONS,
      sink: out.sink,
      signal: new AbortController().signal,
    })
    expect(out.text()).toBe('[]\n')
    expect(result.rows).toBe(0)
  })

  it('exports only the first result set', async () => {
    const out = memorySink()
    await exportQuery({
      session: sessionOf([
        { kind: 'columns', columns },
        { kind: 'rows', rows: [[1, 'a']] },
        { kind: 'columns', columns },
        { kind: 'rows', rows: [[2, 'b']] },
      ]),
      sql: 'CALL x()',
      database: null,
      format: 'ndjson',
      options: DEFAULT_EXPORT_OPTIONS,
      sink: out.sink,
      signal: new AbortController().signal,
    })
    expect(out.text()).toBe('{"id":1,"name":"a"}\n')
  })

  it('refuses a statement that returns no rows', async () => {
    const ok: ResultBatch = {
      kind: 'ok',
      affectedRows: 1,
      insertId: null,
      message: '',
      warnings: 0,
    }
    for (const batches of [[ok], [] as ResultBatch[]]) {
      await expect(
        exportQuery({
          session: sessionOf(batches),
          sql: 'x',
          database: null,
          format: 'csv',
          options: DEFAULT_EXPORT_OPTIONS,
          sink: memorySink().sink,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'NOT_A_QUERY' })
    }
  })

  it('reports progress, throttled, and a final count', async () => {
    const reports: { rows: number; bytes: number }[] = []
    const rows = Array.from({ length: 10 }, (_, i) => [i, 'x'])
    await exportQuery({
      session: sessionOf([
        { kind: 'columns', columns },
        ...rows.map((row): ResultBatch => ({ kind: 'rows', rows: [row] })),
      ]),
      sql: 'x',
      database: null,
      format: 'csv',
      options: DEFAULT_EXPORT_OPTIONS,
      sink: memorySink().sink,
      signal: new AbortController().signal,
      onProgress: (p) => reports.push(p),
      progressIntervalMs: 60_000,
    })
    expect(reports.at(-1)?.rows).toBe(10)
    expect(reports.length).toBeLessThan(4)
  })

  it('stops when cancelled and tells the session to stop the query', async () => {
    const controller = new AbortController()
    let stopped = false
    const session = fakeSession({
      async *execute() {
        try {
          yield { kind: 'columns', columns } as ResultBatch
          for (let i = 0; ; i++) yield { kind: 'rows', rows: [[i, 'x']] } as ResultBatch
        } finally {
          stopped = true
        }
      },
    })
    const out = memorySink()
    const sink: ExportSink = {
      ...out.sink,
      write: (chunk) => {
        if (out.chunks.length === 5) controller.abort()
        return out.sink.write(chunk)
      },
    }
    await expect(
      exportQuery({
        session,
        sql: 'x',
        database: null,
        format: 'csv',
        options: DEFAULT_EXPORT_OPTIONS,
        sink,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(stopped).toBe(true)
  })

  it('lets a slow sink slow the query down: it pulls the next batch only after the write', async () => {
    const events: string[] = []
    const session = fakeSession({
      async *execute() {
        yield { kind: 'columns', columns } as ResultBatch
        for (let i = 0; i < 3; i++) {
          events.push(`pull ${i}`)
          yield { kind: 'rows', rows: [[i, 'x']] } as ResultBatch
        }
      },
    })
    const sink: ExportSink = {
      ready: () => Promise.resolve(),
      write: async (chunk) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        events.push(`wrote ${JSON.stringify(chunk.slice(0, 3))}`)
      },
      finish: () => Promise.resolve(),
      abort: () => Promise.resolve(),
    }
    await exportQuery({
      session,
      sql: 'x',
      database: null,
      format: 'csv',
      options: { ...DEFAULT_EXPORT_OPTIONS, header: false },
      sink,
      signal: new AbortController().signal,
    })
    expect(events.filter((e) => e.startsWith('pull'))).toHaveLength(3)
    // Each batch is written before the next one is pulled.
    expect(events.slice(0, 4)).toEqual(['pull 0', 'wrote "0,x"', 'pull 1', 'wrote "1,x"'])
  })
})

describe('fileSink', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbide-export-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes to a temporary file and renames it when finished', async () => {
    const path = join(dir, 'out.csv')
    const sink = fileSink(path)
    await sink.ready()
    await sink.write('a,b\n')
    await sink.write('1,2\n')
    expect(await readdir(dir)).toEqual(['out.csv.part'])
    await sink.finish()
    expect(await readdir(dir)).toEqual(['out.csv'])
    expect(readFileSync(path, 'utf8')).toBe('a,b\n1,2\n')
  })

  it('replaces a file that is already there, but only once it is complete', async () => {
    const path = join(dir, 'out.csv')
    writeFileSync(path, 'old')
    const sink = fileSink(path)
    await sink.write('new')
    expect(readFileSync(path, 'utf8')).toBe('old')
    await sink.finish()
    expect(readFileSync(path, 'utf8')).toBe('new')
  })

  it('removes the partial file when aborted, and leaves an existing file alone', async () => {
    const path = join(dir, 'out.csv')
    writeFileSync(path, 'old')
    const sink = fileSink(path)
    await sink.write('half')
    await sink.abort()
    expect(await readdir(dir)).toEqual(['out.csv'])
    expect(readFileSync(path, 'utf8')).toBe('old')
  })

  it('finishes an empty export', async () => {
    const path = join(dir, 'empty.csv')
    const sink = fileSink(path)
    await sink.finish()
    expect(readFileSync(path, 'utf8')).toBe('')
  })

  it('reports a folder that does not exist before anything is written', async () => {
    const sink = fileSink(join(dir, 'missing', 'out.csv'))
    await expect(sink.ready()).rejects.toMatchObject({ code: 'ENOENT' })
    await sink.abort()
    expect(await readdir(dir)).toEqual([])
  })

  it('does not run the query when the file can not be created', async () => {
    let ran = false
    const sink = fileSink(join(dir, 'missing', 'out.csv'))
    await expect(
      exportQuery({
        session: sessionOf([{ kind: 'columns', columns }], () => (ran = true)),
        sql: 'x',
        database: null,
        format: 'csv',
        options: DEFAULT_EXPORT_OPTIONS,
        sink,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(ran).toBe(false)
  })

  it('handles a lot of text with back-pressure', async () => {
    const path = join(dir, 'big.txt')
    const sink = fileSink(path)
    const line = 'x'.repeat(1023) + '\n'
    for (let i = 0; i < 5000; i++) await sink.write(line)
    await sink.finish()
    expect(readFileSync(path).length).toBe(5000 * 1024)
  })

  describe('compressed', () => {
    it('writes a gzip file that reads back as the text that was written', async () => {
      const path = join(dir, 'out.csv.gz')
      const sink = fileSink(path, { gzip: true })
      await sink.ready()
      await sink.write('id,name\n')
      await sink.write('1,café\n')
      await sink.finish()
      expect(gunzipSync(readFileSync(path)).toString('utf8')).toBe('id,name\n1,café\n')
      expect(await readdir(dir)).toEqual(['out.csv.gz'])
    })

    it('makes a big, repetitive export much smaller, with back-pressure', async () => {
      const path = join(dir, 'big.txt.gz')
      const sink = fileSink(path, { gzip: true })
      const line = 'x'.repeat(1023) + '\n'
      for (let i = 0; i < 5000; i++) await sink.write(line)
      await sink.finish()
      expect(readFileSync(path).length).toBeLessThan(50_000)
      expect(gunzipSync(readFileSync(path)).length).toBe(5000 * 1024)
    })

    it('writes bytes as well as text, as an Excel file would', async () => {
      const path = join(dir, 'bytes.gz')
      const sink = fileSink(path, { gzip: true })
      await sink.write(Uint8Array.from([1, 2, 3]))
      await sink.finish()
      expect([...gunzipSync(readFileSync(path))]).toEqual([1, 2, 3])
    })

    it('leaves nothing behind when it is stopped', async () => {
      const path = join(dir, 'stopped.csv.gz')
      const sink = fileSink(path, { gzip: true })
      await sink.ready()
      await sink.write('some text')
      await sink.abort()
      expect(await readdir(dir)).toEqual([])
    })

    it('reports a folder that does not exist before anything is written', async () => {
      const sink = fileSink(join(dir, 'missing', 'out.gz'), { gzip: true })
      await expect(sink.ready()).rejects.toMatchObject({ code: 'ENOENT' })
      await sink.abort()
      expect(await readdir(dir)).toEqual([])
    })

    it('exports a query into it', async () => {
      const path = join(dir, 'query.json.gz')
      const sink = fileSink(path, { gzip: true })
      const result = await exportQuery({
        session: sessionOf([
          { kind: 'columns', columns },
          { kind: 'rows', rows: [[1, 'a']] },
        ]),
        sql: 'SELECT * FROM t',
        database: null,
        format: 'json',
        options: DEFAULT_EXPORT_OPTIONS,
        sink,
        signal: new AbortController().signal,
      })
      await sink.finish()
      expect(result.rows).toBe(1)
      expect(JSON.parse(gunzipSync(readFileSync(path)).toString())).toEqual([{ id: 1, name: 'a' }])
    })
  })
})
