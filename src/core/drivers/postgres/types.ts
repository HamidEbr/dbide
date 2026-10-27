import type { ColumnInfo } from '@shared/driver'
import type { Cell } from '@shared/query'

/** The parts of a PostgreSQL field description the driver reads. */
export interface PgField {
  name: string
  dataTypeID: number
  tableID: number
  columnID: number
}

/** Type OIDs written the way the grid knows them (the MySQL names for the same kinds of value). */
const TYPE_NAMES: Record<number, string> = {
  16: 'bool',
  17: 'bytea',
  18: 'char',
  20: 'bigint',
  21: 'smallint',
  23: 'int',
  25: 'text',
  26: 'oid',
  114: 'json',
  700: 'float',
  701: 'double',
  790: 'money',
  1042: 'char',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1266: 'timetz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
  142: 'xml',
  1000: 'bool[]',
  1007: 'int[]',
  1009: 'text[]',
  1015: 'varchar[]',
}

export function toColumnInfo(field: PgField, source: ColumnInfo['source']): ColumnInfo {
  return {
    name: field.name,
    type: TYPE_NAMES[field.dataTypeID] ?? 'text',
    ...(source ? { source, table: source.table } : {}),
  }
}

const hexToBytes = (value: string): Uint8Array => {
  // bytea comes as `\x` and hex digits.
  const hex = value.startsWith('\\x') ? value.slice(2) : value
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/**
 * How values arrive: as the text the server wrote, so no time zone shifts and no lost digits. Only booleans and
 * binary values are turned into something else.
 */
export const typeParsers = {
  getTypeParser(oid: number): (value: string) => unknown {
    if (oid === 16) return (value) => value === 't'
    if (oid === 17) return hexToBytes
    return (value) => value
  },
}

export function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
    return value
  if (value instanceof Uint8Array) return value
  if (value instanceof Date) return value.toISOString()
  return JSON.stringify(value)
}
