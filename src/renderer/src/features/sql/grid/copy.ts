import type { ColumnInfo } from '@shared/driver'
import type { Cell } from '@shared/query'
import { sqlLiteral, toHex } from '@shared/value'
import { copyText } from './format'

export type CopyFormat = 'tsv' | 'csv' | 'json' | 'markdown' | 'sql-insert'

export interface CopyOptions {
  /** Include the column names as the first row (TSV and CSV). */
  headers?: boolean
}

/** Spreadsheet-safe quoting: wrap and double the quotes only when the text needs it. */
function quote(text: string, separator: string): string {
  return text.includes(separator) || /["\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function delimited(
  separator: string,
  columns: ColumnInfo[],
  rows: Cell[][],
  options: CopyOptions,
): string {
  const lines: string[] = []
  if (options.headers) lines.push(columns.map((c) => quote(c.name, separator)).join(separator))
  for (const row of rows) {
    lines.push(row.map((cell) => quote(copyText(cell), separator)).join(separator))
  }
  return lines.join('\n')
}

function jsonValue(cell: Cell): unknown {
  return cell instanceof Uint8Array ? `0x${toHex(cell)}` : cell
}

function markdown(columns: ColumnInfo[], rows: Cell[][]): string {
  const escape = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const header = `| ${columns.map((c) => escape(c.name)).join(' | ')} |`
  const divider = `| ${columns.map(() => '---').join(' | ')} |`
  const body = rows.map(
    (row) =>
      `| ${row.map((cell) => escape(cell === null ? 'NULL' : copyText(cell))).join(' | ')} |`,
  )
  return [header, divider, ...body].join('\n')
}

const escapeIdentifier = (name: string): string => `\`${name.replace(/`/g, '``')}\``

function sqlInsert(columns: ColumnInfo[], rows: Cell[][]): string {
  const tables = new Set(columns.map((c) => c.table).filter(Boolean))
  const table = tables.size === 1 ? escapeIdentifier([...tables][0]!) : '`table_name`'
  const names = columns.map((c) => escapeIdentifier(c.name)).join(', ')
  return rows
    .map(
      (row) =>
        `INSERT INTO ${table} (${names}) VALUES (${row.map((cell, i) => sqlLiteral(cell, columns[i]?.type)).join(', ')});`,
    )
    .join('\n')
}

/** Formats selected cells for the clipboard. `columns` and each row cover only the selection. */
export function formatCopy(
  format: CopyFormat,
  columns: ColumnInfo[],
  rows: Cell[][],
  options: CopyOptions = {},
): string {
  switch (format) {
    case 'tsv':
      return delimited('\t', columns, rows, options)
    case 'csv':
      return delimited(',', columns, rows, options)
    case 'json':
      return JSON.stringify(
        rows.map((row) =>
          Object.fromEntries(columns.map((column, i) => [column.name, jsonValue(row[i] ?? null)])),
        ),
        null,
        2,
      )
    case 'markdown':
      return markdown(columns, rows)
    case 'sql-insert':
      return sqlInsert(columns, rows)
  }
}
