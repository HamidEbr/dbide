import type { ColumnInfo } from './driver'
import type { Cell } from './query'
import { isNumericType, sqlLiteral, toHex } from './value'

/**
 * Turning rows into text, one row at a time, so a result of any size can be written to a file
 * without holding it in memory. The same formatters back "Export…" in the core and "Copy as…"
 * in the grid.
 */

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'ndjson' | 'sql' | 'markdown' | 'xlsx'

/** The formats that are plain text, which the formatters here can write. An Excel file is a zip. */
export type TextExportFormat = Exclude<ExportFormat, 'xlsx'>

export interface ExportFormatInfo {
  value: ExportFormat
  label: string
  extension: string
  /** A line in the file dialog's type filter. */
  filter: string
}

export const EXPORT_FORMATS: readonly ExportFormatInfo[] = [
  { value: 'csv', label: 'CSV', extension: 'csv', filter: 'CSV (comma separated)' },
  { value: 'tsv', label: 'TSV', extension: 'tsv', filter: 'TSV (tab separated)' },
  { value: 'json', label: 'JSON', extension: 'json', filter: 'JSON' },
  { value: 'ndjson', label: 'JSON Lines', extension: 'ndjson', filter: 'JSON Lines' },
  { value: 'sql', label: 'SQL', extension: 'sql', filter: 'SQL INSERT statements' },
  { value: 'markdown', label: 'Markdown', extension: 'md', filter: 'Markdown table' },
  { value: 'xlsx', label: 'Excel', extension: 'xlsx', filter: 'Excel workbook' },
]

export const exportFormat = (format: ExportFormat): ExportFormatInfo =>
  EXPORT_FORMATS.find((f) => f.value === format)!

export type Delimiter = ',' | ';' | '\t' | '|'
export const DELIMITERS: readonly Delimiter[] = [',', ';', '\t', '|']

export interface ExportOptions {
  /** Column names as the first row (CSV, TSV). Markdown always has them. */
  header: boolean
  /** The separator between CSV fields. TSV always uses a tab. */
  delimiter: Delimiter
  /** What NULL becomes in CSV and TSV. Empty by default; empty text is then written as "". */
  nullText: string
  quoteAll: boolean
  /** A UTF-8 byte order mark, which older Excel needs to read non-ASCII text correctly. */
  bom: boolean
  crlf: boolean
  /** Stop a spreadsheet from running text such as `=1+1` as a formula. */
  neutralizeFormulas: boolean
  /** The table in `INSERT INTO`. */
  tableName: string
  /** Rows per INSERT statement. 1 writes one statement per row. */
  rowsPerInsert: number
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  header: true,
  delimiter: ',',
  nullText: '',
  quoteAll: false,
  bom: false,
  crlf: false,
  neutralizeFormulas: false,
  tableName: 'table_name',
  rowsPerInsert: 100,
}

export const MAX_ROWS_PER_INSERT = 5000

/** Produces the file's text piece by piece: `start`, then `row` for each row, then `end`. */
export interface RowFormatter {
  start(columns: readonly ColumnInfo[]): string
  row(cells: readonly Cell[]): string
  end(): string
}

const quoteIdentifier = (name: string): string => `\`${name.replace(/`/g, '``')}\``

/** `shop.orders` becomes `shop`.`orders`. */
const quoteTable = (name: string): string => name.split('.').map(quoteIdentifier).join('.')

/** A cell as plain text. Binary values become 0x-prefixed hex. */
function cellText(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return ''
  if (cell instanceof Uint8Array) return `0x${toHex(cell)}`
  return String(cell)
}

const FORMULA_START = /^[=+\-@\t\r]/

