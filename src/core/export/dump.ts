import type { DriverSession } from '@shared/driver'
import { DEFAULT_EXPORT_OPTIONS } from '@shared/export'
import { quoteIdentifier } from '@shared/export-table'
import type { Cell } from '@shared/query'
import { RpcError } from '@shared/rpc'
import { exportQuery, type ExportProgressReport, type ExportSink } from './export-query'

export interface DumpTable {
  name: string
  view: boolean
}

export interface DumpOptions {
  session: DriverSession
  database: string
  tables: DumpTable[]
  /** CREATE statements. */
  structure: boolean
  /** INSERT statements, for tables (a view has no rows of its own). */
  data: boolean
  /** DROP … IF EXISTS before each CREATE, so the file can be run over an existing copy. */
  drop: boolean
  rowsPerInsert: number
  sink: ExportSink
  signal: AbortSignal
  onProgress?: (progress: ExportProgressReport) => void
}

const decoder = new TextDecoder()
const text = (cell: Cell | undefined): string =>
  cell instanceof Uint8Array ? decoder.decode(cell) : String(cell ?? '')

/** The first row of a statement's first result set, or null when it has none. */
async function firstRow(
  session: DriverSession,
  sql: string,
  database: string,
  signal: AbortSignal,
): Promise<Cell[] | null> {
  const iterator = session.execute({ text: sql, target: database }, signal)[Symbol.asyncIterator]()
  try {
    for (;;) {
      const next = await iterator.next()
      if (next.done) return null
      if (next.value.kind === 'rows') return (next.value.rows[0] as Cell[] | undefined) ?? null
    }
  } finally {
    await iterator.return?.().catch(() => undefined)
  }
}

/**
 * Writes a database, or some of its tables, as one SQL file that recreates them: the CREATE statements, then the
 * rows as INSERTs. Tables come before views, so a view's tables exist when it is created, and foreign key checks
 * are off while the file runs, so the order of the tables doesn't matter.
 */
export async function dumpDatabase(
  request: DumpOptions,
): Promise<ExportProgressReport & { tables: number }> {
  const { session, database, sink, signal } = request
  let rows = 0
  let bytes = 0
  const write = async (chunk: string): Promise<void> => {
    bytes += Buffer.byteLength(chunk)
    await sink.write(chunk)
  }
  const report = (): void => request.onProgress?.({ rows, bytes })

  await sink.ready()
  await write(
    `-- DBIDE dump of ${quoteIdentifier(database)}\n-- ${session.info.serverVersion}, ${new Date().toISOString()}\n\n` +
      'SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n',
  )

  const ordered = [
    ...request.tables.filter((t) => !t.view),
    ...request.tables.filter((t) => t.view),
  ]
  for (const table of ordered) {
    signal.throwIfAborted()
    const name = quoteIdentifier(table.name)
    const path = `${quoteIdentifier(database)}.${name}`
    await write(`-- ${table.view ? 'View' : 'Table'} ${name}\n`)
    if (request.structure) {
      const kind = table.view ? 'VIEW' : 'TABLE'
      if (request.drop) await write(`DROP ${kind} IF EXISTS ${name};\n`)
      const row = await firstRow(session, `SHOW CREATE ${kind} ${path}`, database, signal)
      if (!row || row[1] === undefined) {
        throw new RpcError('NOT_FOUND', `The server did not describe ${table.name}.`)
      }
      await write(`${text(row[1])};\n`)
    }
    if (request.data && !table.view) {
      const before = { rows, bytes }
      const done = await exportQuery({
        session,
        sql: `SELECT * FROM ${path}`,
        database,
        format: 'sql',
        options: {
          ...DEFAULT_EXPORT_OPTIONS,
          tableName: table.name,
          rowsPerInsert: request.rowsPerInsert,
        },
        sink,
        signal,
        onProgress: (progress) =>
          request.onProgress?.({
            rows: before.rows + progress.rows,
            bytes: before.bytes + progress.bytes,
          }),
      })
      rows += done.rows
      bytes += done.bytes
    }
    await write('\n')
    report()
  }
  await write('SET FOREIGN_KEY_CHECKS = 1;\n')
  report()
  return { rows, bytes, tables: ordered.length }
}
