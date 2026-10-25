import type { ColumnInfo } from '@shared/driver'
import type { Cell } from '@shared/query'
import { isNumericType, toHex } from '@shared/value'

export { isNumericType, toHex } from '@shared/value'

const DATE_TYPES = new Set(['date', 'datetime', 'timestamp', 'time'])

export type CellKind = 'null' | 'empty' | 'number' | 'text' | 'binary'

export interface DisplayCell {
  text: string
  kind: CellKind
}

const MAX_DISPLAY_CHARS = 300
const PREVIEW_BYTES = 16

/** What the grid shows for a value. Long text is cut for display only; copy keeps all of it. */
export function displayCell(value: Cell, column: ColumnInfo): DisplayCell {
  if (value === null) return { text: 'NULL', kind: 'null' }
  if (value instanceof Uint8Array) {
    const more = value.length > PREVIEW_BYTES
    return {
      text: `0x${toHex(value, PREVIEW_BYTES)}${more ? `… (${value.length} bytes)` : ''}`,
      kind: 'binary',
    }
  }
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', kind: 'text' }
  if (typeof value === 'number') return { text: String(value), kind: 'number' }
  if (value === '') return { text: '""', kind: 'empty' }

  const kind: CellKind = isNumericType(column.type) ? 'number' : 'text'
  return {
    text: value.length > MAX_DISPLAY_CHARS ? `${value.slice(0, MAX_DISPLAY_CHARS)}…` : value,
    kind,
  }
}

/** The full value as plain text, for copying. NULL becomes empty so it pastes as an empty cell. */
export function copyText(value: Cell): string {
  if (value === null) return ''
  if (value instanceof Uint8Array) return `0x${toHex(value)}`
  return String(value)
}

/** A starting column width in pixels from the header and a sample of the data. */
export function columnWidth(column: ColumnInfo, sample: Cell[][], index: number): number {
  const CHAR = 7.6
  // The header shows the name and the type side by side.
  let longest = column.name.length + column.type.length + 3
  for (const row of sample) {
    const value = row[index]
    const length =
      value === null || value === undefined
        ? 4
        : value instanceof Uint8Array
          ? Math.min(2 + PREVIEW_BYTES * 2, 2 + value.length * 2)
          : Math.min(String(value).length, 60)
    if (length > longest) longest = length
  }
  const floor = isNumericType(column.type) ? 72 : DATE_TYPES.has(column.type) ? 140 : 88
  return Math.round(Math.min(360, Math.max(floor, longest * CHAR + 24)))
}
