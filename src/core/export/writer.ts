import type { ColumnInfo } from '@shared/driver'
import {
  createFormatter,
  type ExportFormat,
  type ExportOptions,
  type RowFormatter,
} from '@shared/export'
import type { Cell } from '@shared/query'
import { createXlsxWriter } from './xlsx'

/** What goes to the file next: text, or bytes for a format that is not text. */
export type Chunk = string | Uint8Array

/**
 * Turns a result into a file, a batch of rows at a time. The core feeds it what the driver streams
 * and writes whatever comes back, so the size of the result never matters.
 */
export interface ExportWriter {
  start(columns: readonly ColumnInfo[]): Chunk
  rows(rows: readonly (readonly Cell[])[]): Chunk
  end(): Chunk
}

function textWriter(formatter: RowFormatter): ExportWriter {
  return {
    start: (columns) => formatter.start(columns),
    rows(rows) {
      let text = ''
      for (const row of rows) text += formatter.row(row)
      return text
    },
    end: () => formatter.end(),
  }
}

export function createWriter(format: ExportFormat, options: ExportOptions): ExportWriter {
  return format === 'xlsx'
    ? createXlsxWriter(options)
    : textWriter(createFormatter(format, options))
}
