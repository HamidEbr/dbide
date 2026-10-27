/** Importing a file into a table: what is read from the file, and how a new table's columns are typed. */

export type ImportFormat = 'csv' | 'tsv' | 'json' | 'ndjson'
export const IMPORT_FORMATS: readonly ImportFormat[] = ['csv', 'tsv', 'json', 'ndjson']

export type ImportDelimiter = ',' | ';' | '\t' | '|'

export interface ImportSource {
  format: ImportFormat
  /** Between the fields of a CSV. A TSV always uses a tab. */
  delimiter: ImportDelimiter
  /** The first row of a CSV or TSV holds the column names. */
  header: boolean
}

/** The format a file's name suggests, or CSV. */
export function formatOfFile(name: string): ImportFormat {
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase()
  if (ext === 'tsv' || ext === 'tab') return 'tsv'
  if (ext === 'json') return 'json'
  if (ext === 'ndjson' || ext === 'jsonl') return 'ndjson'
  return 'csv'
}

/** What the file looks like, for the preview. */
export interface ImportPreview {
  columns: string[]
  /** The first rows, a value per column. */
  rows: (string | null)[][]
  /** A type for a new table's column, guessed from the first rows. */
  types: string[]
  /** How many rows were looked at for the guess, and whether the file has more. */
  sampled: number
  more: boolean
}

const INTEGER = /^-?(0|[1-9]\d{0,17})$/
const DECIMAL = /^-?(0|[1-9]\d*)\.\d+$|^-?(0|[1-9]\d*)(\.\d+)?[eE][+-]?\d+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$/

/** A MySQL column type that holds every one of the values. Empty and missing values say nothing. */
export function inferColumnType(values: readonly (string | null)[]): string {
  const present = values.filter((v): v is string => v !== null && v !== '')
  if (present.length === 0) return 'VARCHAR(255)'
  if (present.every((v) => INTEGER.test(v))) return 'BIGINT'
  if (present.every((v) => INTEGER.test(v) || DECIMAL.test(v))) return 'DOUBLE'
  if (present.every((v) => DATE.test(v))) return 'DATE'
  if (present.every((v) => DATETIME.test(v))) return 'DATETIME'
  const longest = Math.max(...present.map((v) => v.length))
  if (longest > 255) return 'TEXT'
  return `VARCHAR(${[50, 100, 255].find((n) => longest <= n) ?? 255})`
}

/** A name for a new table from the file's name: `orders-2026.csv` → `orders_2026`. */
export function tableNameOfFile(name: string): string {
  const base = name
    .replace(/\.[^.]*$/, '')
    .replace(/[^\w]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return /^\d/.test(base) ? `t_${base}` : base || 'imported'
}

/** A column name from a heading: spaces and symbols become underscores. */
export function columnNameOf(heading: string, position: number): string {
  const cleaned = heading
    .trim()
    .replace(/[^\w]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned === '' ? `column_${position + 1}` : cleaned
}

/** A column type guessed in MySQL's words, as the server named by `dialect` writes it. */
export function typeFor(type: string, dialect: 'mysql' | 'postgresql' | 'mssql'): string {
  if (dialect === 'mysql') return type
  if (dialect === 'postgresql') {
    if (type === 'DOUBLE') return 'DOUBLE PRECISION'
    if (type === 'DATETIME') return 'TIMESTAMP'
    return type
  }
  if (type === 'DOUBLE') return 'FLOAT'
  if (type === 'DATETIME') return 'DATETIME2'
  if (type === 'TEXT') return 'NVARCHAR(MAX)'
  return type.replace(/^VARCHAR/, 'NVARCHAR')
}

/** Statements this size or smaller are written together, so a big file takes few round trips. */
export const IMPORT_BATCH_ROWS = 500
export const IMPORT_MAX_JSON_BYTES = 256 * 1024 * 1024
