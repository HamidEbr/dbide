import { dialectInfo, type SqlDialect } from './dialect'
import type { SchemaForeignKey } from './driver'
import { sqlLiteral } from './value'

/**
 * A SELECT put together from choices instead of typed: which tables, how they join, which columns, which rows,
 * in what order. The model is plain data; `buildSql` writes it for a server's SQL.
 */

export type JoinType = 'INNER' | 'LEFT' | 'RIGHT'
export type Aggregate = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'

export interface BuilderTable {
  /** Names the table in the statement, so the same table can appear twice. */
  alias: string
  schema: string
  table: string
  /** How this table joins the ones before it. Missing for the first. */
  join?: {
    type: JoinType
    on: { alias: string; column: string; otherAlias: string; otherColumn: string }[]
  }
}

export interface BuilderColumn {
  alias: string
  column: string
  aggregate?: Aggregate
  /** The heading of the column in the result. */
  as?: string
}

export type FilterOperator =
  '=' | '<>' | '<' | '>' | '<=' | '>=' | 'LIKE' | 'IN' | 'BETWEEN' | 'IS NULL' | 'IS NOT NULL'

export interface BuilderFilter {
  alias: string
  column: string
  operator: FilterOperator
  /** For IN, values separated by commas. For BETWEEN, two values separated by a comma. */
  value: string
  /** `text` and `number` are written in as literals; `parameter` writes `:value` for the script to ask for. */
  kind: 'text' | 'number' | 'parameter'
  /** How it joins the filter before it. */
  logic: 'AND' | 'OR'
}

export interface Builder {
  tables: BuilderTable[]
  columns: BuilderColumn[]
  filters: BuilderFilter[]
  orderBy: { alias: string; column: string; direction: 'ASC' | 'DESC' }[]
  limit: number | null
  distinct: boolean
}

export const emptyBuilder = (): Builder => ({
  tables: [],
  columns: [],
  filters: [],
  orderBy: [],
  limit: 100,
  distinct: false,
})

export const FILTER_OPERATORS: readonly FilterOperator[] = [
  '=',
  '<>',
  '<',
  '>',
  '<=',
  '>=',
  'LIKE',
  'IN',
  'BETWEEN',
  'IS NULL',
  'IS NOT NULL',
]

/** An alias for a table that is not already taken: the initials, then a number. */
export function aliasFor(table: string, taken: readonly string[]): string {
  const initials = table
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toLowerCase())
    .join('')
  const base = /^[a-z]/.test(initials) ? initials : `t${initials}`
  const lower = new Set(taken.map((t) => t.toLowerCase()))
  if (!lower.has(base)) return base
  for (let n = 2; ; n++) if (!lower.has(`${base}${n}`)) return `${base}${n}`
}

/** The join a foreign key suggests between a table being added and the ones already there. */
export function suggestJoin(
  next: { alias: string; schema: string; table: string },
  existing: readonly BuilderTable[],
  keys: readonly SchemaForeignKey[],
): BuilderTable['join'] | undefined {
  for (const other of existing) {
    for (const k of keys) {
      const sameSchema = (s: string, o: string): boolean => s.toLowerCase() === o.toLowerCase()
      // The new table holds the key, or the table already there holds it.
      if (
        k.table.toLowerCase() === next.table.toLowerCase() &&
        k.refTable.toLowerCase() === other.table.toLowerCase() &&
        sameSchema(k.refSchema, other.schema)
      ) {
        return {
          type: 'INNER',
          on: [
            {
              alias: next.alias,
              column: k.column,
              otherAlias: other.alias,
              otherColumn: k.refColumn,
            },
          ],
        }
      }
      if (
        k.table.toLowerCase() === other.table.toLowerCase() &&
        k.refTable.toLowerCase() === next.table.toLowerCase() &&
        sameSchema(k.refSchema, next.schema)
      ) {
        return {
          type: 'INNER',
          on: [
            {
              alias: next.alias,
              column: k.refColumn,
              otherAlias: other.alias,
              otherColumn: k.column,
            },
          ],
        }
      }
    }
  }
  return undefined
}

const NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/

function literal(
  value: string,
  kind: BuilderFilter['kind'],
  dialect: SqlDialect,
  name: string,
): string {
  if (kind === 'parameter') return `:${value.trim() || name}`
  const v = value.trim()
  if (kind === 'number' && NUMBER.test(v)) return v
  return sqlLiteral(value, undefined, dialect)
}

function filterSql(f: BuilderFilter, q: (n: string) => string, dialect: SqlDialect): string {
  const left = `${q(f.alias)}.${q(f.column)}`
  if (f.operator === 'IS NULL' || f.operator === 'IS NOT NULL') return `${left} ${f.operator}`
  if (f.operator === 'IN') {
    const parts =
      f.kind === 'parameter'
        ? [f.value]
        : f.value
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean)
    return `${left} IN (${parts.map((p) => literal(p, f.kind, dialect, f.column)).join(', ')})`
  }
  if (f.operator === 'BETWEEN') {
    const [a = '', b = ''] = f.value.split(',').map((p) => p.trim())
    return `${left} BETWEEN ${literal(a, f.kind, dialect, `${f.column}_from`)} AND ${literal(b, f.kind, dialect, `${f.column}_to`)}`
  }
  return `${left} ${f.operator} ${literal(f.value, f.kind, dialect, f.column)}`
}

/** The SELECT, or null while there is nothing to select from. */
export function buildSql(builder: Builder, dialect: SqlDialect): string | null {
  const [first, ...rest] = builder.tables
  if (!first) return null
  const info = dialectInfo(dialect)
  const q = info.quote
  const from = (t: BuilderTable): string => `${info.qualified(t.schema, t.table)} ${q(t.alias)}`

  const aggregated = builder.columns.some((c) => c.aggregate)
  const select = builder.columns.length
    ? builder.columns.map((c) => {
        const ref = `${q(c.alias)}.${q(c.column)}`
        const expr = c.aggregate ? `${c.aggregate}(${ref})` : ref
        return c.as ? `${expr} AS ${q(c.as)}` : expr
      })
    : [builder.tables.length > 1 ? `${q(first.alias)}.*` : '*']

  const top = dialect === 'mssql' && builder.limit !== null ? `TOP (${builder.limit}) ` : ''
  const lines = [
    `SELECT ${builder.distinct ? 'DISTINCT ' : ''}${top}${select.join(',\n       ')}`,
    `FROM ${from(first)}`,
  ]
  for (const t of rest) {
    const on = (t.join?.on ?? []).map(
      (o) => `${q(o.alias)}.${q(o.column)} = ${q(o.otherAlias)}.${q(o.otherColumn)}`,
    )
    lines.push(
      `${t.join?.type ?? 'INNER'} JOIN ${from(t)}${on.length ? ` ON ${on.join(' AND ')}` : ''}`,
    )
  }
  if (builder.filters.length > 0) {
    const parts = builder.filters.map(
      (f, i) => `${i === 0 ? '' : `${f.logic} `}${filterSql(f, q, dialect)}`,
    )
    lines.push(`WHERE ${parts.join('\n  ')}`)
  }
  if (aggregated) {
    const plain = builder.columns.filter((c) => !c.aggregate)
    if (plain.length > 0)
      lines.push(`GROUP BY ${plain.map((c) => `${q(c.alias)}.${q(c.column)}`).join(', ')}`)
  }
  if (builder.orderBy.length > 0) {
    lines.push(
      `ORDER BY ${builder.orderBy.map((o) => `${q(o.alias)}.${q(o.column)} ${o.direction}`).join(', ')}`,
    )
  }
  if (builder.limit !== null && dialect !== 'mssql') lines.push(`LIMIT ${builder.limit}`)
  return `${lines.join('\n')};`
}