function delimitedFormatter(delimiter: string, options: ExportOptions): RowFormatter {
  const eol = options.crlf ? '\r\n' : '\n'
  let columns: readonly ColumnInfo[] = []

  const quote = (text: string, force = false): string =>
    force || options.quoteAll || text.includes(delimiter) || /["\n\r]/.test(text)
      ? `"${text.replace(/"/g, '""')}"`
      : text

  const field = (cell: Cell | undefined, index: number): string => {
    if (cell === null || cell === undefined) return quote(options.nullText)
    let text = cellText(cell)
    // Numbers and binary values are never formulas, and a minus sign is part of a number.
    const numeric = typeof cell === 'number' || isNumericType(columns[index]?.type ?? '')
    if (
      options.neutralizeFormulas &&
      !numeric &&
      !(cell instanceof Uint8Array) &&
      FORMULA_START.test(text)
    ) {
      text = `'${text}`
    }
    // With an empty NULL text, an empty string is quoted so the two stay apart.
    return quote(text, text === '' && options.nullText === '')
  }

  return {
    start(cols) {
      columns = cols
      const bom = options.bom ? '﻿' : ''
      if (!options.header) return bom
      return bom + cols.map((c) => quote(c.name)).join(delimiter) + eol
    },
    row: (cells) => cells.map(field).join(delimiter) + eol,
    end: () => '',
  }
}

const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/

/** A cell as a JSON token. Exact decimals and big integers keep every digit. */
function jsonToken(cell: Cell | undefined, type: string | undefined): string {
  if (cell === null || cell === undefined) return 'null'
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : 'null'
  if (typeof cell === 'boolean') return cell ? 'true' : 'false'
  if (cell instanceof Uint8Array) return JSON.stringify(`0x${toHex(cell)}`)
  if (type && isNumericType(type) && JSON_NUMBER.test(cell)) return cell
  return JSON.stringify(cell)
}

/** Column names as JSON keys. Two columns with one name would overwrite each other. */
function uniqueKeys(columns: readonly ColumnInfo[]): string[] {
  const seen = new Map<string, number>()
  return columns.map((column) => {
    const count = (seen.get(column.name) ?? 0) + 1
    seen.set(column.name, count)
    return JSON.stringify(count === 1 ? column.name : `${column.name}_${count}`)
  })
}

function jsonObject(
  keys: string[],
  columns: readonly ColumnInfo[],
  cells: readonly Cell[],
): string {
  return `{${keys.map((key, i) => `${key}:${jsonToken(cells[i], columns[i]?.type)}`).join(',')}}`
}

function jsonFormatter(options: ExportOptions): RowFormatter {
  const eol = options.crlf ? '\r\n' : '\n'
  let columns: readonly ColumnInfo[] = []
  let keys: string[] = []
  let count = 0
  return {
    start(cols) {
      columns = cols
      keys = uniqueKeys(cols)
      return '['
    },
    row(cells) {
      const prefix = count++ === 0 ? eol : `,${eol}`
      return `${prefix}  ${jsonObject(keys, columns, cells)}`
    },
    end: () => `${count === 0 ? '' : eol}]${eol}`,
  }
}

function ndjsonFormatter(options: ExportOptions): RowFormatter {
  const eol = options.crlf ? '\r\n' : '\n'
  let columns: readonly ColumnInfo[] = []
  let keys: string[] = []
  return {
    start(cols) {
      columns = cols
      keys = uniqueKeys(cols)
      return ''
    },
    row: (cells) => jsonObject(keys, columns, cells) + eol,
    end: () => '',
  }
}

function sqlFormatter(options: ExportOptions): RowFormatter {
  const eol = options.crlf ? '\r\n' : '\n'
  const perInsert = Math.min(MAX_ROWS_PER_INSERT, Math.max(1, Math.floor(options.rowsPerInsert)))
  const table = quoteTable(options.tableName.trim() || 'table_name')
  let columns: readonly ColumnInfo[] = []
  let head = ''
  let pending: string[] = []

  const flush = (): string => {
    if (pending.length === 0) return ''
    const text =
      pending.length === 1
        ? `${head} VALUES (${pending[0]});${eol}`
        : `${head} VALUES${eol}${pending.map((values) => `  (${values})`).join(`,${eol}`)};${eol}`
    pending = []
    return text
  }

  return {
    start(cols) {
      columns = cols
      head = `INSERT INTO ${table} (${cols.map((c) => quoteIdentifier(c.name)).join(', ')})`
      return ''
    },
    row(cells) {
      pending.push(cells.map((cell, i) => sqlLiteral(cell, columns[i]?.type)).join(', '))
      return pending.length >= perInsert ? flush() : ''
    },
    end: flush,
  }
}

function markdownFormatter(options: ExportOptions): RowFormatter {
  const eol = options.crlf ? '\r\n' : '\n'
  const escape = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  return {
    start(cols) {
      const names = cols.map((c) => escape(c.name))
      return `| ${names.join(' | ')} |${eol}| ${cols.map(() => '---').join(' | ')} |${eol}`
    },
    row: (cells) =>
      `| ${cells.map((cell) => (cell === null ? 'NULL' : escape(cellText(cell)))).join(' | ')} |${eol}`,
    end: () => '',
  }
}

export function createFormatter(
  format: TextExportFormat,
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS,
): RowFormatter {
  switch (format) {
    case 'csv':
      return delimitedFormatter(options.delimiter, options)
    case 'tsv':
      return delimitedFormatter('\t', options)
    case 'json':
      return jsonFormatter(options)
    case 'ndjson':
      return ndjsonFormatter(options)
    case 'sql':
      return sqlFormatter(options)
    case 'markdown':
      return markdownFormatter(options)
  }
}

/** Formats a whole result in one go. Fine for what the grid holds; exports stream instead. */
export function formatAll(
  format: TextExportFormat,
  columns: readonly ColumnInfo[],
  rows: readonly (readonly Cell[])[],
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS,
): string {
  const formatter = createFormatter(format, options)
  let text = formatter.start(columns)
  for (const row of rows) text += formatter.row(row)
  return text + formatter.end()
}

// eslint-disable-next-line no-control-regex
const BAD_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g

/** A file name for an export, such as `orders-2026-03-01.csv`. */
export function exportFileName(base: string, format: ExportFormat, date = new Date()): string {
  const cleaned = base.replace(BAD_FILE_CHARS, '_').replace(/^\.+/, '').trim().slice(0, 80)
  const day = date.toISOString().slice(0, 10)
  return `${cleaned || 'result'}-${day}.${exportFormat(format).extension}`
}
