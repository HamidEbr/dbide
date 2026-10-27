import type { SqlDialect } from './dialect'
import type { Cell } from './query'

const INTEGER_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int'])
const NUMERIC_TYPES = new Set([
  ...INTEGER_TYPES,
  'bigint',
  'decimal',
  'numeric',
  'float',
  'real',
  'double',
  'money',
  'smallmoney',
  'year',
])
const BINARY_TYPES = new Set([
  'bit',
  'binary',
  'varbinary',
  'tinyblob',
  'blob',
  'mediumblob',
  'longblob',
  'geometry',
  'bytea',
  'image',
])

export const isNumericType = (type: string): boolean => NUMERIC_TYPES.has(type)
export const isBinaryType = (type: string): boolean => BINARY_TYPES.has(type)

export function toHex(bytes: Uint8Array, max = bytes.length): string {
  let hex = ''
  const end = Math.min(bytes.length, max)
  for (let i = 0; i < end; i++) hex += bytes[i]!.toString(16).padStart(2, '0')
  return hex
}

export function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Whether two values mean the same thing for a column. Numbers compare by value, so `1.50` and
 * `1.5` in a decimal column are the same, while `NULL` and an empty string are not.
 */
export function cellsEqual(a: Cell | undefined, b: Cell | undefined, type: string): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a === null || b === null) return a === b
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return a instanceof Uint8Array && b instanceof Uint8Array && bytesEqual(a, b)
  }
  if (a === b) return true
  if (isNumericType(type)) {
    const x = Number(a)
    const y = Number(b)
    // Long digit strings can't be compared as doubles without losing the difference.
    if (String(a).length > 15 || String(b).length > 15) return false
    return Number.isFinite(x) && Number.isFinite(y) && x === y
  }
  return false
}

export type ParseResult = { ok: true; value: Cell } | { ok: false; message: string }

const fail = (message: string): ParseResult => ({ ok: false, message })

const WHOLE_NUMBER = /^[+-]?\d+$/
const DECIMAL_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/
const TIME = /^-?\d{1,3}:\d{2}:\d{2}(\.\d{1,6})?$/

/**
 * Turns what someone typed into the value to store. It checks only what MySQL would reject
 * loudly or, worse, quietly mangle (a letter in a number, half a date). The server still has
 * the last word.
 */
export function parseEditInput(text: string, column: { type: string }): ParseResult {
  const type = column.type
  const trimmed = text.trim()

  if (INTEGER_TYPES.has(type)) {
    if (!WHOLE_NUMBER.test(trimmed)) return fail('Enter a whole number, or set NULL.')
    return { ok: true, value: Number(trimmed) }
  }
  if (type === 'bigint') {
    if (!WHOLE_NUMBER.test(trimmed)) return fail('Enter a whole number, or set NULL.')
    // Kept as text: bigints beyond 2^53 can't survive being a JavaScript number.
    return { ok: true, value: trimmed.replace(/^\+/, '') }
  }
  if (type === 'decimal') {
    if (!DECIMAL_NUMBER.test(trimmed)) return fail('Enter a number, or set NULL.')
    return { ok: true, value: trimmed.replace(/^\+/, '') }
  }
  if (type === 'float' || type === 'double') {
    const value = Number(trimmed)
    if (trimmed === '' || !Number.isFinite(value)) return fail('Enter a number, or set NULL.')
    return { ok: true, value }
  }
  if (type === 'year') {
    if (!/^\d{4}$/.test(trimmed)) return fail('Enter a four-digit year, or set NULL.')
    return { ok: true, value: Number(trimmed) }
  }
  if (type === 'date') {
    return DATE.test(trimmed) ? { ok: true, value: trimmed } : fail('Use the form 2026-03-01.')
  }
  if (type === 'datetime' || type === 'timestamp') {
    return DATETIME.test(trimmed)
      ? { ok: true, value: trimmed.replace('T', ' ') }
      : fail('Use the form 2026-03-01 12:30:00.')
  }
  if (type === 'time') {
    return TIME.test(trimmed) ? { ok: true, value: trimmed } : fail('Use the form 12:30:00.')
  }
  if (type === 'json') {
    try {
      JSON.parse(text)
      return { ok: true, value: text }
    } catch (error) {
      return fail(`That isn’t valid JSON. ${error instanceof Error ? error.message : ''}`.trim())
    }
  }
  if (isBinaryType(type)) {
    if (!/^0x/i.test(trimmed)) return fail('Binary values are entered as hex, like 0x1F2E.')
    const bytes = fromHex(trimmed.slice(2))
    return bytes
      ? { ok: true, value: bytes }
      : fail('That isn’t valid hex. Use pairs of digits, like 0x1F2E.')
  }
  return { ok: true, value: text }
}

/** The text to put in an editor for a value. */
export function cellToEditText(value: Cell | undefined): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Uint8Array) return `0x${toHex(value)}`
  return String(value)
}

/** A cell as a number for sums and averages: a number, or text in a numeric column that reads as one. */
export function numericValueOf(cell: Cell | undefined, type: string | undefined): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null
  if (typeof cell === 'string' && type && isNumericType(type)) {
    const parsed = Number(cell)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** What the numbers in a block of cells add up to. Merges with another block's totals. */
export interface NumberTotals {
  numeric: number
  sum: number
  min: number
  max: number
}

export const emptyTotals = (): NumberTotals => ({
  numeric: 0,
  sum: 0,
  min: Infinity,
  max: -Infinity,
})

export function addToTotals(totals: NumberTotals, n: number): void {
  totals.numeric++
  totals.sum += n
  if (n < totals.min) totals.min = n
  if (n > totals.max) totals.max = n
}

export function mergeTotals(a: NumberTotals, b: NumberTotals): NumberTotals {
  return {
    numeric: a.numeric + b.numeric,
    sum: a.sum + b.sum,
    min: Math.min(a.min, b.min),
    max: Math.max(a.max, b.max),
  }
}

const NUMBER_LITERAL = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/

/** A value as a SQL literal, for previews and for "copy as INSERT". */
export function sqlLiteral(
  cell: Cell | undefined,
  type?: string,
  dialect: SqlDialect = 'mysql',
): string {
  if (cell === null || cell === undefined) return 'NULL'
  if (cell instanceof Uint8Array) {
    if (cell.length === 0) return dialect === 'postgresql' ? "''::bytea" : "''"
    return dialect === 'postgresql' ? `'\\x${toHex(cell)}'::bytea` : `0x${toHex(cell)}`
  }
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : 'NULL'
  if (typeof cell === 'boolean') {
    return dialect === 'postgresql' ? (cell ? 'TRUE' : 'FALSE') : cell ? '1' : '0'
  }
  if (type && isNumericType(type) && NUMBER_LITERAL.test(cell)) return cell
  // MySQL reads a backslash as an escape; PostgreSQL and SQL Server do not.
  const escaped =
    dialect === 'mysql' ? cell.replace(/\\/g, '\\\\').replace(/'/g, "''") : cell.replace(/'/g, "''")
  // SQL Server needs the N prefix to keep characters outside the server's code page.
  return `${dialect === 'mssql' ? 'N' : ''}'${escaped}'`
}
