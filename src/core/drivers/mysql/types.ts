import type { ColumnInfo } from '@shared/driver'

/** The parts of a mysql2 column definition the driver reads. */
export interface MysqlField {
  name: string
  columnType: number
  characterSet: number
  flags: number
  /** The table as the query named it (an alias if it has one). */
  table?: string
  /** The real schema, table, and column. Empty for expressions and aggregates. */
  schema?: string
  orgTable?: string
  orgName?: string
}

const NOT_NULL = 1
const BINARY_CHARSET = 63

const BASE_TYPES: Record<number, string> = {
  0x00: 'decimal',
  0x01: 'tinyint',
  0x02: 'smallint',
  0x03: 'int',
  0x04: 'float',
  0x05: 'double',
  0x06: 'null',
  0x07: 'timestamp',
  0x08: 'bigint',
  0x09: 'mediumint',
  0x0a: 'date',
  0x0b: 'time',
  0x0c: 'datetime',
  0x0d: 'year',
  0x0e: 'date',
  0x0f: 'varchar',
  0x10: 'bit',
  0xf2: 'vector',
  0xf5: 'json',
  0xf6: 'decimal',
  0xf7: 'enum',
  0xf8: 'set',
  0xff: 'geometry',
}

/** Text and binary share wire types; the character set tells them apart. */
const STRING_TYPES: Record<number, { text: string; binary: string }> = {
  0xf9: { text: 'tinytext', binary: 'tinyblob' },
  0xfa: { text: 'mediumtext', binary: 'mediumblob' },
  0xfb: { text: 'longtext', binary: 'longblob' },
  0xfc: { text: 'text', binary: 'blob' },
  0xfd: { text: 'varchar', binary: 'varbinary' },
  0xfe: { text: 'char', binary: 'binary' },
}

export function columnTypeName(field: MysqlField): string {
  const string = STRING_TYPES[field.columnType]
  if (string) return field.characterSet === BINARY_CHARSET ? string.binary : string.text
  return BASE_TYPES[field.columnType] ?? `type ${field.columnType}`
}

export function toColumnInfo(field: MysqlField): ColumnInfo {
  return {
    name: field.name,
    type: columnTypeName(field),
    nullable: (field.flags & NOT_NULL) === 0,
    ...(field.table ? { table: field.table } : {}),
    ...(field.schema && field.orgTable && field.orgName
      ? { source: { schema: field.schema, table: field.orgTable, column: field.orgName } }
      : {}),
  }
}

/**
 * A value as it travels to the window. Binary values become compact `Uint8Array`s, because a
 * Buffer can be a view into a large shared slab and structured clone would copy the whole slab.
 */
export function toCell(value: unknown): unknown {
  if (value instanceof Uint8Array) return Uint8Array.from(value)
  return value
}
