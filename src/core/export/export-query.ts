import { createWriteStream } from 'node:fs'
import { rename, unlink } from 'node:fs/promises'
import type { Writable } from 'node:stream'
import { createGzip } from 'node:zlib'
import type { DriverSession } from '@shared/driver'
import type { ExportFormat, ExportOptions } from '@shared/export'
import type { Cell } from '@shared/query'
import { RpcError } from '@shared/rpc'
import { createWriter, type Chunk } from './writer'

/** Where an export's text goes. The file sink writes to a temporary file and renames it when done. */
export interface ExportSink {
  /** Resolves once the destination can be written to, so a bad path fails before the query runs. */
  ready(): Promise<void>
  /** Resolves once the text is accepted. A slow disk slows the query down instead of filling memory. */
  write(chunk: Chunk): Promise<void>
  /** Completes the file. */
  finish(): Promise<void>
  /** Throws away what was written so far. */
  abort(): Promise<void>
}

export function fileSink(path: string, options: { gzip?: boolean } = {}): ExportSink {
  const partial = `${path}.part`
  const file = createWriteStream(partial)
  // With compression the text goes through gzip on its way to the file; either way `stream` is what is written to.
  const stream: Writable = options.gzip ? createGzip() : file
  let failure: Error | null = null
  const fail = (error: Error): void => {
    failure = error
  }
  file.on('error', fail)
  if (options.gzip) {
    stream.on('error', fail)
    stream.pipe(file)
  }

  return {
    ready: () =>
      new Promise<void>((resolve, reject) => {
        if (failure) return reject(failure)
        file.once('open', () => resolve())
        file.once('error', reject)
      }),

    write(chunk) {
      if (failure) return Promise.reject(failure)
      if (stream.write(chunk)) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const done = (error?: Error): void => {
          stream.off('drain', onDrain)
          stream.off('error', onError)
          if (error) reject(error)
          else resolve()
        }
        const onDrain = (): void => done()
        const onError = (error: Error): void => done(error)
        stream.once('drain', onDrain)
        stream.once('error', onError)
      })
    },

    async finish() {
      // The file is complete once everything, compressed or not, has been handed to the disk.
      await new Promise<void>((resolve, reject) => {
        if (failure) return reject(failure)
        file.once('error', reject)
        file.once('finish', () => resolve())
        stream.end()
      })
      if (failure) throw failure
      await rename(partial, path)
    },

    async abort() {
      // Wait until the file is closed, or a file still being opened would appear after the delete.
      if (!file.closed) {
        await new Promise<void>((resolve) => {
          file.once('close', () => resolve())
          stream.destroy()
          file.destroy()
        })
      }
      await unlink(partial).catch(() => undefined)
    },
  }
}

export interface ExportProgressReport {
  rows: number
  bytes: number
}

export interface ExportQueryOptions {
  session: DriverSession
  sql: string
  database: string | null
  format: ExportFormat
  options: ExportOptions
  sink: ExportSink
  signal: AbortSignal
  onProgress?: (progress: ExportProgressReport) => void
  progressIntervalMs?: number
}

const notAQuery = (): RpcError =>
  new RpcError('NOT_A_QUERY', 'This statement doesn’t return rows, so there is nothing to export.')

/**
 * Runs one query and writes every row, in order, to the sink. Rows are formatted and written as
 * they arrive, so the size of the result never matters. Only the first result set is exported.
 */
export async function exportQuery(request: ExportQueryOptions): Promise<ExportProgressReport> {
  const { session, sink, signal } = request
  const writer = createWriter(request.format, request.options)
  const interval = request.progressIntervalMs ?? 150

  let rows = 0
  let bytes = 0
  let seenColumns = false
  let lastReport = 0

  const write = async (chunk: Chunk): Promise<void> => {
    const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
    if (size === 0) return
    bytes += size
    await sink.write(chunk)
  }
  const report = (force = false): void => {
    const now = performance.now()
    if (!force && now - lastReport < interval) return
    lastReport = now
    request.onProgress?.({ rows, bytes })
  }

  await sink.ready()
  const results = session.execute(
    { text: request.sql, ...(request.database ? { target: request.database } : {}) },
    signal,
  )
  const iterator = results[Symbol.asyncIterator]()

  try {
    for (;;) {
      signal.throwIfAborted()
      const next = await iterator.next()
      if (next.done) break
      const batch = next.value

      if (batch.kind === 'ok') throw notAQuery()
      if (batch.kind === 'columns') {
        // A statement can return several result sets. The first one is the one being exported.
        if (seenColumns) break
        seenColumns = true
        await write(writer.start(batch.columns))
      } else if (batch.kind === 'rows') {
        if (!seenColumns) throw notAQuery()
        const batchRows = batch.rows as Cell[][]
        await write(writer.rows(batchRows))
        rows += batchRows.length
        report()
      }
    }
    if (!seenColumns) throw notAQuery()
    await write(writer.end())
    report(true)
  } finally {
    // Stopping early tells the driver to stop the query on the server.
    await iterator.return?.().catch(() => undefined)
  }
  return { rows, bytes }
}
