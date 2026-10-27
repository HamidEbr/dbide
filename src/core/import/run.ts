import type { DriverSession } from '@shared/driver'
import { quoteIdentifier } from '@shared/export-table'
import { IMPORT_BATCH_ROWS } from '@shared/import'
import { sqlLiteral } from '@shared/value'
import type { Records } from './records'

export interface ImportOptions {
  session: DriverSession
  database: string
  table: string
  /** Columns of a table to create first, or null to write into one that exists. */
  create: { name: string; type: string }[] | null
  /** Which column of the file goes to which column of the table. */
  mapping: { source: number; target: string }[]
  records: Records
  /** An empty value in the file is written as NULL, not as empty text. */
  emptyAsNull: boolean
  /** A row that repeats a key already in the table is left out, rather than stopping the import. */
  skipDuplicates: boolean
  signal: AbortSignal
  onProgress?: (rows: number) => void
}

async function run(
  session: DriverSession,
  sql: string,
  database: string,
  signal: AbortSignal,
): Promise<void> {
  const results = session.execute({ text: sql, target: database }, signal)
  for await (const _batch of results) signal.throwIfAborted()
}

/**
 * Writes the rows of a file into a table, a few hundred at a time, in one transaction: if anything goes wrong, or the
 * import is cancelled, none of the rows stay. (Creating the table is the one step the server can't undo.)
 */
export async function importRows(options: ImportOptions): Promise<{ rows: number }> {
  const { session, database, signal } = options
  const target = `${quoteIdentifier(database)}.${quoteIdentifier(options.table)}`
  if (options.create) {
    const columns = options.create
      .map((c) => `  ${quoteIdentifier(c.name)} ${c.type} NULL`)
      .join(',\n')
    await run(session, `CREATE TABLE ${target} (\n${columns}\n)`, database, signal)
  }
  const head = `INSERT ${options.skipDuplicates ? 'IGNORE ' : ''}INTO ${target} (${options.mapping
    .map((m) => quoteIdentifier(m.target))
    .join(', ')}) VALUES\n`

  let rows = 0
  let batch: string[] = []
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    await run(session, `${head}${batch.join(',\n')}`, database, signal)
    rows += batch.length
    batch = []
    options.onProgress?.(rows)
  }

  await run(session, 'START TRANSACTION', database, signal)
  try {
    for await (const row of options.records.rows()) {
      signal.throwIfAborted()
      batch.push(
        `(${options.mapping
          .map((m) => {
            const value = row[m.source] ?? null
            return value === null || (value === '' && options.emptyAsNull)
              ? 'NULL'
              : sqlLiteral(value)
          })
          .join(', ')})`,
      )
      if (batch.length >= IMPORT_BATCH_ROWS) await flush()
    }
    await flush()
    await run(session, 'COMMIT', database, new AbortController().signal)
  } catch (error) {
    // The rollback must run even when the signal that stopped the import is already aborted.
    await run(session, 'ROLLBACK', database, new AbortController().signal).catch(() => undefined)
    throw error
  }
  return { rows }
}
