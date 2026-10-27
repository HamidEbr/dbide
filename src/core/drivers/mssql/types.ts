import type { ColumnInfo } from '@shared/driver'
import type { Cell } from '@shared/query'

/** SQL Server type names written the way the grid knows them. */
const NAMES: Record<string, string> = {
  tinyint: 'tinyint',
  smallint: 'smallint',
  int: 'int',
  bigint: 'bigint',
  bit: 'bool',
  decimal: 'decimal',
  numeric: 'numeric',
  money: 'money',
  smallmoney: 'smallmoney',
  float: 'double',
  real: 'float',
  char: 'char',
  nchar: 'char',
  varchar: 'varchar',
  nvarchar: 'varchar',
  text: 'text',
  ntext: 'text',
  binary: 'binary',
  varbinary: 'varbinary',
  image: 'image',
  date: 'date',
  time: 'time',
  datetime: 'datetime',
  datetime2: 'datetime',
  smalldatetime: 'datetime',
  datetimeoffset: 'timestamptz',
  uniqueidentifier: 'uuid',
  xml: 'xml',
}

export interface MssqlColumn {
  index: number
  name: string
  type: (() => { declaration?: string }) | { declaration?: string }
  nullable?: boolean
}

export const declarationOf = (column: MssqlColumn): string => {
  const type = typeof column.type === 'function' ? column.type() : column.type
  return String(type?.declaration ?? 'varchar').toLowerCase()
}

export function toColumnInfo(column: MssqlColumn): ColumnInfo {
  const declaration = declarationOf(column)
  return {
    name: column.name,
    type: NAMES[declaration] ?? declaration,
    ...(column.nullable === undefined ? {} : { nullable: column.nullable }),
  }
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** A value as the grid holds it. Dates are written the way the server prints them, in UTC, with no zone shift. */
export function toCell(value: unknown, declaration: string): Cell {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    const iso = value.toISOString()
    if (declaration === 'date') return iso.slice(0, 10)
    if (declaration === 'time') return iso.slice(11, 23)
    if (declaration === 'datetimeoffset') return iso
    return `${iso.slice(0, 10)} ${iso.slice(11, 23)}`
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (typeof value === 'bigint') return String(value)
  return JSON.stringify(value)
}

/** A column type as SQL Server writes it, from the catalog's own numbers. */
export function formatType(
  name: string,
  maxLength: number,
  precision: number,
  scale: number,
): string {
  const type = name.toLowerCase()
  switch (type) {
    case 'varchar':
    case 'char':
    case 'varbinary':
    case 'binary':
      return `${type}(${maxLength === -1 ? 'max' : maxLength})`
    case 'nvarchar':
    case 'nchar':
      return `${type}(${maxLength === -1 ? 'max' : maxLength / 2})`
    case 'decimal':
    case 'numeric':
      return `${type}(${precision},${scale})`
    case 'datetime2':
    case 'datetimeoffset':
    case 'time':
      return `${type}(${scale})`
    default:
      return type
  }
}

export { pad }
